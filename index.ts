import { getMarkdownTheme, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { PioEngine } from "./engine.ts";
import type { Activity, PioSnapshot } from "./types.ts";
import { buildLogComponent, createDashboard, renderActivityEntry } from "./ui.ts";

const Actions = StringEnum(["start", "status", "report", "steer", "answer", "abort"] as const);
const Efforts = StringEnum(["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const);
const Backends = StringEnum(["auto", "pi", "claude-code"] as const);
const RoleConfigSchema = Type.Object({
	backend: Type.Optional(Backends),
	provider: Type.Optional(Type.String()),
	model: Type.Optional(Type.String()),
	effort: Type.Optional(Efforts),
});
const ConfigOverrideSchema = Type.Object({
	backend: Type.Optional(Backends),
	provider: Type.Optional(Type.String()),
	claudeCodeExecutable: Type.Optional(Type.String()),
	defaults: Type.Optional(RoleConfigSchema),
	roles: Type.Optional(Type.Object({
		context: Type.Optional(RoleConfigSchema),
		planner: Type.Optional(RoleConfigSchema),
		critic: Type.Optional(RoleConfigSchema),
		"plan-reviser": Type.Optional(RoleConfigSchema),
		writer: Type.Optional(RoleConfigSchema),
		"reviewer-correctness": Type.Optional(RoleConfigSchema),
		"reviewer-resilience": Type.Optional(RoleConfigSchema),
		"review-triage": Type.Optional(RoleConfigSchema),
		fixer: Type.Optional(RoleConfigSchema),
		verifier: Type.Optional(RoleConfigSchema),
	})),
});

function snapshotText(snapshot: PioSnapshot): string {
	const active = snapshot.activeAgents.length
		? snapshot.activeAgents
			.map((agent) => `${agent.role} [${agent.backend ?? "pi"} · ${agent.model ?? "model pending"} · ${agent.effort ?? "effort pending"}]: ${agent.focus}`)
			.join("; ")
		: "none";
	return [
		`Run: ${snapshot.runId}`,
		`Status: ${snapshot.status}`,
		`Phase: ${snapshot.phase}/7 — ${snapshot.phaseLabel}`,
		`Active agents: ${active}`,
		snapshot.pendingQuestion ? `Question: ${snapshot.pendingQuestion}` : undefined,
		snapshot.summary ? `Summary: ${snapshot.summary}` : undefined,
		snapshot.error ? `Error: ${snapshot.error}` : undefined,
	].filter(Boolean).join("\n");
}

export default function (pi: ExtensionAPI) {
	const engine = new PioEngine(pi);

	pi.registerEntryRenderer<Activity & { role?: string }>("pio-activity", (entry, { expanded }, theme) =>
		renderActivityEntry(entry.data!, expanded, theme),
	);

	pi.registerMessageRenderer("pio-update", (message, { expanded, outputPad }, theme) => {
		const content = typeof message.content === "string"
			? message.content
			: message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
		const container = new Container();
		container.addChild(new Text(theme.fg("accent", theme.bold("PIO update")), outputPad, 0));
		container.addChild(new Markdown(content, outputPad, 0, getMarkdownTheme()));
		if (expanded && message.details) {
			container.addChild(new Spacer(1));
			container.addChild(new Text(theme.fg("dim", JSON.stringify(message.details, null, 2)), outputPad, 0));
		}
		return container;
	});

	pi.on("session_start", async (_event, ctx) => {
		ctx.ui.setWidget("pio", (tui) => {
			engine.attachUI(ctx, () => tui.requestRender());
			return createDashboard(() => engine.currentRun, () => tui.requestRender());
		});
		engine.attachUI(ctx);
	});

	pi.on("session_shutdown", async () => {
		const run = engine.currentRun;
		if (run && (run.status === "running" || run.status === "paused")) await engine.abort(run.id);
	});

	pi.registerTool({
		name: "pio",
		label: "PIO",
		description: "Start and control an observable background orchestration pipeline that uses fresh isolated agents for context, planning, criticism, sequential implementation, independent review, fixes, and verification. Actions: start, status, report, steer, answer, abort.",
		promptSnippet: "Start or control a live multi-agent PIO orchestration run",
		promptGuidelines: [
			"Use pio only when the user explicitly requests PIO, pi-orchestrator, orchestration, or isolated-agent execution.",
			"PIO start runs in the background; use pio status to inspect it and pio steer to send a message to a running child agent when the user requests a correction.",
			"When a pio-update reports a blocking question, relay it to the user or call pio answer only when repository evidence already resolves it.",
			"Do not claim a PIO run is complete until its status is completed, failed, or aborted.",
		],
		parameters: Type.Object({
			action: Actions,
			task: Type.Optional(Type.String({ description: "Concrete task or task source for action=start" })),
			config: Type.Optional(ConfigOverrideSchema),
			runId: Type.Optional(Type.String({ description: "Run identifier; defaults to the current run" })),
			agentId: Type.Optional(Type.String({ description: "Running agent role or internal identifier for action=steer" })),
			message: Type.Optional(Type.String({ description: "Steering instruction or blocking-question answer" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			try {
				switch (params.action) {
					case "start": {
						const run = await engine.start(params.task ?? "", ctx, params.config);
						const snapshot = engine.snapshot(run.id);
						return {
							content: [{ type: "text", text: `Started background PIO run.\n${snapshotText(snapshot)}` }],
							details: snapshot,
						};
					}
					case "status": {
						const snapshot = engine.snapshot(params.runId);
						return { content: [{ type: "text", text: snapshotText(snapshot) }], details: snapshot };
					}
					case "report":
						return { content: [{ type: "text", text: engine.report(params.runId) }], details: engine.snapshot(params.runId) };
					case "steer": {
						const agent = await engine.steer(params.message ?? "", params.agentId, params.runId);
						return {
							content: [{ type: "text", text: `Steering queued for ${agent.role}: ${params.message}` }],
							details: engine.snapshot(params.runId),
						};
					}
					case "answer":
						engine.answer(params.message ?? "", params.runId);
						return { content: [{ type: "text", text: "PIO decision supplied; the paused pipeline is resuming." }], details: engine.snapshot(params.runId) };
					case "abort":
						await engine.abort(params.runId);
						return { content: [{ type: "text", text: "PIO run aborted." }], details: engine.snapshot(params.runId) };
			}
		} catch (error) {
			throw new Error(error instanceof Error ? error.message : String(error));
		}
		},
		renderCall(args, theme) {
			const subject = args.action === "start" ? args.task ?? "…" : args.agentId ?? args.runId ?? "current run";
			return new Text(`${theme.fg("toolTitle", theme.bold("pio "))}${theme.fg("accent", args.action)}\n  ${theme.fg("dim", subject)}`, 0, 0);
		},
		renderResult(result, { expanded }, theme) {
			const snapshot = result.details as PioSnapshot | undefined;
			if (!snapshot) {
				const first = result.content[0];
				return new Text(first?.type === "text" ? first.text : "PIO", 0, 0);
			}
			let text = `${theme.fg("accent", `${snapshot.phase}/7`)} ${snapshot.phaseLabel} · ${snapshot.status}`;
			for (const agent of snapshot.activeAgents) {
				const runtime = `${agent.backend ?? "pi"} · ${agent.model ?? "model pending"} · ${agent.effort ?? "effort pending"}`;
				text += `\n  ${theme.fg("warning", "▶")} ${agent.role} ${theme.fg("dim", `[${runtime}]`)}: ${agent.focus}`;
			}
			if (snapshot.pendingQuestion) text += `\n  ${theme.fg("warning", "?")} ${snapshot.pendingQuestion}`;
			if (expanded) text += `\n\n${theme.fg("dim", snapshotText(snapshot))}`;
			return new Text(text, 0, 0);
		},
	});

	pi.registerCommand("pio", {
		description: "Start PIO using the configured per-role backends and models",
		handler: async (args, ctx) => {
			const task = args.trim() || await ctx.ui.editor("PIO task", "Describe the task or provide a local plan/Jira source");
			if (!task?.trim()) return;
			try {
				const run = await engine.start(task, ctx);
				ctx.ui.notify(`PIO started: ${run.id}`, "info");
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});

	pi.registerCommand("pio-status", {
		description: "Show the current PIO phase and active agents",
		handler: async (_args, ctx) => {
			try {
				ctx.ui.notify(snapshotText(engine.snapshot()), "info");
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "warning");
			}
		},
	});

	pi.registerCommand("pio-report", {
		description: "Show the completed PIO plan, review findings, resolutions, and important notes",
		handler: async (_args, ctx) => {
			try {
				pi.sendMessage({ customType: "pio-update", content: engine.report(), display: true }, { triggerTurn: false });
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "warning");
			}
		},
	});

	pi.registerCommand("pio-steer", {
		description: "Send a steering message to a running PIO subagent",
		handler: async (args, ctx) => {
			try {
				const run = engine.currentRun;
				if (!run) throw new Error("No PIO run exists.");
				const active = run.agents.filter((agent) => agent.status === "running");
				if (active.length === 0) throw new Error("No PIO subagent is currently running.");
				let selected = active[0];
				if (active.length > 1) {
					const choices = active.map((agent) => `${agent.role} — ${agent.label} — ${agent.focus}`);
					const choice = await ctx.ui.select("Steer which PIO agent?", choices);
					if (!choice) return;
					selected = active[choices.indexOf(choice)];
				}
				const message = args.trim() || await ctx.ui.input(`Steer ${selected.role}`, "New instruction") || "";
				if (!message) return;
				await engine.steer(message, selected.role, run.id);
				ctx.ui.notify(`Steering queued for ${selected.role}`, "info");
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});

	pi.registerCommand("pio-answer", {
		description: "Answer the blocking question for a paused PIO run",
		handler: async (args, ctx) => {
			try {
				const run = engine.currentRun;
				if (!run?.pendingDecision) throw new Error("PIO is not waiting for a decision.");
				const answer = args.trim() || await ctx.ui.input(run.pendingDecision.question, "Answer") || "";
				if (!answer) return;
				engine.answer(answer, run.id);
				ctx.ui.notify("PIO resumed", "info");
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});

	pi.registerCommand("pio-abort", {
		description: "Abort the current PIO run and all active subagents",
		handler: async (_args, ctx) => {
			try {
				await engine.abort();
				ctx.ui.notify("PIO aborted", "warning");
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});

	pi.registerCommand("pio-log", {
		description: "Open retained PIO activity with an interactive role picker",
		handler: async (args, ctx) => {
			const run = engine.currentRun;
			if (!run) {
				ctx.ui.notify("No PIO run exists.", "warning");
				return;
			}
			const requestedRole = args.trim().toLowerCase();
			let agentId = requestedRole
				? run.agents.find((agent) => agent.role.toLowerCase() === requestedRole || agent.label.toLowerCase() === requestedRole)?.id
				: undefined;
			if (!requestedRole && run.agents.length > 0) {
				const choices = ["All activity", ...run.agents.map((agent) => `${agent.role} — ${agent.label}`)];
				const choice = await ctx.ui.select("PIO activity", choices);
				if (!choice) return;
				if (choice !== "All activity") agentId = run.agents[choices.indexOf(choice) - 1]?.id;
			}
			if (requestedRole && !agentId) {
				ctx.ui.notify(`No PIO agent matches role: ${args.trim()}`, "warning");
				return;
			}
			await ctx.ui.custom<void>((_tui, theme, _keybindings, done) => buildLogComponent(run, agentId, theme, done));
		},
	});
}
