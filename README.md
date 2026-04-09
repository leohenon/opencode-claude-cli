# OpenCode Claude CLI

Use OpenCode with the local official `claude` CLI as the backend harness.

## What it does

This plugin registers a dedicated OpenCode provider named `Claude Code CLI` and, instead of sending requests to Anthropic HTTP APIs, runs the local Claude Code CLI in headless mode:

```bash
claude -p ... --output-format json
```

That means the actual agent loop and tool execution happen inside Claude Code.

## Install

```bash
npm i -g /Users/leohenon/dev/opencode-claude-cli
```

Then add it to your OpenCode config:

```json
{
  "plugin": ["opencode-claude-cli"]
}
```

## Requirements

- `claude` installed on `PATH`
- already logged in: `claude auth login`
- OpenCode launched in the project you want Claude Code to operate on

## Enable

You can use either approach:

### Option A: env-toggle, no connect flow

```bash
export OPENCODE_CLAUDE_CLI_ENABLE=1
```

### Option B: connect inside OpenCode

Run `/connect` and choose:

- `Claude Code CLI`

Or use the direct auth command:

```bash
opencode auth login -p claude-code-cli
```

## Optional env vars

- `OPENCODE_CLAUDE_CLI_PATH`
- `OPENCODE_CLAUDE_CLI_MODEL`
- `OPENCODE_CLAUDE_CLI_PERMISSION_MODE`
- `OPENCODE_CLAUDE_CLI_ALLOWED_TOOLS`
- `OPENCODE_CLAUDE_CLI_DANGEROUSLY_SKIP_PERMISSIONS=1`
- `OPENCODE_CLAUDE_CLI_MAX_TURNS`
- `OPENCODE_CLAUDE_CLI_APPEND_SYSTEM_PROMPT`

## Notes

- This is not a raw API impersonation proxy.
- It adapts OpenCode requests into Claude CLI headless calls.
- `Claude Code CLI` is exposed as its own provider so it can appear in `/connect` without competing with the built-in Anthropic auth flow.
- Streaming is compatibility-oriented right now: it emits a single final text delta in Anthropic SSE form.
- Session persistence mapping is not implemented yet.

## Build

```bash
npm install
npm run build
```
