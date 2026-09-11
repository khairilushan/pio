# PIO — Pi Orchestrator

PIO is a [Pi](https://github.com/earendil-works/pi) extension that plans, implements, reviews, and fixes coding tasks with isolated subagents.

It runs in the background while your main Pi session stays available.

## Features

- Repository-aware planning and plan review
- Sequential writer agents for implementation
- Two independent reviewers running in parallel
- Automatic triage, fix, and verification rounds
- Live phase, agent, model, tool, and progress visibility
- Steering while an agent is running
- Pi child-session and Claude Code process backends
- A concise final report with the revised plan, findings, fix status, and validation notes

PIO shares the current working tree with its workers. It never commits, pushes, publishes, or opens pull requests.

## Install

From GitHub:

```sh
pi install git:github.com/YOUR_USERNAME/pio
```

From a local clone:

```sh
git clone https://github.com/YOUR_USERNAME/pio.git
pi install ./pio
```

Restart Pi or run `/reload`.

## Use

Open Pi inside a Git repository:

```text
/pio Add pagination to search results and cover the changed behavior
```

PIO gathers context, creates and critiques a plan, implements it, reviews the changes, fixes confirmed findings, and produces a final report.

Backends and models are selected from configuration for each role. Without role overrides, PIO uses Pi child sessions: a Pi session using Claude passes that exact model to its children, while a Pi session using an OpenAI model uses PIO's role-specific OpenAI defaults.

Only one run can be active because all workers share the same working tree.

### Commands

| Command | Purpose |
|---|---|
| `/pio <task>` | Start using the configured role backends and models |
| `/pio-status` | Show progress and active agents |
| `/pio-steer` | Send an instruction to a running agent |
| `/pio-answer <answer>` | Answer a blocking question |
| `/pio-abort` | Stop the run |
| `/pio-log` | Inspect activity by agent role |
| `/pio-report` | Reopen the final report |

## Backends

PIO uses isolated Pi child sessions by default. Each role uses its configured model, or falls back to Pi's active model when necessary.

To run a role through the external Claude Code CLI, set its backend to `claude-code`. Claude Code must already be installed, authenticated, and available on `PATH`.

Roles are configured independently, so you can mix backends—for example, a Claude Code planner with a GPT writer running in Pi.

> **Warning:** Claude Code workers use `--dangerously-skip-permissions`. They can edit files and run commands without permission prompts. Use this only in environments you trust.

## Configuration

Configuration is optional. Use either:

- `~/.pi/agent/pio.json` for global settings
- `.pi/pio.json` for settings in a trusted project

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

Backends are `auto`, `pi`, and `claude-code`. Model names are passed directly to the selected runtime and are not allowlisted.

## Final report

A completed run reports:

- The final revised plan
- All review findings and their fix status
- Suggestions and open questions
- Failed or skipped validation
- Unresolved issues and important caveats

Use `/pio-report` to show it again in the same session.

## Development

```sh
npm install
npm run typecheck
pi -e ./index.ts
```

## License

MIT
