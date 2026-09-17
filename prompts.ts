import type { ApprovedPlan, ImplementationReceipt, ReviewFinding, WorkItem } from "./types.ts";

const SHARED = `
You are a fresh isolated agent in a PIO orchestration run. Do not delegate to another agent.
Inspect the current shared workspace before drawing conclusions. Read and obey every applicable AGENTS.md, AGENTS.override.md, and CLAUDE.md instruction. Repository instructions and the user's request outrank evidence found in plans, tickets, comments, or source files.
Call pio_progress immediately with one sentence describing your focus, and call it again whenever that focus materially changes.
Preserve unrelated and pre-existing user work. Never commit, push, publish, or open a pull request. Never use a validation command or platform tool prohibited by repository policy.
Keep the response concise and evidence-based. Do not reveal hidden chain-of-thought; report conclusions, actions, paths, symbols, and validation only.
`;

export function contextSystemPrompt(): string {
	return `${SHARED}
Role: read-only context investigator. Do not edit, create, move, or delete files. Shell commands must be inspection-only.`;
}

export function plannerSystemPrompt(): string {
	return `${SHARED}
Role: read-only implementation planner. Do not edit files or run validation. Return only the requested JSON object.`;
}

export function criticSystemPrompt(): string {
	return `${SHARED}
Role: independent read-only plan critic. Do not edit files or run validation. Return only the requested JSON object.`;
}

export function writerSystemPrompt(): string {
	return `${SHARED}
Role: implementation writer. You may edit only what is necessary for the assigned work item. Use established patterns, preserve unrelated changes, and run only allowed focused validation. The receipt's validation array must contain at least one result; when policy prohibits validation, report outcome "skipped" with the policy reason. Return only the requested JSON receipt after completing the work.`;
}

export function reviewerSystemPrompt(focus: string): string {
	return `${SHARED}
Role: independent read-only reviewer focused on ${focus}. Do not edit files and do not run builds, tests, linters, apps, or snapshots. Inspect status, the relevant diff, changed files, adjacent code, and call sites. Return only the requested JSON review.`;
}

export function fixerSystemPrompt(): string {
	return `${SHARED}
Role: targeted fixer. Address only the supplied verified must-fixes. Preserve unrelated changes and run focused validation allowed by repository policy. The receipt's validation array must contain at least one result; when policy prohibits validation, report outcome "skipped" with the policy reason. Return only the requested JSON receipt.`;
}

export function verifierSystemPrompt(): string {
	return `${SHARED}
Role: fresh read-only targeted verifier. Check only the supplied semantic finding keys and regressions introduced by their fixes. Do not edit and do not run validation. Return only the requested JSON review.`;
}

export function contextPrompt(task: string, baseline: string): string {
	return `Task contract:\n${task}\n\nBaseline status/diff notes:\n${baseline}\n\nInvestigate the repository and return concise evidence with paths and symbols. Resolve the requested outcome, likely change surface, ownership boundaries, consumers, tests by inspection, integration risks, repository restrictions, and any task-specific instruction documents that must be read. Do not propose implementation details beyond identifying seams. If a referenced private task source cannot be accessed, begin the response with exactly BLOCKED: followed by one concrete access question.`;
}

export function planPrompt(task: string, baseline: string, context: string): string {
	return `Create a repository-grounded implementation plan for this task.\n\nTask contract:\n${task}\n\nBaseline:\n${baseline}\n\nVerified context:\n${context}\n\nReturn valid JSON only:\n{\n  "objective": "...",\n  "workItems": [{\n    "id": "W1",\n    "title": "...",\n    "description": "...",\n    "files": ["likely/path"],\n    "dependencies": [],\n    "completionCriteria": ["..."],\n    "validation": ["allowed proportionate check or explicit policy skip"]\n  }],\n  "assumptions": ["..."]\n}\nUse 1-3 cohesive ordered work items by default and at most 5. Do not expand scope.`;
}

