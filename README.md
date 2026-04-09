# OpenCode Claude CLI

[![npm](https://img.shields.io/npm/v/opencode-claude-cli?style=flat-square&logo=npm&labelColor=4a4a4a&color=e03131)](https://www.npmjs.com/package/opencode-claude-cli)

Use OpenCode with Claude Code as a provider.

## Install

```bash
npm install -g opencode-claude-cli
```

## Configure

`~/.config/opencode/opencode.json`

```json
{
  "plugin": ["opencode-claude-cli"]
}
```

## Setup

1. Make sure Claude Code is installed and logged in:
   ```bash
   claude auth login
   ```
2. Restart OpenCode.
3. Run `/connect` and choose `Claude Code`.

## Models

- `claude-opus-4-6`
- `claude-sonnet-4-6`
- `claude-haiku-4-5`

> [!NOTE]
>
> - Uses your local Claude Code login.
> - Requests are routed through the local `claude` CLI, not Anthropic API.
> - Tool execution happens inside Claude Code's harness.
> - OpenCode sessions are mapped to Claude Code sessions.

## Features

- OpenCode plan mode is mapped to Claude Code plan mode.
- Claude Code responses stream live into OpenCode.
- Image and PDF uploads are forwarded to Claude Code.
- Claude tool activity is shown in OpenCode as display-only transcript text.
- Multiple Claude Code sessions can run concurrently because OpenCode sessions are mapped independently.
- `/fork` and `/export` work as expected with claude code models.

## Limitations

- **Permissions are not interactive**: This plugin always runs Claude Code with `--dangerously-skip-permissions`.
- **MCP servers are Claude-side**: Claude Code uses its own MCP servers (for example from `~/.claude/settings.json`), not the ones configured in OpenCode.
- **Tool execution is Claude-side**: OpenCode built-in tool execution, permission prompts, and tool UI are not the source of truth for Claude Code requests.
- **Tool rendering is approximate**: Tool activity is displayed as text in OpenCode, it is not rendered as native OpenCode tool execution events.
- **Custom modes are not mapped**: OpenCode custom modes are not mapped to Claude Code.
- **Claude Code slash-command compatibility is partial**: Some `/` commands may not work as exepected.

## Permission behavior

- Claude Code always runs with `--dangerously-skip-permissions`.
- OpenCode plan mode is automatically mapped to Claude Code plan (read-only) mode.

## Troubleshooting

- **`Claude Code was not found on PATH`**: install the `claude` CLI or set `OPENCODE_CLAUDE_CLI_PATH`.
- **`Claude Code is not logged in`**: run `claude auth login`.
- **`/connect` succeeds but requests fail**: restart OpenCode after changing plugin config or Claude login state.
- **Need plugin debug logs?** Start OpenCode with `OPENCODE_CLAUDE_CLI_DEBUG=1`.

## License

MIT
