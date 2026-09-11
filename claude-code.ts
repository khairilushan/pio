import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { PioEffort } from "./types.ts";

export interface ClaudeCodeCallbacks {
	onRuntime(model: string | undefined, effort: PioEffort): void;
	onText(text: string): void;
	onToolStart(name: string, input: unknown): void;
	onToolResult(name: string, content: unknown, isError: boolean): void;
	onDiagnostic(summary: string, details?: unknown): void;
}

export interface ClaudeCodeRunOptions {
	executable: string;
	cwd: string;
	model: string;
	effort: PioEffort;
	systemPrompt: string;
	prompt: string;
	tools: string[];
	callbacks: ClaudeCodeCallbacks;
}

function inputMessage(text: string): string {
	return `${JSON.stringify({
		type: "user",
		session_id: "",
		parent_tool_use_id: null,
		message: {
			role: "user",
			content: [{ type: "text", text }],
		},
	})}\n`;
}

function claudeTools(tools: string[]): string[] {
	const mapped = new Set<string>();
	for (const tool of tools) {
		switch (tool) {
			case "read": mapped.add("Read"); break;
			case "grep": mapped.add("Grep"); break;
			case "find":
			case "ls": mapped.add("Glob"); break;
			case "bash": mapped.add("Bash"); break;
			case "edit": mapped.add("Edit"); break;
			case "write": mapped.add("Write"); break;
		}
	}
	return [...mapped];
}

function textParts(content: unknown): string[] {
	if (!Array.isArray(content)) return [];
	return content
		.filter((part): part is { type: "text"; text: string } => part?.type === "text" && typeof part.text === "string")
		.map((part) => part.text);
}

export class ClaudeCodeRun {
	private process?: ChildProcessWithoutNullStreams;
	private settled = false;
	private resultText = "";
	private assistantText = "";
	private inputReady = false;
	private readonly pendingSteering: string[] = [];

	constructor(private readonly options: ClaudeCodeRunOptions) {}

	async run(): Promise<string> {
		const tools = claudeTools(this.options.tools);
		const systemPrompt = `${this.options.systemPrompt}\nFor this Claude Code backend, do not call pio_progress. Instead, state a concise visible progress sentence before each materially different focus.`;
		const args = [
			"-p",
			"--input-format", "stream-json",
			"--output-format", "stream-json",
			"--verbose",
			"--include-partial-messages",
			"--include-hook-events",
			"--replay-user-messages",
			"--forward-subagent-text",
			"--model", this.options.model,
			"--effort", this.options.effort,
			"--dangerously-skip-permissions",
			"--append-system-prompt", systemPrompt,
		];
		if (tools.length > 0) args.push("--tools", tools.join(","));

		return new Promise<string>((resolve, reject) => {
			const child = spawn(this.options.executable, args, {
				cwd: this.options.cwd,
				shell: false,
				stdio: ["pipe", "pipe", "pipe"],
				env: { ...process.env },
			});
			this.process = child;
			let stdoutBuffer = "";
			let stderrBuffer = "";
			let initialSent = false;
			let initialTimer: NodeJS.Timeout | undefined;
			const sendInitial = () => {
				if (initialSent || this.settled || !child.stdin.writable) return;
				initialSent = true;
				child.stdin.write(inputMessage(this.options.prompt));
				this.inputReady = true;
				for (const message of this.pendingSteering.splice(0)) child.stdin.write(inputMessage(message));
			};
			const scheduleInitial = (delayMs: number) => {
				if (initialSent) return;
				if (initialTimer) clearTimeout(initialTimer);
				initialTimer = setTimeout(sendInitial, delayMs);
			};

			const finish = (error?: Error) => {
				if (initialTimer) clearTimeout(initialTimer);
				if (this.settled) return;
				this.settled = true;
				this.process = undefined;
				if (error) reject(error);
				else resolve(this.resultText.trim() || this.assistantText.trim());
			};

			const processLine = (line: string) => {
				if (!line.trim()) return;
				let event: any;
				try {
					event = JSON.parse(line);
				} catch {
					this.options.callbacks.onDiagnostic(line.trim());
					return;
				}
				this.handleEvent(event);
				if (event.type === "result") {
					if (typeof event.result === "string") this.resultText = event.result;
					if (event.is_error || event.subtype === "error") {
						child.stdin.end();
						child.kill("SIGTERM");
						finish(new Error(event.error ?? event.result ?? "Claude Code returned an error"));
					} else {
						child.stdin.end();
					}
				}
			};

			child.stdout.on("data", (data) => {
				stdoutBuffer += data.toString();
				const lines = stdoutBuffer.split("\n");
				stdoutBuffer = lines.pop() ?? "";
				for (const line of lines) processLine(line);
				// Managed wrappers may run startup hooks before Claude begins reading
				// stream-json stdin. Send after startup output has gone briefly quiet.
				scheduleInitial(750);
			});
			child.stderr.on("data", (data) => {
				stderrBuffer += data.toString();
				const lines = stderrBuffer.split("\n");
				stderrBuffer = lines.pop() ?? "";
				for (const line of lines) if (line.trim()) this.options.callbacks.onDiagnostic(line.trim());
			});
			child.on("error", (error) => finish(error));
			child.on("close", (code, signal) => {
				if (stdoutBuffer.trim()) processLine(stdoutBuffer);
				if (stderrBuffer.trim()) this.options.callbacks.onDiagnostic(stderrBuffer.trim());
				if (this.settled) return;
				if (code === 0 && (this.resultText.trim() || this.assistantText.trim())) finish();
				else finish(new Error(`Claude Code exited with code ${code ?? "unknown"}${signal ? ` (${signal})` : ""}`));
			});

			// Plain Claude Code emits no output before its first input, while managed
			// wrappers often do. This fallback covers the plain-CLI case.
			scheduleInitial(2_000);
		});
	}