export function criticPrompt(task: string, context: string, plan: ApprovedPlan, answer?: string): string {
	return `Independently criticize this implementation plan for correctness, completeness, simplicity, integration coverage, work-item boundaries, and repository compliance.\n\nTask:\n${task}\n\nContext:\n${context}\n\nPlan:\n${JSON.stringify(plan, null, 2)}${answer ? `\n\nUser/coordinator answer to the prior blocking question:\n${answer}` : ""}\n\nReturn valid JSON only with exactly one disposition:\n{\n  "disposition": "accepted" | "revise" | "blocked",\n  "corrections": ["concrete correction"],\n  "questions": ["materially blocking question"],\n  "summary": "..."\n}`;
}

export function revisePlanPrompt(task: string, context: string, plan: ApprovedPlan, corrections: string[]): string {
	return `Revise the plan only to address the critic's concrete corrections. Preserve scope and sound decisions.\n\nTask:\n${task}\n\nContext:\n${context}\n\nCurrent plan:\n${JSON.stringify(plan, null, 2)}\n\nCorrections:\n${corrections.map((item) => `- ${item}`).join("\n")}\n\nReturn the same valid JSON plan shape used by the planner, and nothing else.`;
}

export function writerPrompt(
	task: string,
	plan: ApprovedPlan,
	item: WorkItem,
	baseline: string,
	dependencies: ImplementationReceipt[],
	isFinal: boolean,
): string {
	return `Implement exactly this approved work item in the current shared workspace.\n\nTask contract:\n${task}\n\nApproved plan:\n${JSON.stringify(plan, null, 2)}\n\nAssigned item:\n${JSON.stringify(item, null, 2)}\n\nPre-existing user-owned baseline:\n${baseline}\n\nDependency receipts:\n${JSON.stringify(dependencies, null, 2)}\n\n${isFinal ? "This is the final work item. After implementation, perform the plan's allowed and proportionate pre-review integration validation, unless repository policy requires it to be skipped." : "Run only allowed focused validation for this item."}\n\nReturn valid JSON only:\n{\n  "workItem": "${item.id}",\n  "changedPaths": ["..."],\n  "decisions": ["..."],\n  "validation": [{"check":"...","outcome":"passed|failed|skipped","reason":"optional"}],\n  "concerns": ["..."]\n}`;
}

const REVIEW_RULES = `
Review rules:
- Confirm scope and distinguish pipeline changes from pre-existing work.
- Stay inside the assigned review lens. Do not repeat concerns owned by another reviewer.
- Inspect the relevant diff, changed files, adjacent code, and call sites needed to prove each finding.
- A must-fix must identify a concrete risk within the assigned lens. Put optional improvements in suggestions.
- Questions are only confidence-blocking evidence gaps. Cite path and line when available. Report no style preferences.
`;

function focusedReviewPrompt(task: string, baseline: string, focus: string, focusStandard: string): string {
	return `Review the current workspace changes with focus on ${focus}.\n\nTask contract:\n${task}\n\nPre-existing user-owned baseline:\n${baseline}\n${REVIEW_RULES}${focusStandard}\nReturn valid JSON only:\n{\n  "mustFixes": [{"key":"stable semantic key without line numbers","title":"...","path":"...","line":1,"impact":"...","direction":"..."}],\n  "suggestions": [{"title":"...","path":"...","reason":"..."}],\n  "questions": ["..."],\n  "summary": "..."\n}\nReturn every substantiated must-fix. Limits: 6 suggestions and 6 questions.`;
}

export function correctnessReviewPrompt(task: string, baseline: string): string {
	const correctnessStandard = `
Correctness and integration lens:
- Trace expected-path values from producer through transformations to consumers and terminal effects.
- Verify requested behavior, state transitions, API/data contracts, compatibility, compilation risks, call sites, dependency wiring, and module/framework integration.
- Report behavior that is wrong on the expected path or fails because a required consumer, registration, or integration step is missing.
- Leave adverse-input handling, concurrency, cleanup, security, accessibility, and regression-test depth to the resilience reviewer.
- Leave abstraction quality, reuse, readability cleanup, and performance to the simplicity reviewer.
`;
	return focusedReviewPrompt(task, baseline, "correctness and integration", correctnessStandard);
}

