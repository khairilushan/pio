import type { ApprovedPlan, ReviewFinding, ReviewResult } from "./types.ts";

export const REVIEW_BATCH_SIZE = 10;

export function normalizePlan(value: any): ApprovedPlan {
	if (!value || typeof value.objective !== "string" || !Array.isArray(value.workItems)) {
		throw new Error("Planner response is missing objective or workItems");
	}
	if (value.workItems.length < 1) {
		throw new Error("Planner returned no work items; expected at least 1");
	}
	const workItems = value.workItems.map((item: any, index: number) => {
		if (!item || typeof item.title !== "string" || typeof item.description !== "string") {
			throw new Error(`Planner work item ${index + 1} is malformed`);
		}
		return {
			id: typeof item.id === "string" ? item.id : `W${index + 1}`,
			title: item.title,
			description: item.description,
			files: Array.isArray(item.files) ? item.files.map(String) : [],
			dependencies: Array.isArray(item.dependencies) ? item.dependencies.map(String) : [],
			completionCriteria: Array.isArray(item.completionCriteria) ? item.completionCriteria.map(String) : [],
			validation: Array.isArray(item.validation) ? item.validation.map(String) : [],
		};
	});
	return {
		objective: value.objective,
		workItems,
		assumptions: Array.isArray(value.assumptions) ? value.assumptions.map(String) : [],
	};
}

export function normalizeReview(value: any): ReviewResult {
	const findings: ReviewFinding[] = Array.isArray(value?.mustFixes)
		? value.mustFixes.map((finding: any) => {
				const title = String(finding?.title ?? "Untitled finding");
				const path = typeof finding?.path === "string" ? finding.path : undefined;
				const line = typeof finding?.line === "number" ? finding.line : undefined;
				const suppliedKey = typeof finding?.key === "string" ? finding.key.trim() : "";
				return {
					key: suppliedKey || [path ?? "unknown-path", line ?? "unknown-line", title].join("|"),
					title,
					path,
					line,
					impact: String(finding?.impact ?? "Impact not supplied"),
					direction: String(finding?.direction ?? "Fix direction not supplied"),
				};
			})
		: [];
	return {
		mustFixes: findings,
		suggestions: Array.isArray(value?.suggestions)
			? value.suggestions.map((suggestion: any) => ({
					title: String(suggestion?.title ?? "Suggestion"),
					path: typeof suggestion?.path === "string" ? suggestion.path : undefined,
					reason: String(suggestion?.reason ?? ""),
				}))
			: [],
		questions: Array.isArray(value?.questions) ? value.questions.map(String) : [],
		summary: typeof value?.summary === "string" ? value.summary : "",
	};
}

export function dedupeFindings(findings: ReviewFinding[]): ReviewFinding[] {
	const byKey = new Map<string, ReviewFinding>();
	for (const finding of findings) {
		const key = finding.key.trim().toLowerCase();
		if (!byKey.has(key)) byKey.set(key, finding);
	}
	return [...byKey.values()];
}

export function findingBatches(findings: ReviewFinding[], batchSize = REVIEW_BATCH_SIZE): ReviewFinding[][] {
	if (!Number.isInteger(batchSize) || batchSize < 1) throw new Error("Finding batch size must be a positive integer");
	const batches: ReviewFinding[][] = [];
	for (let index = 0; index < findings.length; index += batchSize) {
		batches.push(findings.slice(index, index + batchSize));
	}
	return batches;
}
