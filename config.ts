import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import type { PioBackend, PioConfig, PioConfigInput, PioEffort, PioRole, RoleModelConfig } from "./types.ts";

export const PIO_ROLES: PioRole[] = [
	"context",
	"planner",
	"critic",
	"plan-reviser",
	"writer",
	"reviewer-correctness",
	"reviewer-resilience",
	"reviewer-simplicity",
	"review-triage",
	"fixer",
	"verifier",
];

const BACKENDS = new Set<PioBackend>(["auto", "pi", "claude-code"]);
const EFFORTS = new Set<PioEffort>(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

export const BUILTIN_CONFIG: PioConfigInput = {
	backend: "auto",
	provider: "openai-codex",
	claudeCodeExecutable: "claude",
	defaults: { effort: "high" },
	roles: {
		context: { effort: "high" },
		planner: { effort: "high" },
		critic: { effort: "high" },
		"plan-reviser": { effort: "high" },
		writer: { effort: "high" },
		"reviewer-correctness": { effort: "high" },
		"reviewer-resilience": { effort: "high" },
		"reviewer-simplicity": { effort: "high" },
		"review-triage": { effort: "high" },
		fixer: { effort: "high" },
		verifier: { effort: "high" },
	},
};

export function defaultModelFor(role: PioRole, backend: "pi" | "claude-code"): string {
	if (backend === "claude-code") {
		if (role === "context") return "haiku";
		if (role === "writer" || role === "fixer") return "claude-sonnet-4-6";
		return "claude-opus-4-8";
	}
	if (role === "context") return "gpt-5.6-luna";
	if (role === "writer" || role === "fixer") return "gpt-5.6-terra";
	return "gpt-5.6-sol";
}

function assertString(value: unknown, path: string): string | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "string" || value.trim() === "") throw new Error(`${path} must be a non-empty string.`);
	return value.trim();
}

function parseBackend(value: unknown, path: string): PioBackend | undefined {
	const backend = assertString(value, path) as PioBackend | undefined;
	if (backend && !BACKENDS.has(backend)) throw new Error(`${path} must be one of: ${[...BACKENDS].join(", ")}.`);
	return backend;
}

function parseRoleConfig(value: unknown, path: string): RoleModelConfig {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${path} must be an object.`);
	const raw = value as Record<string, unknown>;
	for (const key of Object.keys(raw)) {
		if (!["backend", "provider", "model", "effort"].includes(key)) throw new Error(`Unknown ${path} key: ${key}`);
	}
	const effort = assertString(raw.effort, `${path}.effort`) as PioEffort | undefined;
	if (effort && !EFFORTS.has(effort)) throw new Error(`${path}.effort must be one of: ${[...EFFORTS].join(", ")}.`);
	return {
		backend: parseBackend(raw.backend, `${path}.backend`),
		provider: assertString(raw.provider, `${path}.provider`),
		model: assertString(raw.model, `${path}.model`),
		effort,
	};
}

function parseConfig(value: unknown, source: string): PioConfigInput {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${source} must contain a JSON object.`);
	const raw = value as Record<string, unknown>;
	for (const key of Object.keys(raw)) {
		if (!["backend", "provider", "claudeCodeExecutable", "defaults", "roles"].includes(key)) {
			throw new Error(`Unknown key in ${source}: ${key}`);
		}
	}
	const roles: PioConfigInput["roles"] = {};
	if (raw.roles !== undefined) {
		if (!raw.roles || typeof raw.roles !== "object" || Array.isArray(raw.roles)) throw new Error(`${source}.roles must be an object.`);
		for (const [role, config] of Object.entries(raw.roles as Record<string, unknown>)) {
			if (!PIO_ROLES.includes(role as PioRole)) throw new Error(`Unknown PIO role in ${source}: ${role}`);
			roles[role as PioRole] = parseRoleConfig(config, `${source}.roles.${role}`);
		}
	}
	return {
		backend: parseBackend(raw.backend, `${source}.backend`),
		provider: assertString(raw.provider, `${source}.provider`),
		claudeCodeExecutable: assertString(raw.claudeCodeExecutable, `${source}.claudeCodeExecutable`),
		defaults: raw.defaults === undefined ? undefined : parseRoleConfig(raw.defaults, `${source}.defaults`),
		roles,
	};
}

function merge(base: PioConfigInput, override: PioConfigInput): PioConfigInput {
	const roles: PioConfigInput["roles"] = { ...(base.roles ?? {}) };
	for (const role of PIO_ROLES) {
		const next = override.roles?.[role];
		if (next) roles[role] = { ...(roles[role] ?? {}), ...next };
	}
	return {
		backend: override.backend ?? base.backend,
		provider: override.provider ?? base.provider,
		claudeCodeExecutable: override.claudeCodeExecutable ?? base.claudeCodeExecutable,
		defaults: { ...(base.defaults ?? {}), ...(override.defaults ?? {}) },
		roles,
	};
}

async function readConfig(path: string): Promise<PioConfigInput | undefined> {
	try {
		return parseConfig(JSON.parse(await readFile(path, "utf8")), path);
	} catch (error: any) {
		if (error?.code === "ENOENT") return undefined;
		if (error instanceof SyntaxError) throw new Error(`Invalid JSON in ${path}: ${error.message}`);
		throw error;
	}
}

function resolveConfig(input: PioConfigInput): PioConfig {
	const backend = input.backend ?? "auto";
	const provider = input.provider ?? "openai-codex";
	const defaults = {
		backend: input.defaults?.backend ?? backend,
		provider: input.defaults?.provider ?? provider,
		model: input.defaults?.model,
		effort: input.defaults?.effort ?? "high",
	};
	const roles = {} as PioConfig["roles"];
	for (const role of PIO_ROLES) {
		const roleConfig = input.roles?.[role] ?? {};
		roles[role] = {
			backend: roleConfig.backend ?? defaults.backend,
			provider: roleConfig.provider ?? defaults.provider,
			model: roleConfig.model ?? defaults.model,
			effort: roleConfig.effort ?? defaults.effort,
		};
	}
	return {
		backend,
		provider,
		claudeCodeExecutable: input.claudeCodeExecutable ?? "claude",
		defaults,
		roles,
	};
}

export async function loadPioConfig(
	cwd: string,
	projectTrusted: boolean,
	runOverride?: PioConfigInput,
): Promise<{ config: PioConfig; sources: string[] }> {
	let merged = BUILTIN_CONFIG;
	const sources = ["PIO built-in defaults"];
	const globalPath = join(getAgentDir(), "pio.json");
	const globalConfig = await readConfig(globalPath);
	if (globalConfig) {
		merged = merge(merged, globalConfig);
		sources.push(globalPath);
	}
	const projectPath = join(cwd, CONFIG_DIR_NAME, "pio.json");
	if (projectTrusted) {
		const projectConfig = await readConfig(projectPath);
		if (projectConfig) {
			merged = merge(merged, projectConfig);
			sources.push(projectPath);
		}
	}
	if (runOverride) {
		merged = merge(merged, parseConfig(runOverride, "per-run PIO override"));
		sources.push("per-run override");
	}
	return { config: resolveConfig(merged), sources };
}