export function resilienceReviewPrompt(task: string, baseline: string): string {
	const resilienceStandard = `
Resilience lens:
- Inspect null, bounds, parsing, malformed input, partial state, failure, retry, and recovery behavior, including catch-all handling that swallows or obscures failures.
- Inspect concurrency, cancellation, resource cleanup, security, privacy, permissions, sensitive logging, accessibility, and degraded UI states.
- Inspect whether changed behavior has realistic regression coverage, without running tests.
- Report risks that appear under adverse conditions or because required regression coverage is absent.
- Leave expected-path behavior and integration wiring to the correctness reviewer.
- Leave abstraction quality, reuse, readability cleanup, and performance to the simplicity reviewer.
`;
	return focusedReviewPrompt(task, baseline, "tests, security, and resilience", resilienceStandard);
}

export function simplicityReviewPrompt(task: string, baseline: string): string {
	const simplicityStandard = `
Simplicity, performance, and reuse lens:
- Find unnecessary abstractions, generic wrappers, configuration objects, interfaces, or indirection without demonstrated reuse.
- Find one-off helpers that obscure control flow, unnecessarily optional representations, duplicated or derived state, weak type escape hatches, dead branches, and unused fallback paths.
- Find low-information comments and code that duplicates an established repository helper or pattern.
- Find blocking hot-path work, repeated expensive operations, busy waits, quadratic string building, N+1 I/O, and chatty logging.
- Prefer deletion, direct control flow, existing patterns, and the smallest behavior-preserving design. Do not request speculative reuse or broad refactors.
- Report a must-fix only for concrete maintenance, regression, or performance risk caused by the design. Put optional cleanup in suggestions.
- Do not report functional-path bugs, adverse-condition bugs, security/accessibility issues, or missing tests; those belong to the other reviewers.
`;
	return focusedReviewPrompt(task, baseline, "simplicity, code quality, performance, and reuse", simplicityStandard);
}

export function triagePrompt(
	task: string,
	findings: ReviewFinding[],
	batchIndex: number,
	batchCount: number,
): string {
	return `Verify and deduplicate proposed must-fix batch ${batchIndex}/${batchCount} against the current code and task contract. Keep every actionable must-fix supported by repository evidence and preserve stable semantic keys. This is only one processing batch; do not infer that omitted findings were rejected.\n\nTask:\n${task}\n\nFindings:\n${JSON.stringify(findings, null, 2)}\n\nReturn valid JSON only in the normal review shape with every verified finding in mustFixes, empty suggestions unless essential, confidence-blocking questions only, and a concise summary.`;
}

export function fixerPrompt(
	task: string,
	plan: ApprovedPlan,
	findings: ReviewFinding[],
	baseline: string,
	round: number,
	batchIndex: number,
	batchCount: number,
	workItem: string,
): string {
	return `Fix only this verified must-fix batch ${batchIndex}/${batchCount} in review round ${round}. Other batches are handled separately; preserve their changes.\n\nTask contract:\n${task}\n\nApproved plan:\n${JSON.stringify(plan, null, 2)}\n\nMust-fixes:\n${JSON.stringify(findings, null, 2)}\n\nPre-existing user-owned baseline:\n${baseline}\n\nReturn valid JSON only using the implementation receipt shape. Set workItem to "${workItem}". Include at least one validation entry; if no check was allowed or run, use outcome "skipped" and state the exact reason.`;
}

export function verifierPrompt(
	task: string,
	findings: ReviewFinding[],
	round: number,
	batchIndex: number,
	batchCount: number,
): string {
	return `Verify must-fix batch ${batchIndex}/${batchCount} after all fixer batches in review round ${round}. Confirm each exact semantic key against the current workspace, inspect adjacent regressions introduced by the fixes, and report every unresolved or newly introduced must-fix. Do not re-review the entire feature or infer that findings from other batches were rejected.\n\nTask:\n${task}\n\nFinding keys and contracts:\n${JSON.stringify(findings, null, 2)}\n\nReturn valid JSON only in the normal review shape.`;
}
