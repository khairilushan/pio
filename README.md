# PIO: Pi Orchestrator

PIO is a [Pi](https://github.com/earendil-works/pi) extension that uses fresh subagents to plan, implement, review, and fix coding tasks.

PIO runs in the background, so the main Pi session remains available. It does not create Git worktrees or other filesystem sandboxes. All agents use the current working tree.

## Features

- Repository-aware context gathering and plan review
- Sequential implementation agents
- Two independent read-only reviewers running in parallel
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
| 5 | Implement up to five work items in order |
| 6 | Run two reviews, triage findings, and apply up to three fix rounds |
| 7 | Inspect the workspace and write the final report |

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

Example:

```json
{
  "backend": "auto",
  "claudeCodeExecutable": "claude",
  "defaults": { "effort": "high" },
  "roles": {
    "planner": {
      "backend": "claude-code",
      "model": "opus"
    },
    "writer": {
      "backend": "pi",
      "provider": "openai-codex",
      "model": "gpt-5.6-terra"
    }
  }
}
```

`defaults` applies to every role, and a role entry overrides it. Roles are `context`, `planner`, `critic`, `plan-reviser`, `writer`, `reviewer-correctness`, `reviewer-resilience`, `review-triage`, `fixer`, and `verifier`.

Backends are `auto`, `pi`, and `claude-code`. Efforts are `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`. Claude model names are passed to Claude Code. Pi models must be available to Pi's model registry.

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
npm run typecheck
pi -e ./index.ts
```

## License

MIT
