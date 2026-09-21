# PIO: Pi Orchestrator

PIO is a [Pi](https://github.com/earendil-works/pi) extension that uses fresh subagents to plan, implement, review, and fix coding tasks.

PIO runs in the background, so the main Pi session remains available. It does not create Git worktrees or other filesystem sandboxes. All agents use the current working tree.

## Features

- Repository-aware context gathering and plan review
- Sequential implementation agents
- Three independent read-only reviewers running in parallel
- Automatic finding triage, fix rounds, and read-only verification
- Live phase, agent, model, tool, and progress status
- Steering and answers for running or paused agents
- Pi child-session and Claude Code process backends
- A final report with the plan, findings, validation results, and open issues

PIO does not automatically commit, push, publish, or open pull requests. Agents are instructed not to do so. Only one run can be active per Pi session.

## Requirements

- Pi
- Node.js 22.19 or later
- An authenticated Pi model provider
- Claude Code installed, authenticated, and on `PATH` when using the `claude-code` backend

## Install

From GitHub:

```sh
pi install git:github.com/khairilushan/pio
```

From a local clone:

```sh
git clone https://github.com/khairilushan/pio.git
pi install ./pio
```

Restart Pi or run `/reload`.

## Use

Run Pi in the project directory:

```text
/pio Add pagination to search results and cover the changed behavior
```

The task can be plain text or a reference to material available in the working tree. PIO does not provide a Jira or other remote task-source integration.

PIO gathers context, creates and critiques a plan, implements its work items in order, reviews the changes, fixes confirmed findings, and writes a final report.

### Commands

| Command | Purpose |
|---|---|
| `/pio <task>` | Start a run using the configured role backends and models |
| `/pio-status` | Show the current phase and active agents |
| `/pio-steer` | Send an instruction to a running agent |
| `/pio-answer <answer>` | Answer a question that paused the run |
| `/pio-abort` | Stop the run and its active agents |
| `/pio-log` | Inspect retained activity by agent role |
| `/pio-report` | Show the final report again |

Run state and activity are kept in memory for the current Pi session. Reports are not persisted by PIO.

## Pipeline

| Phase | Work |
|---|---|
| 1 | Record task and workspace state |
| 2 | Gather read-only repository context |
| 3 | Create an implementation plan |
| 4 | Critique and approve the plan |
| 5 | Implement every approved work item in order, one writer at a time |
| 6 | Run three reviews, triage findings, and apply up to three fix rounds |
| 7 | Inspect the workspace and write the final report |

The three initial reviewers use intentionally separate lenses:

| Role | Exclusive focus |
|---|---|
| `reviewer-correctness` | Expected-path behavior, data/API contracts, consumers, compilation, and integration wiring |
| `reviewer-resilience` | Adverse inputs and states, failures, concurrency, cleanup, security, accessibility, and regression coverage |
| `reviewer-simplicity` | Abstraction and state complexity, dead code, existing-pattern reuse, and performance design |

Their prompts explicitly tell them not to report concerns owned by another lens. They run concurrently; if any reviewer reports must-fixes, `review-triage` verifies and deduplicates them before a fixer is allowed to edit the workspace.

PIO never truncates must-fixes. It retains and reports every finding, while triage, fixing, and verification process them sequentially in batches of ten to keep each agent prompt focused. Fixing still stops after three rounds; anything remaining is retained and reported as unresolved rather than discarded. Suggestions, questions, validation skips, and receipt concerns are also retained rather than count-capped.

There is no maximum plan work-item count. The planner is asked for the smallest cohesive plan, but a valid larger plan is accepted and every item is implemented sequentially. This keeps writer concurrency at one and avoids discarding a sound plan solely because of its decomposition.

### Limit and safety inventory

| Limit or control | Classification | Behavior and rationale |
|---|---|---|
| Plan work-item maximum | **Unnecessary — removed** | Plans still require at least one well-formed item, but no arbitrary maximum is enforced. Every accepted item receives a writer pass and a completion-gate receipt check. |
| Active runs | **Safety-essential** | One run may be active per Pi session because agents share one working tree. A second run fails visibly instead of creating competing edits. |
| Writer concurrency | **Safety-essential** | Exactly one writer runs at a time because all agents share one working tree. Larger plans consume more sequential calls, not more concurrent resources. |
| Initial reviewer count/concurrency | **Safety-essential** | The three fixed, non-overlapping review lenses run concurrently; later triage, fixer, and verifier batches run sequentially. Peak pipeline concurrency therefore remains three. |
| Must-fixes per triage/fix/verify call | **Gracefully batchable** | Batches contain ten findings. All batches are processed in order and flattened without count truncation. Semantic-key deduplication merges the same finding; it is not a count cap. |
| Fix rounds | **Safety-essential** | Three rounds bound repeated autonomous edits and model cost. Findings that remain after the final round are explicitly retained as unresolved and included in the report. |
| Planner/critic format attempts | **Safety-essential** | Each gets one format retry. Exhaustion fails visibly instead of looping forever or silently accepting malformed JSON. |
| Transient agent retry | **Safety-essential** | A transient backend failure gets one fresh-agent retry; persistent failure stops visibly. This bounds duplicate calls and edits. |
| Suggestions, questions, validation skips, and concerns | **Unnecessary count caps — removed** | Normalization and final reporting preserve every returned entry. Prompts still ask agents to stay concise and material. |
| In-memory activity history | **Safety-essential** | The latest 2,000 entries per run and per agent are retained to bound session memory. `/pio-log` explicitly reports how many older entries were omitted; normal Pi activity entries are still appended as they occur. |
| Activity detail and dashboard presentation | **Safety-essential presentation bounds** | Large detail payloads are clipped at 12,000 characters with an explicit omitted-character marker, progress summaries are limited to 240 characters, and the live dashboard shows only the two most recently completed agents. Full agent records and retained logs remain available; these display bounds do not alter plans, receipts, findings, or final-report data. |

## Backends and models

PIO uses Pi child sessions by default. `auto` currently resolves to the Pi backend; it does not detect Claude Code automatically.

Each role has its own backend, provider, model, and effort. Without a model override, a non-OpenAI Pi session passes its active model to child sessions. OpenAI sessions use PIO's role defaults. If a configured Pi model is unavailable, PIO may fall back to another available model and record that in the final report. Pi may also clamp the requested effort level.

To use Claude Code for a role, set its backend to `claude-code`. Claude Code workers run with `--dangerously-skip-permissions`, so they can edit files and run commands without permission prompts. Use this only in a trusted environment. Pi writer and fixer workers can also edit files and run commands.

## Configuration

Configuration is optional. PIO loads these sources in order, with later values taking precedence:

1. Built-in defaults
2. `~/.pi/agent/pio.json`
3. `.pi/pio.json` in a trusted project
4. A per-run `config` override supplied to the `pio` tool

The project file is ignored when the project is not trusted. Configuration files must contain valid JSON.

### Complete multi-provider example

The following file customizes every role and uses provider/model identifiers from Pi 0.85.1's built-in catalog. It also uses the `fable`, `opus`, and `sonnet` model aliases accepted by Claude Code, which resolve to the latest versions available to that CLI and account.

```json
{
  "backend": "pi",
  "provider": "openai-codex",
  "claudeCodeExecutable": "claude",
  "defaults": {
    "backend": "pi",
    "provider": "openai-codex",
    "model": "gpt-6-astra",
    "effort": "high"
  },
  "roles": {
    "context": {
      "backend": "pi",
      "provider": "google",
      "model": "gemini-3.8-flash",
      "effort": "high"
    },
    "planner": {
      "backend": "claude-code",
      "model": "opus",
      "effort": "max"
    },
    "critic": {
      "backend": "pi",
      "provider": "xai",
      "model": "grok-4.6",
      "effort": "xhigh"
    },
    "plan-reviser": {
      "backend": "claude-code",
      "model": "fable",
      "effort": "max"
    },
    "writer": {
      "backend": "pi",
      "provider": "openai-codex",
      "model": "gpt-6-astra",
      "effort": "max"
    },
    "reviewer-correctness": {
      "backend": "pi",
      "provider": "opencode",
      "model": "deepseek-v4-pro",
      "effort": "max"
    },
    "reviewer-resilience": {
      "backend": "pi",
      "provider": "opencode",
      "model": "kimi-k3",
      "effort": "max"
    },
    "reviewer-simplicity": {
      "backend": "pi",
      "provider": "opencode",
      "model": "claude-opus-5",
      "effort": "max"
    },
    "review-triage": {
      "backend": "pi",
      "provider": "opencode",
      "model": "glm-5.3",
      "effort": "high"
    },
    "fixer": {
      "backend": "claude-code",
      "model": "sonnet",
      "effort": "high"
    },
    "verifier": {
      "backend": "pi",
      "provider": "opencode",
      "model": "gpt-6-astra",
      "effort": "max"
    }
  }
}
```

These are real identifiers known by the bundled Pi catalog:

| Service | PIO backend | Provider | Model identifiers shown above |
|---|---|---|---|
| Google Gemini | `pi` | `google` | `gemini-3.8-flash` |
| xAI Grok | `pi` | `xai` | `grok-4.6` |
| ChatGPT/Codex | `pi` | `openai-codex` | `gpt-6-astra` |
| OpenCode Zen | `pi` | `opencode` | `claude-opus-5`, `deepseek-v4-pro`, `kimi-k3`, `glm-5.3`, `gpt-6-astra` |
| Claude Code | `claude-code` | not used | `fable` (Fable 5 family), `opus`, `sonnet` |

The example only works when every selected service is authenticated. Configure Google with `GEMINI_API_KEY` or `/login`, xAI with `XAI_API_KEY` or `/login xai`, ChatGPT/Codex through `/login`, OpenCode Zen with `OPENCODE_API_KEY` or `/login`, and Claude Code through its own login. You may remove or replace roles for services you do not use. Run `pi --list-models <search>` after authentication to confirm that a Pi-backed model is currently available; PIO falls back to the parent model when a configured Pi model is unavailable.

Model catalogs evolve. The fixed identifiers above are verified against Pi 0.85.1. For a moving Gemini alias, Pi also knows `google` / `gemini-flash-latest`. For direct OpenAI API authentication, Pi knows `openai` / `gpt-6-astra` in addition to the `openai-codex` pairing used above.

`defaults` applies to every role, and a role entry overrides it. Roles are `context`, `planner`, `critic`, `plan-reviser`, `writer`, `reviewer-correctness`, `reviewer-resilience`, `reviewer-simplicity`, `review-triage`, `fixer`, and `verifier`.

Backends are `auto`, `pi`, and `claude-code`. Efforts are `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`. Claude model names are passed to Claude Code; its currently accepted effort values are `low`, `medium`, `high`, `xhigh`, and `max`. Pi models must be available to Pi's model registry, and Pi may clamp unsupported effort levels.

## Working tree and validation

Agents share the current working tree. PIO does not make a snapshot or undo changes. Writer and fixer agents may edit files; context, planning, critic, reviewer, triage, and verifier agents are read-only. Avoid editing the same files from the main session while a run is active.

A `completed` run means the pipeline finished, not that every check passed. Writer and fixer agents report allowed focused validation. Reviewers and verifiers do not run builds, tests, linters, apps, or snapshots. Read the final report for failed or skipped validation and unresolved findings. Suggestions are reported but are not applied automatically.

## Final report

A completed run reports:

- The final revised plan
- Review findings and their status
- Suggestions and open questions
- Failed or skipped validation
- Unresolved issues and important caveats

Use `/pio-report` to show it again during the same Pi session.

## Development

```sh
npm install
npm test
npm run typecheck
pi -e ./index.ts
```

## License

MIT
