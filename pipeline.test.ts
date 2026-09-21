import assert from "node:assert/strict";
import test from "node:test";
import { findingBatches, normalizePlan, normalizeReview, REVIEW_BATCH_SIZE } from "./pipeline.ts";

function workItems(count: number) {
	return Array.from({ length: count }, (_, index) => ({
		id: `W${index + 1}`,
		title: `Item ${index + 1}`,
		description: `Implement item ${index + 1}`,
	}));
}

function findings(count: number) {
	return Array.from({ length: count }, (_, index) => ({
		key: `finding-${index + 1}`,
		title: `Finding ${index + 1}`,
		impact: `Impact ${index + 1}`,
		direction: `Direction ${index + 1}`,
	}));
}

test("normalizePlan accepts and preserves more than five coherent work items", () => {
	const plan = normalizePlan({
		objective: "Complete a task that has six independent ordered changes",
		workItems: workItems(6),
		assumptions: [],
	});

	assert.equal(plan.workItems.length, 6);
	assert.deepEqual(plan.workItems.map((item) => item.id), ["W1", "W2", "W3", "W4", "W5", "W6"]);
});

test("normalizePlan still rejects a plan with no executable work", () => {
	assert.throws(
		() => normalizePlan({ objective: "Nothing", workItems: [] }),
		/expected at least 1/,
	);
});

test("normalizeReview preserves every must-fix, suggestion, and question", () => {
	const mustFixes = findings(17);
	const suggestions = Array.from({ length: 9 }, (_, index) => ({ title: `Suggestion ${index + 1}`, reason: "Material" }));
	const questions = Array.from({ length: 8 }, (_, index) => `Question ${index + 1}`);
	const review = normalizeReview({ mustFixes, suggestions, questions, summary: "Complete review" });

	assert.equal(review.mustFixes.length, mustFixes.length);
	assert.equal(review.suggestions.length, suggestions.length);
	assert.equal(review.questions.length, questions.length);
});

test("findingBatches bounds each agent batch without dropping or reordering findings", () => {
	const allFindings = normalizeReview({ mustFixes: findings(2 * REVIEW_BATCH_SIZE + 3) }).mustFixes;
	const batches = findingBatches(allFindings);

	assert.deepEqual(batches.map((batch) => batch.length), [REVIEW_BATCH_SIZE, REVIEW_BATCH_SIZE, 3]);
	assert.deepEqual(batches.flat().map((finding) => finding.key), allFindings.map((finding) => finding.key));
});
