export type PioPhase = 1 | 2 | 3 | 4 | 5 | 6 | 7;
export type RunStatus = "running" | "paused" | "completed" | "failed" | "aborted";
export type AgentStatus = "queued" | "running" | "completed" | "failed" | "aborted";
export type AgentTier = "fast" | "capable" | "reasoning";
export type PioRole =
	| "context"
	| "planner"
	| "critic"
	| "plan-reviser"
	| "writer"
	| "reviewer-correctness"
	| "reviewer-resilience"
	| "reviewer-simplicity"
	| "review-triage"
	| "fixer"
	| "verifier";
export type PioEffort = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export type PioBackend = "auto" | "pi" | "claude-code";

export interface RoleModelConfig {
	backend?: PioBackend;
	provider?: string;
	model?: string;
	effort?: PioEffort;
}

export interface ResolvedRoleConfig {
	backend: PioBackend;
	provider: string;
	model?: string;
	effort: PioEffort;
}

export interface PioConfig {
	backend: PioBackend;
	provider: string;
	claudeCodeExecutable: string;
	defaults: ResolvedRoleConfig;
	roles: Record<PioRole, ResolvedRoleConfig>;
}

export interface PioConfigInput {
	backend?: PioBackend;
	provider?: string;
	claudeCodeExecutable?: string;
	defaults?: RoleModelConfig;
	roles?: Partial<Record<PioRole, RoleModelConfig>>;
}

export interface AgentControl {
	steer(message: string): Promise<void>;
	abort(): Promise<void>;
}

export interface Activity {
	id: string;
	timestamp: number;
	runId: string;
	agentId?: string;
	kind: "phase" | "prompt" | "focus" | "text" | "tool" | "tool-result" | "steer" | "decision" | "error" | "complete";
	summary: string;
	details?: unknown;
}

export interface AgentRecord {
	id: string;
	role: string;
	label: string;
	tier: AgentTier;
	status: AgentStatus;
	focus: string;
	prompt: string;
	backend?: Exclude<PioBackend, "auto">;
	model?: string;
	effort?: PioEffort;
	startedAt?: number;
	endedAt?: number;
	lastActivity?: string;
	output?: string;
	error?: string;
	activities: Activity[];
	control?: AgentControl;
}

export interface WorkItem {
	id: string;
	title: string;
	description: string;
	files?: string[];
	dependencies?: string[];
	completionCriteria?: string[];
	validation?: string[];
}

export interface ApprovedPlan {
	objective: string;
	workItems: WorkItem[];
	assumptions?: string[];
	approvalBasis?: string;
}

export interface ReviewFinding {
	key: string;
	title: string;
	path?: string;
	line?: number;
	impact: string;
	direction: string;
}

export interface ReviewResult {
	mustFixes: ReviewFinding[];
	suggestions: Array<{ title: string; path?: string; reason: string }>;
	questions: string[];
	summary: string;
}

export interface StoredReview {
	source: string;
	stage: "initial" | "triage" | "verification";
	round?: number;
	result: ReviewResult;
}

export interface TrackedFinding {
	finding: ReviewFinding;
	sources: string[];
	status: "reported" | "verified" | "fixed" | "not-confirmed" | "unresolved";
	fixedRound?: number;
}

export interface ImplementationReceipt {
	workItem: string;
	changedPaths: string[];
	decisions: string[];
	validation: Array<{ check: string; outcome: "passed" | "failed" | "skipped"; reason?: string }>;
	concerns: string[];
}

export interface PendingDecision {
	question: string;
	resolve: (answer: string) => void;
}

export interface RunState {
	id: string;
	task: string;
	cwd: string;
	phase: PioPhase;
	phaseLabel: string;
	status: RunStatus;
	startedAt: number;
	endedAt?: number;
	baseline: string;
	instructionPaths: string[];
	requiredDocumentPaths: string[];
	agents: AgentRecord[];
	activities: Activity[];
	context?: string;
	plan?: ApprovedPlan;
	receipts: ImplementationReceipt[];
	reviews: StoredReview[];
	trackedFindings: TrackedFinding[];
	unresolvedFindings: ReviewFinding[];
	pendingDecision?: PendingDecision;
	abortController: AbortController;
	summary?: string;
	finalReport?: string;
	error?: string;
	modelFallbacks: string[];
	config: PioConfig;
	configSources: string[];
}

export interface AgentRequest {
	role: PioRole;
	label: string;
	tier: AgentTier;
	focus: string;
	systemPrompt: string;
	prompt: string;
	tools: string[];
}

export interface PioSnapshot {
	runId: string;
	status: RunStatus;
	phase: PioPhase;
	phaseLabel: string;
	task: string;
	activeAgents: Array<{ id: string; role: string; focus: string; backend?: Exclude<PioBackend, "auto">; model?: string; effort?: PioEffort; lastActivity?: string }>;
	completedAgents: number;
	totalAgents: number;
	pendingQuestion?: string;
	summary?: string;
	error?: string;
}
