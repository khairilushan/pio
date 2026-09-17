import { Box, Container, Text, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { Activity, RunState } from "./types.ts";

export function createDashboard(run: () => RunState | undefined, requestRender: () => void) {
	return {
		render(width: number): string[] {
			const current = run();
			if (!current || current.status === "completed" || current.status === "failed" || current.status === "aborted") return [];
			const active = current.agents.filter((agent) => agent.status === "running");
			const recentlyCompleted = current.agents.filter((agent) => agent.status !== "running").slice(-2);
			const lines = [`PIO ${current.phase}/7 · ${current.phaseLabel} · ${current.status}`];
			if (current.pendingDecision) lines.push(`  ? ${current.pendingDecision.question}`);
			for (const agent of active) {
				const runtime = [agent.backend, agent.model, agent.effort ? `${agent.effort} effort` : undefined].filter(Boolean).join(" · ");
				lines.push(`  ▶ ${agent.role} · ${agent.label}${runtime ? ` [${runtime}]` : ""} — ${agent.focus}`);
				if (agent.lastActivity && agent.lastActivity !== agent.focus) lines.push(`      ${agent.lastActivity}`);
			}
			for (const agent of recentlyCompleted) {
				const icon = agent.status === "completed" ? "✓" : agent.status === "failed" ? "✗" : "■";
				const runtime = [agent.backend, agent.model, agent.effort ? `${agent.effort} effort` : undefined].filter(Boolean).join(" · ");
				lines.push(`  ${icon} ${agent.role} · ${agent.label}${runtime ? ` [${runtime}]` : ""}`);
			}
			if (active.length === 0 && recentlyCompleted.length === 0) lines.push("  Preparing orchestration…");
			return lines.flatMap((line) => wrapTextWithAnsi(line, Math.max(1, width))).map((line) => truncateToWidth(line, width));
		},
		invalidate() {
			requestRender();
		},
	};
}

export function renderActivityEntry(activity: Activity & { role?: string }, expanded: boolean, theme: any) {
	const icon: Record<Activity["kind"], string> = {
		phase: "◆",
		prompt: "→",
		focus: "▶",
		text: "·",
		tool: "⚙",
		"tool-result": "↳",
		steer: "⇢",
		decision: "?",
		error: "✗",
		complete: "✓",
	};
	const color = activity.kind === "error" ? "error" : activity.kind === "complete" ? "success" : activity.kind === "decision" ? "warning" : "accent";
	const box = new Box(1, 0, (text) => theme.bg("customMessageBg", text));
	const label = activity.role ? `${activity.role} · ` : "";
	box.addChild(new Text(`${theme.fg(color, icon[activity.kind])} ${theme.fg("muted", label)}${activity.summary}`, 0, 0));
	if (expanded && activity.details) {
		box.addChild(new Text(theme.fg("dim", typeof activity.details === "string" ? activity.details : JSON.stringify(activity.details, null, 2)), 0, 0));
	}
	return box;
}

export function buildLogComponent(run: RunState, agentId: string | undefined, theme: any, done: () => void) {
	const activities = agentId ? run.activities.filter((activity) => activity.agentId === agentId) : run.activities;
	const container = new Container();
	container.addChild(new Text(theme.fg("accent", theme.bold(`PIO activity · ${agentId ?? run.id}`)), 1, 0));
	container.addChild(new Text(theme.fg("dim", "Esc closes · showing complete retained activity history"), 1, 0));
	for (const activity of activities) {
		const time = new Date(activity.timestamp).toLocaleTimeString();
		container.addChild(new Text(`${theme.fg("dim", time)} ${activity.summary}`, 1, 0));
		if (activity.details) {
			container.addChild(new Text(theme.fg("dim", typeof activity.details === "string" ? activity.details : JSON.stringify(activity.details, null, 2)), 3, 0));
		}
	}
	return {
		render: (width: number) => container.render(width),
		invalidate: () => container.invalidate(),
		handleInput: (data: string) => {
			if (data === "\u001b") done();
		},
	};
}