	async steer(message: string): Promise<void> {
		if (!this.process || this.settled || !this.process.stdin.writable) throw new Error("Claude Code agent is not accepting steering messages.");
		if (!this.inputReady) {
			this.pendingSteering.push(message);
			return;
		}
		await new Promise<void>((resolve, reject) => {
			this.process!.stdin.write(inputMessage(message), (error) => error ? reject(error) : resolve());
		});
	}

	async abort(): Promise<void> {
		const child = this.process;
		if (!child || this.settled) return;
		child.kill("SIGTERM");
		await new Promise<void>((resolve) => {
			const timer = setTimeout(() => {
				child.kill("SIGKILL");
				resolve();
			}, 5_000);
			child.once("close", () => {
				clearTimeout(timer);
				resolve();
			});
		});
	}

	private handleEvent(event: any): void {
		if (event.type === "system" && event.subtype === "init") {
			const model = typeof event.model === "string" ? event.model : undefined;
			this.options.callbacks.onRuntime(model, this.options.effort);
			return;
		}
		if (event.type === "system") {
			if (event.subtype === "thinking_tokens") return;
			const label = event.hook_name ?? event.subtype ?? "system event";
			this.options.callbacks.onDiagnostic(`Claude Code ${label}`, event);
			return;
		}
		if (event.type === "assistant" && event.message) {
			const texts = textParts(event.message.content);
			if (texts.length > 0) {
				this.assistantText = texts.join("\n");
				for (const text of texts) this.options.callbacks.onText(text);
			}
			if (Array.isArray(event.message.content)) {
				for (const part of event.message.content) {
					if (part?.type === "tool_use") this.options.callbacks.onToolStart(String(part.name ?? "tool"), part.input);
				}
			}
			return;
		}
		if (event.type === "user" && Array.isArray(event.message?.content)) {
			for (const part of event.message.content) {
				if (part?.type === "tool_result") {
					this.options.callbacks.onToolResult(String(part.tool_name ?? part.tool_use_id ?? "tool"), part.content, Boolean(part.is_error));
				}
			}
			return;
		}
		if (event.type === "result") {
			const model = typeof event.model === "string"
				? event.model
				: event.modelUsage && typeof event.modelUsage === "object"
					? Object.keys(event.modelUsage)[0]
					: undefined;
			if (model) this.options.callbacks.onRuntime(model, this.options.effort);
			this.options.callbacks.onDiagnostic("Claude Code result", {
				durationMs: event.duration_ms,
				durationApiMs: event.duration_api_ms,
				numTurns: event.num_turns,
				totalCostUsd: event.total_cost_usd,
				usage: event.usage,
				modelUsage: event.modelUsage,
			});
		}
	}
}
