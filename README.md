<p align="center">
  <img src="https://raw.githubusercontent.com/Pimmawat/Nod/main/assets/icon.png" width="128" height="128" alt="Nod logo">
</p>

<h1 align="center">Nod</h1>

<p align="center">
  <strong>Alerts and Auto Approve for Codex and Claude Code, right in your IDE</strong>
</p>

Nod is a VS Code (and VSIX-compatible IDE) extension that plays a sound and shows a notification when Codex or Claude Code requests tool permission or asks a question. It connects through each agent's native hooks, runs locally only, and has no telemetry.

## Supported events

| Event | Sound & Notification | Auto Approve |
| --- | :---: | :---: |
| Tool permission request (`PermissionRequest`) | ✓ | ✓ for configured tools |
| Codex `request_user_input` / `request_user_input_async` | ✓ (via `PreToolUse`) | — |
| Claude Code `AskUserQuestion` | ✓ | — |
| Plain-text questions in chat | — | — |

> [!IMPORTANT]
> Auto Approve is **on by default** after a 3-second delay for Codex `Bash`, `exec_command`, `apply_patch` and Claude Code `Bash`, `Edit`, `Write`. Matching is by **tool name only** — command contents are not inspected. For alerts only, set `agentAlert.autoApprove.enabled` to `false` right after installing.

## Requirements

- VS Code or a compatible IDE with Extension API `1.96.2`+
- Node.js `18`+ on the IDE's `PATH`
- Codex extension (`openai.chatgpt`) and/or Claude Code extension (`anthropic.claude-code`)

## Installation

1. In **Extensions**, choose `…` → **Install from VSIX…** and select `agent-alert-0.6.0.vsix`.
2. Open a local project folder and trust the workspace.
3. Nod sets up hooks automatically. Start a new agent session.
4. For Codex, review and trust the new hook in Codex or via `/hooks`.

To verify, click **Nod** in the status bar and run **Test sound**, a **Test … notification**, then **Connection status** after triggering a real tool call from the agent.

## Agent setup

Hooks are merged into existing configuration (a backup is created first):

- **Claude Code:** `~/.claude/settings.json` (or `CLAUDE_CONFIG_DIR` / `agentAlert.claudeHome`). If `disableAllHooks` is on, enable hooks first.
- **Codex:** `~/.codex/hooks.json` (or `CODEX_HOME` / `agentAlert.codexHome`). Hooks must be enabled with `[features] hooks = true`.

To manage hooks manually, disable `agentAlert.setup.automatic` and use the **Nod: Set Up …** / **Nod: Preview …** commands.

## Controls

Click **Nod** in the status bar or type `Nod:` in the Command Palette.

- **Stop / Arm Auto Approve** — toggle Auto Approve for the current window
- **Pause** — stop all alerts and Auto Approve for this workspace
- **Choose Alert Sound** — use your own sound file (WAV on all platforms; MP3/M4A/AIFF on macOS)
- **Show Connection Status** / **Show Log** — troubleshooting

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `agentAlert.enabled` | `true` | Receive agent events |
| `agentAlert.setup.automatic` | `true` | Set up hooks automatically in trusted local workspaces |
| `agentAlert.sound.enabled` | `true` | Play alert sound |
| `agentAlert.sound.file` | `""` | Custom sound path; empty uses the built-in sound |
| `agentAlert.notifications.enabled` | `true` | Show IDE notifications |
| `agentAlert.autoApprove.enabled` | `true` | Enable Auto Approve |
| `agentAlert.autoApprove.armOnStartup` | `true` | Arm Auto Approve when a window opens |
| `agentAlert.autoApprove.allowedTools` | `["Bash", "exec_command", "apply_patch"]` | Codex tools to approve |
| `agentAlert.autoApprove.claudeAllowedTools` | `["Bash", "Edit", "Write"]` | Claude Code tools to approve |
| `agentAlert.autoApprove.delayMs` | `3000` | Delay before approving (1–30 s) |
| `agentAlert.sharedDataDirectory` | `""` | Shared directory for multiple IDEs; empty uses `~/.agent-alert` |
| `agentAlert.codexHome` | `""` | Custom Codex config directory |
| `agentAlert.claudeHome` | `""` | Custom Claude Code config directory |

Tool names must match exactly; `*` matches all tools and `[]` approves none. Questions are never auto-answered.

## Privacy

- The hook helper sends only the agent name, event type, tool name, session/request ID and `cwd` — never tool arguments, commands or conversation content.
- The bridge listens on `127.0.0.1` only, with a per-window token.
- If the IDE is closed or Nod is unavailable, the agent falls back to its normal permission flow.

## Limitations

- Local workspaces only — SSH, Dev Containers and WSL are not supported.
- Some Claude Code prompts (e.g. sandbox network requests) don't send `PermissionRequest`.
- Some Codex paths may not send `PreToolUse` for questions.

## Development

```sh
npm ci
npm test
npm run package
```

Press **F5** to launch the Extension Development Host. Disable `agentAlert.setup.automatic` or point `agentAlert.codexHome` / `agentAlert.claudeHome` at test directories to avoid modifying your real configuration.

## Uninstall

Disable `agentAlert.setup.automatic`, then remove only the hooks containing `--agent-alert-codex` from Codex `hooks.json` and `--agent-alert-claude` from Claude Code `settings.json`.
