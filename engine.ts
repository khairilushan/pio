import { access, readFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import {
	createAgentSession,
	DefaultResourceLoader,
	defineTool,
	getAgentDir,
	loadProjectContextFiles,
	SessionManager,
	SettingsManager,
	type ExtensionAPI,
	type ExtensionContext,
	type AgentSessionEvent,
} from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { ClaudeCodeRun } from "./claude-code.ts";
import { defaultModelFor, loadPioConfig } from "./config.ts";
import { dedupeFindings, findingBatches, normalizePlan, normalizeReview } from "./pipeline.ts";
import {
	contextPrompt,
	contextSystemPrompt,
	correctnessReviewPrompt,
	criticPrompt,
	criticSystemPrompt,
	fixerPrompt,
	fixerSystemPrompt,
	planPrompt,
	plannerSystemPrompt,
	resilienceReviewPrompt,
	reviewerSystemPrompt,
	revisePlanPrompt,
	simplicityReviewPrompt,
	triagePrompt,
	verifierPrompt,
	verifierSystemPrompt,
	writerPrompt,
	writerSystemPrompt,
} from "./prompts.ts";
import type {
	Activity,
	AgentRecord,
	AgentRequest,
	ApprovedPlan,
	ImplementationReceipt,
	PioConfigInput,
	PioPhase,
	PioRole,
	PioSnapshot,
	ReviewFinding,
	RunState,
} from "./types.ts";

const PHASES: Record<PioPhase, string> = {
	1: "Establish task state",
	2: "Gather isolated context",
	3: "Produce implementation plan",
	4: "Criticize and approve plan",
	5: "Implement sequential work items",
	6: "Review and fix",
	7: "Final inspection and report",
};

const RETAINED_ACTIVITY_LIMIT = 2_000;
const MAX_DETAIL_CHARS = 12_000;
const MAX_FIX_ROUNDS = 3;
const READ_ONLY_TOOLS = ["read", "grep", "find", "ls", "bash", "pio_progress"];
const WRITER_TOOLS = ["read", "grep", "find", "ls", "bash", "edit", "write", "pio_progress"];

interface CriticResult {
	disposition: "accepted" | "revise" | "blocked";
	corrections: string[];
	questions: string[];
	summary: string;
}

interface ActivityEntryData extends Activity {
	role?: string;
}

function id(prefix: string): string {
	return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

function clip(value: string, limit = MAX_DETAIL_CHARS): string {
	if (value.length <= limit) return value;
	return `${value.slice(0, limit)}\n… ${value.length - limit} characters omitted`;
}

function oneLine(value: string, limit = 180): string {
	const line = value.replace(/\s+/g, " ").trim();
	return line.length <= limit ? line : `${line.slice(0, limit - 1)}…`;
}

function safeDetails(value: unknown): unknown {
	const seen = new WeakSet<object>();
	const json = JSON.stringify(
		value,
		(key, item) => {
			if (/password|secret|token|api.?key|authorization|cookie/i.test(key)) return "[redacted]";
			if (typeof item === "object" && item !== null) {
				if (seen.has(item)) return "[circular]";
				seen.add(item);
			}
			return item;
		},
		2,
	);
	if (!json) return undefined;
	return clip(json);
}

function assistantText(message: any): string {
	if (message?.role !== "assistant" || !Array.isArray(message.content)) return "";
	return message.content
		.filter((part: any) => part?.type === "text" && typeof part.text === "string")
		.map((part: any) => part.text)
		.join("\n")
		.trim();
}

function toolActivity(name: string, args: unknown): string {
	const input = args && typeof args === "object" ? args as Record<string, unknown> : {};
	const path = String(input.path ?? input.filePath ?? input.file_path ?? "");
	switch (name.toLowerCase()) {
		case "read": {
			const offset = typeof input.offset === "number" ? input.offset : 1;
			const limit = typeof input.limit === "number" ? input.limit : undefined;
			return `read ${path || "…"}${limit ? `:${offset}-${offset + limit - 1}` : ""}`;
		}
		case "bash":
			return `$ ${oneLine(String(input.command ?? "…"), 160)}`;
		case "grep":
			return `grep /${oneLine(String(input.pattern ?? "…"), 80)}/ in ${path || "."}`;
		case "find":
		case "glob":
			return `${name.toLowerCase()} ${oneLine(String(input.pattern ?? "*"), 80)} in ${path || "."}`;
		case "edit":
			return `edit ${path || "…"}`;
		case "write":
			return `write ${path || "…"}`;
		default:
			return path ? `${name} ${path}` : name;
	}
}

function parseJson<T>(text: string): T {
	const trimmed = text.trim();
	const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim();
	const candidate = fenced ?? trimmed;
	try {
		return JSON.parse(candidate) as T;
	} catch {
		const start = candidate.indexOf("{");
		const end = candidate.lastIndexOf("}");
		if (start >= 0 && end > start) return JSON.parse(candidate.slice(start, end + 1)) as T;
		throw new Error("Agent did not return valid JSON");
	}
}

function normalizeCritic(value: any): CriticResult {
	if (!value || !["accepted", "revise", "blocked"].includes(value.disposition)) {
		throw new Error("Critic response has an invalid disposition");
	}
	return {
		disposition: value.disposition,
		corrections: Array.isArray(value.corrections) ? value.corrections.map(String) : [],
		questions: Array.isArray(value.questions) ? value.questions.map(String) : [],
		summary: typeof value.summary === "string" ? value.summary : "",
	};
}

function normalizeReceipt(value: any, workItem: string): ImplementationReceipt {
	const validation = Array.isArray(value?.validation)
		? value.validation.map((entry: any) => ({
				check: String(entry?.check ?? "unspecified check"),
				outcome: ["passed", "failed", "skipped"].includes(entry?.outcome) ? entry.outcome : "skipped",
				reason: typeof entry?.reason === "string" ? entry.reason : undefined,
			}))
		: [];
	const concerns = Array.isArray(value?.concerns) ? value.concerns.map(String) : [];
	if (validation.length === 0) {
		validation.push({
			check: "Focused validation",
			outcome: "skipped",
			reason: "The agent returned no validation metadata; correctness remains unverified.",
		});
		concerns.push("The implementation receipt omitted validation metadata; focused validation is still required.");
	}
	return {
		workItem: typeof value?.workItem === "string" ? value.workItem : workItem,
		changedPaths: Array.isArray(value?.changedPaths) ? value.changedPaths.map(String) : [],
		decisions: Array.isArray(value?.decisions) ? value.decisions.map(String) : [],
		validation,
		concerns,
	};
}

function isTransientFailure(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	return /capacity|overloaded|rate.?limit|timeout|timed out|connection|socket|network|temporar|503|529/i.test(message);
}

function findingLocation(path?: string, line?: number): string {
	return path ? ` (${path}${line ? `:${line}` : ""})` : "";
}

function finalReport(run: RunState): string {
	const plan = run.plan!;
	const lines = ["# PIO final report", "", "## Final revised plan", "", `**Objective:** ${plan.objective}`, ""];
	for (const [index, item] of plan.workItems.entries()) {
		lines.push(`${index + 1}. **${item.title}**`);
		lines.push(`   ${oneLine(item.description, 260)}`);
	}

	lines.push("", "## Review findings", "");
	const fixed = run.trackedFindings.filter((item) => item.status === "fixed").length;
	const notConfirmed = run.trackedFindings.filter((item) => item.status === "not-confirmed").length;
	const unresolved = run.trackedFindings.filter((item) => item.status === "unresolved").length;
	if (run.trackedFindings.length === 0) {
		lines.push("**Must-fixes:** None reported.");
	} else {
		const resolution = unresolved === 0
			? "All verified must-fixes were fixed."
			: `${unresolved} must-fix${unresolved === 1 ? " remains" : "es remain"} unresolved.`;
		lines.push(`**Must-fixes:** ${fixed} fixed, ${notConfirmed} not confirmed during triage, ${unresolved} unresolved. ${resolution}`, "");
		for (const item of run.trackedFindings) {
			const status = item.status === "fixed" && item.fixedRound ? `fixed in round ${item.fixedRound}` : item.status.replace("-", " ");
			const followUp = item.status === "unresolved" ? ` Next: ${oneLine(item.finding.direction, 160)}` : "";
			lines.push(`- **${status.toUpperCase()}** — ${item.finding.title}${findingLocation(item.finding.path, item.finding.line)}.${followUp}`);
		}
	}

	const suggestions = new Map<string, { title: string; path?: string; reason: string }>();
	const questions = new Set<string>();
	for (const review of run.reviews) {
		for (const suggestion of review.result.suggestions) {
			const key = `${suggestion.title.toLowerCase()}|${suggestion.path ?? ""}`;
			if (!suggestions.has(key)) suggestions.set(key, suggestion);
		}
		for (const question of review.result.questions) if (question.trim()) questions.add(question.trim());
	}
	lines.push("", "**Suggestions:**");
	if (suggestions.size === 0) lines.push("- None.");
	else for (const suggestion of suggestions.values()) lines.push(`- ${suggestion.title}${findingLocation(suggestion.path)} — ${oneLine(suggestion.reason, 180)}`);
	lines.push("", "**Open questions:**");
	if (questions.size === 0) lines.push("- None.");
	else for (const question of questions) lines.push(`- ${question}`);

	lines.push("", "## Important notes", "");
	const changedPaths = [...new Set(run.receipts.flatMap((receipt) => receipt.changedPaths).filter(Boolean))];
	const decisions = [...new Set(run.receipts.flatMap((receipt) => receipt.decisions).filter(Boolean))];
	lines.push(`- Scope: ${changedPaths.length} changed path${changedPaths.length === 1 ? "" : "s"}; ${decisions.length} implementation decision${decisions.length === 1 ? "" : "s"} recorded.`);
	const validations = run.receipts.flatMap((receipt) => receipt.validation);
	const uniqueValidations = [...new Map(validations.map((item) => [`${item.outcome}|${item.check.toLowerCase()}|${item.reason ?? ""}`, item])).values()];
	const passed = uniqueValidations.filter((item) => item.outcome === "passed").length;
	const failedValidations = uniqueValidations.filter((item) => item.outcome === "failed");
	const skippedValidations = uniqueValidations.filter((item) => item.outcome === "skipped");
	lines.push(`- Validation: ${passed} passed, ${failedValidations.length} failed, ${skippedValidations.length} skipped.`);
	for (const item of failedValidations) lines.push(`- **Failed:** ${oneLine(item.check, 140)}${item.reason ? ` — ${oneLine(item.reason, 180)}` : ""}`);
	const specificSkips = skippedValidations.filter((item) => item.check.toLowerCase() !== "unspecified check");
	for (const item of specificSkips) lines.push(`- **Skipped:** ${oneLine(item.check, 140)}${item.reason ? ` — ${oneLine(item.reason, 180)}` : ""}`);
	if (skippedValidations.some((item) => item.check.toLowerCase() === "unspecified check")) lines.push("- Some skipped validation was reported without details.");
	const concerns = [...new Set(run.receipts.flatMap((receipt) => receipt.concerns).filter(Boolean))];
	for (const concern of concerns) lines.push(`- **Concern:** ${oneLine(concern, 220)}`);
	for (const fallback of run.modelFallbacks) lines.push(`- **Runtime fallback:** ${oneLine(fallback, 220)}`);
	if (unresolved > 0) lines.push("- **Action required:** Review unresolved must-fixes before merging.");
	if (failedValidations.length === 0 && skippedValidations.length === 0 && concerns.length === 0 && unresolved === 0 && run.modelFallbacks.length === 0) {
		lines.push("- No additional blockers or caveats were reported.");
	}
	return lines.join("\n");
}

export class PioEngine {
	private readonly runs = new Map<string, RunState>();
	private currentRunId?: string;
	private render?: () => void;
	private ui?: ExtensionContext["ui"];

	constructor(private readonly pi: ExtensionAPI) {}

	attachUI(ctx: ExtensionContext, render?: () => void): void {
		this.ui = ctx.ui;
		if (render) this.render = render;
		this.refreshUI();
	}

	get currentRun(): RunState | undefined {
		return this.currentRunId ? this.runs.get(this.currentRunId) : undefined;
	}

	getRun(runId?: string): RunState | undefined {
		return runId ? this.runs.get(runId) : this.currentRun;
	}

	listRuns(): RunState[] {
		return [...this.runs.values()].sort((a, b) => b.startedAt - a.startedAt);
	}

	async start(task: string, ctx: ExtensionContext, configOverride?: PioConfigInput): Promise<RunState> {
		const active = this.listRuns().find((run) => run.status === "running" || run.status === "paused");
		if (active) throw new Error(`PIO run ${active.id} is still ${active.status}. Abort or finish it first.`);
		if (!task.trim()) throw new Error("PIO requires a concrete task description or task source.");

		this.attachUI(ctx);
		const loadedConfig = await loadPioConfig(ctx.cwd, ctx.isProjectTrusted(), configOverride);
		const run: RunState = {
			id: id("pio"),
			task: task.trim(),
			cwd: ctx.cwd,
			phase: 1,
			phaseLabel: PHASES[1],
			status: "running",
			startedAt: Date.now(),
			baseline: "",
			instructionPaths: [],
			requiredDocumentPaths: [],
			agents: [],
			activities: [],
			droppedActivityCount: 0,
			receipts: [],
			reviews: [],
			trackedFindings: [],
			unresolvedFindings: [],
			abortController: new AbortController(),
			modelFallbacks: [],
			config: loadedConfig.config,
			configSources: loadedConfig.sources,
		};
		this.runs.set(run.id, run);
		this.currentRunId = run.id;
		this.activity(run, undefined, "phase", `Phase 1/7 — ${PHASES[1]}`, { task: run.task });
		run.baseline = await this.inspectBaseline(run);
		this.refreshUI();

		void this.runPipeline(run, ctx).catch((error) => this.failRun(run, error));
		return run;
	}

	async steer(message: string, agentId?: string, runId?: string): Promise<AgentRecord> {
		const run = this.requireRun(runId);
		const running = run.agents.filter((agent) => agent.status === "running" && agent.control);
		const selector = agentId?.trim().toLowerCase();
		const agent = selector
			? running.find((candidate) =>
				candidate.id.toLowerCase() === selector ||
				candidate.role.toLowerCase() === selector ||
				candidate.label.toLowerCase() === selector,
			)
			: running.length === 1 ? running[0] : undefined;
		if (!agent?.control) {
			const names = running.map((candidate) => `${candidate.role} — ${candidate.label}`).join(", ") || "none";
			throw new Error(`Select one running agent by role. Active agents: ${names}`);
		}
		if (!message.trim()) throw new Error("Steering message cannot be empty.");
		await agent.control.steer(message.trim());
		agent.lastActivity = `Steering queued: ${oneLine(message)}`;
		this.activity(run, agent, "steer", agent.lastActivity, { message: message.trim() });
		return agent;
	}

	answer(message: string, runId?: string): void {
		const run = this.requireRun(runId);
		if (!run.pendingDecision) throw new Error("This PIO run is not waiting for a decision.");
		const pending = run.pendingDecision;
		run.pendingDecision = undefined;
		run.status = "running";
		this.activity(run, undefined, "decision", `Decision received: ${oneLine(message)}`, { answer: message });
		pending.resolve(message.trim());
		this.refreshUI();
	}

	async abort(runId?: string): Promise<void> {
		const run = this.requireRun(runId);
		if (["completed", "failed", "aborted"].includes(run.status)) return;
		run.status = "aborted";
		run.endedAt = Date.now();
		run.abortController.abort();
		if (run.pendingDecision) {
			run.pendingDecision.resolve("__PIO_ABORTED__");
			run.pendingDecision = undefined;
		}
		await Promise.allSettled(
			run.agents.filter((agent) => agent.control).map(async (agent) => {
				agent.status = "aborted";
				await agent.control?.abort();
			}),
		);
		this.activity(run, undefined, "error", "PIO run aborted by user");
		this.refreshUI();
	}

	report(runId?: string): string {
		const run = this.requireRun(runId);
		if (!run.finalReport) throw new Error("The final report is available after PIO completes.");
		return run.finalReport;
	}

	snapshot(runId?: string): PioSnapshot {
		const run = this.requireRun(runId);
		return {
			runId: run.id,
			status: run.status,
			phase: run.phase,
			phaseLabel: run.phaseLabel,
			task: run.task,
			activeAgents: run.agents
				.filter((agent) => agent.status === "running")
				.map((agent) => ({
					id: agent.id,
					role: agent.role,
					focus: agent.focus,
					backend: agent.backend,
					model: agent.model,
					effort: agent.effort,
					lastActivity: agent.lastActivity,
				})),
			completedAgents: run.agents.filter((agent) => agent.status === "completed").length,
			totalAgents: run.agents.length,
			pendingQuestion: run.pendingDecision?.question,
			summary: run.summary,
			error: run.error,
		};
	}

	private requireRun(runId?: string): RunState {
		const run = this.getRun(runId);
		if (!run) throw new Error(runId ? `Unknown PIO run: ${runId}` : "No PIO run exists in this session.");
		return run;
	}

	private async runPipeline(run: RunState, ctx: ExtensionContext): Promise<void> {
		this.ensureRunning(run);
		this.setPhase(run, 2);
		const context = await this.runAgentWithRetry(run, ctx, {
			role: "context",
			label: "Repository context",
			tier: "fast",
			focus: "Locating ownership boundaries, consumers, tests, and repository constraints",
			systemPrompt: contextSystemPrompt(),
			prompt: contextPrompt(run.task, run.baseline),
			tools: READ_ONLY_TOOLS,
		});
		if (context.startsWith("BLOCKED:")) {
			const answer = await this.waitForDecision(run, context.slice("BLOCKED:".length).trim());
			this.ensureRunning(run);
			run.context = await this.runAgentWithRetry(run, ctx, {
				role: "context",
				label: "Repository context after clarification",
				tier: "fast",
				focus: "Completing repository context with the supplied clarification",
				systemPrompt: contextSystemPrompt(),
				prompt: `${contextPrompt(run.task, run.baseline)}\n\nClarification/access information:\n${answer}`,
				tools: READ_ONLY_TOOLS,
			});
		} else {
			run.context = context;
		}

		this.setPhase(run, 3);
		run.plan = await this.obtainPlan(run, ctx);

		this.setPhase(run, 4);
		run.plan = await this.approvePlan(run, ctx, run.plan);

		this.setPhase(run, 5);
		for (let index = 0; index < run.plan.workItems.length; index++) {
			this.ensureRunning(run);
			const item = run.plan.workItems[index];
			const dependencyIds = new Set(item.dependencies ?? []);
			const dependencyReceipts = run.receipts.filter((receipt) => dependencyIds.has(receipt.workItem));
			const output = await this.runAgentWithRetry(run, ctx, {
				role: "writer",
				label: `${item.id}: ${item.title}`,
				tier: "capable",
				focus: item.title,
				systemPrompt: writerSystemPrompt(),
				prompt: writerPrompt(run.task, run.plan, item, run.baseline, dependencyReceipts, index === run.plan.workItems.length - 1),
				tools: WRITER_TOOLS,
			});
			const receipt = normalizeReceipt(parseJson(output), item.id);
			run.receipts.push(receipt);
			this.activity(run, undefined, "complete", `Writer completed ${item.id}: ${item.title}`, receipt);
			await this.inspectAfterWrite(run, item.id);
		}

		this.setPhase(run, 6);
		await this.reviewAndFix(run, ctx);

		this.setPhase(run, 7);
		await this.inspectAfterWrite(run, "final");
		this.assertCompletionGate(run);
		this.completeRun(run);
	}

	private async obtainPlan(run: RunState, ctx: ExtensionContext): Promise<ApprovedPlan> {
		let lastError: unknown;
		for (let attempt = 1; attempt <= 2; attempt++) {
			const output = await this.runAgentWithRetry(run, ctx, {
				role: "planner",
				label: attempt === 1 ? "Implementation plan" : "Implementation plan retry",
				tier: "reasoning",
				focus: "Converting repository evidence into cohesive work items",
				systemPrompt: plannerSystemPrompt(),
				prompt: planPrompt(run.task, run.baseline, run.context ?? ""),
				tools: READ_ONLY_TOOLS,
			});
			try {
				return normalizePlan(parseJson(output));
			} catch (error) {
				lastError = error;
				this.activity(run, undefined, "error", `Planner response malformed; ${attempt === 1 ? "retrying once" : "retry exhausted"}`, String(error));
			}
		}
		throw lastError;
	}

	private async approvePlan(run: RunState, ctx: ExtensionContext, initialPlan: ApprovedPlan): Promise<ApprovedPlan> {
		let plan = initialPlan;
		let critic = await this.obtainCritic(run, ctx, plan);
		if (critic.disposition === "blocked") {
			const question = critic.questions[0] || critic.summary || "The plan critic needs a material implementation decision.";
			const answer = await this.waitForDecision(run, question);
			this.ensureRunning(run);
			critic = await this.obtainCritic(run, ctx, plan, answer);
		}
		if (critic.disposition === "accepted") {
			plan.approvalBasis = "critic-accepted";
			return plan;
		}
		if (critic.disposition !== "revise") throw new Error("Plan remains blocked after clarification.");

		const revisedOutput = await this.runAgentWithRetry(run, ctx, {
			role: "plan-reviser",
			label: "Plan revision",
			tier: "reasoning",
			focus: "Applying the critic's concrete plan corrections",
			systemPrompt: plannerSystemPrompt(),
			prompt: revisePlanPrompt(run.task, run.context ?? "", plan, critic.corrections),
			tools: READ_ONLY_TOOLS,
		});
		plan = normalizePlan(parseJson(revisedOutput));
		const finalCritic = await this.obtainCritic(run, ctx, plan);
		if (finalCritic.disposition === "blocked") {
			const answer = await this.waitForDecision(run, finalCritic.questions[0] || finalCritic.summary);
			this.ensureRunning(run);
			const resolved = await this.obtainCritic(run, ctx, plan, answer);
			if (resolved.disposition === "blocked") throw new Error("Final plan critic remains blocked after clarification.");
			if (resolved.disposition === "revise") {
				plan.assumptions = [...(plan.assumptions ?? []), ...resolved.corrections.map((item) => `Implementation constraint: ${item}`)];
			}
			plan.approvalBasis = resolved.disposition === "accepted" ? "final-critic-accepted" : "final-critic-corrections-incorporated";
			return plan;
		}
		if (finalCritic.disposition === "revise") {
			plan.assumptions = [...(plan.assumptions ?? []), ...finalCritic.corrections.map((item) => `Implementation constraint: ${item}`)];
		}
		plan.approvalBasis = finalCritic.disposition === "accepted" ? "final-critic-accepted" : "final-critic-corrections-incorporated";
		return plan;
	}

	private async obtainCritic(run: RunState, ctx: ExtensionContext, plan: ApprovedPlan, answer?: string): Promise<CriticResult> {
		let lastError: unknown;
		for (let attempt = 1; attempt <= 2; attempt++) {
			const output = await this.runAgentWithRetry(run, ctx, {
				role: "critic",
				label: attempt === 1 ? "Independent plan critic" : "Plan critic format retry",
				tier: "reasoning",
				focus: "Checking plan correctness, completeness, simplicity, and compliance",
				systemPrompt: criticSystemPrompt(),
				prompt: criticPrompt(run.task, run.context ?? "", plan, answer),
				tools: READ_ONLY_TOOLS,
			});
			try {
				return normalizeCritic(parseJson(output));
			} catch (error) {
				lastError = error;
				this.activity(run, undefined, "error", `Critic response malformed; ${attempt === 1 ? "retrying once" : "retry exhausted"}`, String(error));
			}
		}
		throw lastError;
	}

	private trackReportedFindings(
		run: RunState,
		findings: ReviewFinding[],
		source: string,
		status: "reported" | "verified" | "unresolved" = "reported",
	): void {
		for (const finding of findings) {
			const existing = run.trackedFindings.find((item) => item.finding.key.toLowerCase() === finding.key.toLowerCase());
			if (existing) {
				if (!existing.sources.includes(source)) existing.sources.push(source);
				if (existing.status !== "fixed") existing.status = status;
				existing.finding = finding;
			} else {
				run.trackedFindings.push({ finding, sources: [source], status });
			}
		}
	}

	private async reviewAndFix(run: RunState, ctx: ExtensionContext): Promise<void> {
		const [correctnessOutput, resilienceOutput, simplicityOutput] = await Promise.all([
			this.runAgentWithRetry(run, ctx, {
				role: "reviewer-correctness",
				label: "Correctness and integration review",
				tier: "reasoning",
				focus: "Tracing behavior end to end across producers, consumers, and module boundaries",
				systemPrompt: reviewerSystemPrompt("correctness and integration"),
				prompt: correctnessReviewPrompt(run.task, run.baseline),
				tools: READ_ONLY_TOOLS,
			}),
			this.runAgentWithRetry(run, ctx, {
				role: "reviewer-resilience",
				label: "Tests, security, and resilience review",
				tier: "reasoning",
				focus: "Inspecting regression coverage, edge cases, safety, accessibility, and resilience",
				systemPrompt: reviewerSystemPrompt("tests, security, and resilience"),
				prompt: resilienceReviewPrompt(run.task, run.baseline),
				tools: READ_ONLY_TOOLS,
			}),
			this.runAgentWithRetry(run, ctx, {
				role: "reviewer-simplicity",
				label: "Simplicity and reuse review",
				tier: "reasoning",
				focus: "Removing avoidable complexity and finding simpler existing patterns",
				systemPrompt: reviewerSystemPrompt("simplicity, code quality, performance, and reuse"),
				prompt: simplicityReviewPrompt(run.task, run.baseline),
				tools: READ_ONLY_TOOLS,
			}),
		]);
		const correctnessReview = normalizeReview(parseJson(correctnessOutput));
		const resilienceReview = normalizeReview(parseJson(resilienceOutput));
		const simplicityReview = normalizeReview(parseJson(simplicityOutput));
		run.reviews.push(
			{ source: "reviewer-correctness", stage: "initial", result: correctnessReview },
			{ source: "reviewer-resilience", stage: "initial", result: resilienceReview },
			{ source: "reviewer-simplicity", stage: "initial", result: simplicityReview },
		);
		this.trackReportedFindings(run, correctnessReview.mustFixes, "Correctness and integration review");
		this.trackReportedFindings(run, resilienceReview.mustFixes, "Tests, security, and resilience review");
		this.trackReportedFindings(run, simplicityReview.mustFixes, "Simplicity and reuse review");
		let findings = dedupeFindings([
			...correctnessReview.mustFixes,
			...resilienceReview.mustFixes,
			...simplicityReview.mustFixes,
		]);
		if (findings.length > 0) {
			const triageBatches = findingBatches(findings);
			const verifiedFindings: ReviewFinding[] = [];
			for (const [index, batch] of triageBatches.entries()) {
				const batchIndex = index + 1;
				const batchSuffix = triageBatches.length === 1 ? "" : ` batch ${batchIndex}/${triageBatches.length}`;
				const triageOutput = await this.runAgentWithRetry(run, ctx, {
					role: "review-triage",
					label: `Must-fix verification${batchSuffix}`,
					tier: "reasoning",
					focus: `Verifying ${batch.length} reviewer must-fix${batch.length === 1 ? "" : "es"} against current code`,
					systemPrompt: reviewerSystemPrompt("finding verification"),
					prompt: triagePrompt(run.task, batch, batchIndex, triageBatches.length),
					tools: READ_ONLY_TOOLS,
				});
				const triageReview = normalizeReview(parseJson(triageOutput));
				run.reviews.push({ source: "review-triage", stage: "triage", result: triageReview });
				verifiedFindings.push(...triageReview.mustFixes);
			}
			findings = dedupeFindings(verifiedFindings);
			const verifiedKeys = new Set(findings.map((finding) => finding.key.toLowerCase()));
			for (const tracked of run.trackedFindings) {
				tracked.status = verifiedKeys.has(tracked.finding.key.toLowerCase()) ? "verified" : "not-confirmed";
			}
			this.trackReportedFindings(run, findings, "Must-fix verification", "verified");
		}

		for (let round = 1; findings.length > 0 && round <= MAX_FIX_ROUNDS; round++) {
			this.ensureRunning(run);
			const fixBatches = findingBatches(findings);
			for (const [index, batch] of fixBatches.entries()) {
				const batchIndex = index + 1;
				const batchSuffix = fixBatches.length === 1 ? "" : ` batch ${batchIndex}/${fixBatches.length}`;
				const workItem = fixBatches.length === 1
					? `review-fix-${round}`
					: `review-fix-${round}-batch-${batchIndex}`;
				const fixOutput = await this.runAgentWithRetry(run, ctx, {
					role: "fixer",
					label: `Review fix round ${round}${batchSuffix}`,
					tier: "capable",
					focus: `Addressing ${batch.length} verified must-fix${batch.length === 1 ? "" : "es"}`,
					systemPrompt: fixerSystemPrompt(),
					prompt: fixerPrompt(
						run.task,
						run.plan!,
						batch,
						run.baseline,
						round,
						batchIndex,
						fixBatches.length,
						workItem,
					),
					tools: WRITER_TOOLS,
				});
				run.receipts.push(normalizeReceipt(parseJson(fixOutput), workItem));
				await this.inspectAfterWrite(run, workItem);
			}

			const unresolvedFindings: ReviewFinding[] = [];
			for (const [index, batch] of fixBatches.entries()) {
				const batchIndex = index + 1;
				const batchSuffix = fixBatches.length === 1 ? "" : ` batch ${batchIndex}/${fixBatches.length}`;
				const verifyOutput = await this.runAgentWithRetry(run, ctx, {
					role: "verifier",
					label: `Review fix verifier ${round}${batchSuffix}`,
					tier: "reasoning",
					focus: `Confirming ${batch.length} exact fix${batch.length === 1 ? "" : "es"} and adjacent regressions`,
					systemPrompt: verifierSystemPrompt(),
					prompt: verifierPrompt(run.task, batch, round, batchIndex, fixBatches.length),
					tools: READ_ONLY_TOOLS,
				});
				const verification = normalizeReview(parseJson(verifyOutput));
				run.reviews.push({ source: "verifier", stage: "verification", round, result: verification });
				const batchUnresolved = dedupeFindings(verification.mustFixes);
				const remainingKeys = new Set(batchUnresolved.map((finding) => finding.key.toLowerCase()));
				for (const candidate of batch) {
					const tracked = run.trackedFindings.find((item) => item.finding.key.toLowerCase() === candidate.key.toLowerCase());
					if (tracked && !remainingKeys.has(candidate.key.toLowerCase())) {
						tracked.status = "fixed";
						tracked.fixedRound = round;
					}
				}
				this.trackReportedFindings(run, batchUnresolved, `Verification round ${round}${batchSuffix}`, "unresolved");
				unresolvedFindings.push(...batchUnresolved);
			}
			findings = dedupeFindings(unresolvedFindings);
		}
		run.unresolvedFindings = findings;
		const unresolvedKeys = new Set(findings.map((finding) => finding.key.toLowerCase()));
		for (const tracked of run.trackedFindings) {
			if (unresolvedKeys.has(tracked.finding.key.toLowerCase())) tracked.status = "unresolved";
		}
	}

	private async runAgentWithRetry(run: RunState, ctx: ExtensionContext, request: AgentRequest): Promise<string> {
		try {
			return await this.launchAgent(run, ctx, request);
		} catch (firstError) {
			if (run.status === "aborted" || !isTransientFailure(firstError)) throw firstError;
			this.activity(run, undefined, "error", `${request.label} hit a transient failure; retrying once with a fresh agent`, String(firstError));
			return this.launchAgent(run, ctx, { ...request, label: `${request.label} (retry)` });
		}
	}

	private async launchAgent(run: RunState, ctx: ExtensionContext, request: AgentRequest): Promise<string> {
		this.ensureRunning(run);
		const record: AgentRecord = {
			id: id(request.role),
			role: request.role,
			label: request.label,
			tier: request.tier,
			status: "queued",
			focus: request.focus,
			prompt: request.prompt,
			activities: [],
			droppedActivityCount: 0,
		};
		run.agents.push(record);
		record.backend = this.resolveBackend(run, request.role);
		if (record.backend === "claude-code") {
			return this.launchClaudeCodeAgent(run, record, request);
		}

		const model = this.selectModel(ctx, request.role, run);
		const requestedEffort = run.config.roles[request.role].effort;
		const settingsManager = SettingsManager.inMemory({});
		const loader = new DefaultResourceLoader({
			cwd: run.cwd,
			agentDir: getAgentDir(),
			settingsManager,
			noExtensions: true,
			noPromptTemplates: true,
			noThemes: true,
			systemPrompt: request.systemPrompt,
		});
		await loader.reload();

		const engine = this;
		const progressTool = defineTool({
			name: "pio_progress",
			label: "PIO Progress",
			description: "Report a one-sentence description of the subagent's current focus to the PIO dashboard.",
			parameters: Type.Object({ summary: Type.String({ minLength: 1, maxLength: 240 }) }),
			async execute(_toolCallId, params) {
				record.focus = oneLine(params.summary, 240);
				record.lastActivity = record.focus;
				engine.activity(run, record, "focus", record.focus);
				return { content: [{ type: "text", text: "Progress reported." }], details: { summary: record.focus } };
			},
		});

		const { session } = await createAgentSession({
			cwd: run.cwd,
			model,
			thinkingLevel: requestedEffort,
			tools: request.tools,
			customTools: [progressTool],
			resourceLoader: loader,
			sessionManager: SessionManager.inMemory(run.cwd),
			settingsManager,
		});
		record.control = session;
		record.model = session.model ? `${session.model.provider}/${session.model.id}` : undefined;
		record.effort = session.thinkingLevel;
		if (record.effort !== requestedEffort) {
			const note = `${request.role} effort ${requestedEffort} was clamped by Pi to ${record.effort}`;
			if (!run.modelFallbacks.includes(note)) run.modelFallbacks.push(note);
		}
		this.activity(
			run,
			record,
			"prompt",
			`Delegated ${record.label} using ${record.model ?? "automatic model"} · ${record.effort} effort: ${record.focus}`,
			{
				prompt: record.prompt,
				actualModel: record.model,
				actualEffort: record.effort,
				requestedModel: model ? `${model.provider}/${model.id}` : undefined,
				requestedEffort,
				configSources: run.configSources,
			},
		);
		record.status = "running";
		record.startedAt = Date.now();
		record.lastActivity = "Starting isolated session";
		this.refreshUI();

		const unsubscribe = session.subscribe((event) => this.handleAgentEvent(run, record, event));
		const abort = () => void session.abort();
		run.abortController.signal.addEventListener("abort", abort, { once: true });
		try {
			await session.prompt(request.prompt, { expandPromptTemplates: false });
			if (run.status === "aborted") throw new Error("PIO run aborted");
			const output = session.getLastAssistantText()?.trim() ?? "";
			if (!output) throw new Error(`${record.label} completed without a final response`);
			record.output = output;
			record.status = "completed";
			record.lastActivity = "Completed";
			record.endedAt = Date.now();
			this.activity(run, record, "complete", `${record.label} completed`, { output: clip(output) });
			return output;
		} catch (error) {
			record.status = run.status === "aborted" ? "aborted" : "failed";
			record.error = error instanceof Error ? error.message : String(error);
			record.lastActivity = record.error;
			record.endedAt = Date.now();
			this.activity(run, record, "error", `${record.label} ${record.status}: ${record.error}`);
			throw error;
		} finally {
			run.abortController.signal.removeEventListener("abort", abort);
			unsubscribe();
			record.control = undefined;
			session.dispose();
			this.refreshUI();
		}
	}

	private async launchClaudeCodeAgent(run: RunState, record: AgentRecord, request: AgentRequest): Promise<string> {
		const roleConfig = run.config.roles[request.role];
		const requestedModel = roleConfig.model ?? defaultModelFor(request.role, "claude-code");
		const requestedEffort = roleConfig.effort;
		const child = new ClaudeCodeRun({
			executable: run.config.claudeCodeExecutable,
			cwd: run.cwd,
			model: requestedModel,
			effort: requestedEffort,
			systemPrompt: request.systemPrompt,
			prompt: request.prompt,
			tools: request.tools,
			callbacks: {
				onRuntime: (model, effort) => {
					record.model = model;
					record.effort = effort;
					record.lastActivity = `Claude Code initialized${model ? ` with ${model}` : ""} · ${effort} effort`;
					this.activity(run, record, "focus", record.lastActivity, {
						actualModel: model ?? "not reported by Claude Code",
						acceptedEffort: effort,
					});
				},
				onText: (text) => {
					record.lastActivity = oneLine(text);
					this.activity(run, record, "text", record.lastActivity, { text: clip(text) });
				},
				onToolStart: (name, input) => {
					record.lastActivity = toolActivity(name, input);
					this.activity(run, record, "tool", record.lastActivity, { tool: name, arguments: safeDetails(input) });
				},
				onToolResult: (name, content, isError) => {
					record.lastActivity = `${name.toLowerCase()} ${isError ? "failed" : "completed"}`;
					if (isError) this.activity(run, record, "tool-result", record.lastActivity, { result: safeDetails(content) });
				},
				onDiagnostic: (summary, details) => {
					record.lastActivity = oneLine(summary);
					this.activity(run, record, "tool-result", record.lastActivity, details);
				},
			},
		});
		record.control = child;
		record.status = "running";
		record.startedAt = Date.now();
		record.lastActivity = "Launching Claude Code";
		this.activity(
			run,
			record,
			"prompt",
			`Delegated ${record.label} to Claude Code: ${record.focus}`,
			{
				prompt: record.prompt,
				requestedModel,
				requestedEffort,
				permissions: "dangerously-skip-permissions",
				configSources: run.configSources,
			},
		);
		const abort = () => void child.abort();
		run.abortController.signal.addEventListener("abort", abort, { once: true });
		try {
			const output = await child.run();
			if (run.status === "aborted") throw new Error("PIO run aborted");
			if (!output.trim()) throw new Error(`${record.label} completed without a final response`);
			record.output = output;
			record.status = "completed";
			record.lastActivity = "Completed";
			record.endedAt = Date.now();
			this.activity(run, record, "complete", `${record.label} completed`, {
				output: clip(output),
				actualModel: record.model ?? "not reported by Claude Code",
				acceptedEffort: record.effort ?? "not reported by Claude Code",
			});
			return output;
		} catch (error) {
			record.status = run.status === "aborted" ? "aborted" : "failed";
			record.error = error instanceof Error ? error.message : String(error);
			record.lastActivity = record.error;
			record.endedAt = Date.now();
			this.activity(run, record, "error", `${record.label} ${record.status}: ${record.error}`);
			throw error;
		} finally {
			run.abortController.signal.removeEventListener("abort", abort);
			record.control = undefined;
			this.refreshUI();
		}
	}

	private handleAgentEvent(run: RunState, record: AgentRecord, event: AgentSessionEvent): void {
		switch (event.type) {
			case "turn_start":
				record.lastActivity = "New agent turn started";
				this.refreshUI();
				break;
			case "message_end": {
				const text = assistantText(event.message);
				if (text) {
					record.lastActivity = oneLine(text);
					this.activity(run, record, "text", record.lastActivity, { text: clip(text) });
				}
				break;
			}
			case "tool_execution_start":
				if (event.toolName !== "pio_progress") {
					record.lastActivity = toolActivity(event.toolName, event.args);
					this.activity(run, record, "tool", record.lastActivity, { tool: event.toolName, arguments: safeDetails(event.args) });
				}
				break;
			case "tool_execution_update":
				if (event.toolName !== "pio_progress") {
					record.lastActivity = `${event.toolName} is still running`;
					this.refreshUI();
				}
				break;
			case "tool_execution_end":
				if (event.toolName !== "pio_progress") {
					record.lastActivity = `${event.toolName} ${event.isError ? "failed" : "completed"}`;
					if (event.isError) this.activity(run, record, "tool-result", record.lastActivity, { result: safeDetails(event.result) });
				}
				break;
			case "queue_update":
				if (event.steering.length > 0) {
					record.lastActivity = `${event.steering.length} steering message${event.steering.length === 1 ? "" : "s"} queued`;
					this.refreshUI();
				}
				break;
			case "auto_retry_start":
				record.lastActivity = `Retry ${event.attempt}/${event.maxAttempts}: ${oneLine(event.errorMessage)}`;
				this.activity(run, record, "error", record.lastActivity);
				break;
		}
	}

	private resolveBackend(run: RunState, role: PioRole): "pi" | "claude-code" {
		const configured = run.config.roles[role].backend;
		if (configured === "claude-code") return "claude-code";
		return "pi";
	}

	private selectModel(ctx: ExtensionContext, role: PioRole, run: RunState): Model<any> | undefined {
		const current = ctx.model;
		const available = ctx.modelRegistry.getAvailable();
		const parentUsesOpenAI = current ? current.provider === "openai" || current.provider === "openai-codex" : false;
		const configured = run.config.roles[role];
		// A configured model always wins. Without one, non-OpenAI Pi workers
		// inherit the parent's exact model.
		if (current && !parentUsesOpenAI && !configured.model) return current;

		let provider = configured.provider;
		let modelId = configured.model ?? defaultModelFor(role, "pi");
		const separator = modelId.indexOf("/");
		if (separator > 0) {
			provider = modelId.slice(0, separator);
			modelId = modelId.slice(separator + 1);
		}
		const selected = available.find((model) => model.provider === provider && model.id === modelId);
		if (selected) return selected;

		const fallback = current ?? available[0];
		if (fallback) {
			const note = `${role} requested ${provider}/${modelId} but fell back to parent model ${fallback.provider}/${fallback.id}`;
			if (!run.modelFallbacks.includes(note)) run.modelFallbacks.push(note);
		}
		return fallback;
	}

	private async waitForDecision(run: RunState, question: string): Promise<string> {
		run.status = "paused";
		return new Promise<string>((resolve) => {
			run.pendingDecision = { question, resolve };
			this.activity(run, undefined, "decision", `PIO is waiting: ${oneLine(question)}`, { question });
			this.ui?.notify(`PIO paused: ${question}`, "warning");
			this.pi.sendMessage(
				{
					customType: "pio-update",
					content: `PIO run ${run.id} is blocked and needs this decision: ${question}`,
					display: true,
					details: { runId: run.id, question },
				},
				{ triggerTurn: true, deliverAs: "followUp" },
			);
			this.refreshUI();
		});
	}

	private ensureRunning(run: RunState): void {
		if (run.status === "aborted" || run.abortController.signal.aborted) throw new Error("PIO run aborted");
		if (run.status === "failed") throw new Error(run.error ?? "PIO run failed");
	}

	private setPhase(run: RunState, phase: PioPhase): void {
		this.ensureRunning(run);
		run.phase = phase;
		run.phaseLabel = PHASES[phase];
		this.activity(run, undefined, "phase", `Phase ${phase}/7 — ${PHASES[phase]}`);
		this.refreshUI();
	}

	private async inspectBaseline(run: RunState): Promise<string> {
		const contextFiles = loadProjectContextFiles({ cwd: run.cwd, agentDir: getAgentDir() });
		run.instructionPaths = contextFiles.map((file) => file.path);
		const referencedPaths = new Set<string>();
		for (const file of contextFiles) {
			for (const match of file.content.matchAll(/`([^`\n]+\.md)`/gi)) {
				const raw = match[1].trim();
				const candidates = isAbsolute(raw) ? [raw] : [resolve(run.cwd, raw), resolve(dirname(file.path), raw)];
				for (const candidate of candidates) {
					try {
						await access(candidate);
						await readFile(candidate, "utf8");
						referencedPaths.add(candidate);
						break;
					} catch {
						// A quoted Markdown path is not necessarily a required local document.
					}
				}
			}
		}
		run.requiredDocumentPaths = [...referencedPaths];

		const status = await this.pi.exec("git", ["status", "--short"], { timeout: 10_000 });
		const instructionSummary = [
			`Applicable instruction documents read:\n${run.instructionPaths.map((path) => `- ${path}`).join("\n") || "- (none found)"}`,
			`Existing referenced Markdown documents read before delegation:\n${run.requiredDocumentPaths.map((path) => `- ${path}`).join("\n") || "- (none found)"}`,
		].join("\n\n");
		if (status.code !== 0) {
			return `${instructionSummary}\n\nNot a Git workspace or git status unavailable: ${oneLine(status.stderr || status.stdout)}`;
		}
		const diff = await this.pi.exec("git", ["diff", "--stat"], { timeout: 10_000 });
		return `${instructionSummary}\n\ngit status --short:\n${status.stdout.trim() || "(clean)"}\n\ngit diff --stat:\n${diff.stdout.trim() || "(no unstaged diff stat)"}`;
	}

	private async inspectAfterWrite(run: RunState, label: string): Promise<void> {
		const status = await this.pi.exec("git", ["status", "--short"], { timeout: 10_000 });
		const stat = await this.pi.exec("git", ["diff", "--stat"], { timeout: 10_000 });
		this.activity(run, undefined, "tool-result", `Coordinator inspected workspace after ${label}`, {
			status: clip(status.stdout.trim() || "(clean)"),
			diffStat: clip(stat.stdout.trim() || "(no unstaged diff stat)"),
		});
	}

	private assertCompletionGate(run: RunState): void {
		if (!run.plan?.approvalBasis) throw new Error("Completion gate failed: no approved plan or approval basis.");
		for (const item of run.plan.workItems) {
			const receipt = run.receipts.find((candidate) => candidate.workItem === item.id);
			if (!receipt) throw new Error(`Completion gate failed: missing writer receipt for ${item.id}.`);
			if (receipt.validation.length === 0) throw new Error(`Completion gate failed: ${item.id} did not report validation or a policy skip.`);
		}
		const requiredReviewers: PioRole[] = ["reviewer-correctness", "reviewer-resilience", "reviewer-simplicity"];
		const reviewers = new Set(
			run.agents
				.filter((agent) => agent.status === "completed" && requiredReviewers.includes(agent.role as PioRole))
				.map((agent) => agent.role),
		);
		if (reviewers.size !== requiredReviewers.length) {
			throw new Error("Completion gate failed: the independent reviewer set did not complete.");
		}
		const completedFixers = run.agents.filter((agent) => agent.role === "fixer" && agent.status === "completed").length;
		const completedVerifiers = run.agents.filter((agent) => agent.role === "verifier" && agent.status === "completed").length;
		if (completedVerifiers < completedFixers) throw new Error("Completion gate failed: a fixer lacks a later fresh verifier.");
		for (const receipt of run.receipts.filter((candidate) => candidate.workItem.startsWith("review-fix-"))) {
			if (receipt.validation.length === 0) throw new Error(`Completion gate failed: ${receipt.workItem} did not report focused validation or a policy skip.`);
		}
	}

	private completeRun(run: RunState): void {
		run.status = "completed";
		run.endedAt = Date.now();
		const changed = [...new Set(run.receipts.flatMap((receipt) => receipt.changedPaths))];
		const validations = run.receipts.flatMap((receipt) => receipt.validation);
		const failed = validations.filter((validation) => validation.outcome === "failed");
		const skipped = validations.filter((validation) => validation.outcome === "skipped");
		const unresolved = run.unresolvedFindings.length;
		run.summary = [
			changed.length > 0 ? `Changed ${changed.join(", ")}.` : "No changed paths were reported.",
			failed.length > 0
				? `${failed.length} validation check${failed.length === 1 ? "" : "s"} failed.`
				: skipped.length > 0
					? `Validation completed with ${skipped.length} policy or scope skip${skipped.length === 1 ? "" : "s"}.`
					: "Reported validation passed.",
			unresolved > 0 ? `${unresolved} must-fix${unresolved === 1 ? " remains" : "es remain"} unresolved.` : "No verified must-fixes remain.",
		].join(" ");
		run.finalReport = finalReport(run);
		this.activity(run, undefined, "complete", `PIO run completed: ${run.summary}`, run.finalReport);
		this.pi.sendMessage(
			{
				customType: "pio-update",
				content: run.finalReport,
				display: true,
				details: this.snapshot(run.id),
			},
			{ triggerTurn: false },
		);
		this.ui?.notify(`PIO completed: ${run.id}`, unresolved > 0 ? "warning" : "info");
		this.refreshUI();
	}

	private failRun(run: RunState, error: unknown): void {
		if (run.status === "aborted") return;
		run.status = "failed";
		run.endedAt = Date.now();
		run.error = error instanceof Error ? error.message : String(error);
		this.activity(run, undefined, "error", `PIO stopped in phase ${run.phase}: ${run.error}`);
		this.pi.sendMessage(
			{
				customType: "pio-update",
				content: `PIO run ${run.id} failed in phase ${run.phase} (${run.phaseLabel}): ${run.error}`,
				display: true,
				details: this.snapshot(run.id),
			},
			{ triggerTurn: true, deliverAs: "followUp" },
		);
		this.ui?.notify(`PIO failed: ${run.error}`, "error");
		this.refreshUI();
	}

	private activity(
		run: RunState,
		agent: AgentRecord | undefined,
		kind: Activity["kind"],
		summary: string,
		details?: unknown,
	): void {
		const activity: Activity = {
			id: id("activity"),
			timestamp: Date.now(),
			runId: run.id,
			agentId: agent?.id,
			kind,
			summary: oneLine(summary, 300),
			details: details === undefined ? undefined : safeDetails(details),
		};
		run.activities.push(activity);
		if (run.activities.length > RETAINED_ACTIVITY_LIMIT) {
			const dropped = run.activities.length - RETAINED_ACTIVITY_LIMIT;
			run.activities.splice(0, dropped);
			run.droppedActivityCount += dropped;
		}
		if (agent) {
			agent.activities.push(activity);
			if (agent.activities.length > RETAINED_ACTIVITY_LIMIT) {
				const dropped = agent.activities.length - RETAINED_ACTIVITY_LIMIT;
				agent.activities.splice(0, dropped);
				agent.droppedActivityCount += dropped;
			}
		}
		this.pi.appendEntry<ActivityEntryData>("pio-activity", { ...activity, role: agent?.label });
		this.refreshUI();
	}

	private refreshUI(): void {
		const run = this.currentRun;
		if (this.ui) {
			if (!run) this.ui.setStatus("pio", undefined);
			else {
				const icon = run.status === "completed" ? "✓" : run.status === "failed" ? "✗" : run.status === "paused" ? "Ⅱ" : "●";
				this.ui.setStatus("pio", `${icon} PIO ${run.phase}/7 ${run.status}`);
			}
		}
		this.render?.();
	}
}
