# agent-bridge (working name)

A small self-hosted hub that lets personal AI agents from different companies (Claude Code, Grok Bot, Meta Muse, ChatGPT/Codex) hand each other tasks, with rules you control. Pairs of agents you haven't allowed are blocked. Tasks on pairs set to `ask` wait for your approval in a pop-up on your desktop (any joined machine with a Claude Code session open), or on the hub page. There is no phone app.

## The personal agent network

Beyond the agents named in `bridge.yaml`, the hub runs a personal agent network:
- **Machines join once** with a one-time join line (`bridge invite`, which must run where the hub's database is, or Network → **Add a machine** on the hub page). After that, every Claude Code session on the machine appears in a live directory as `<repo>-claude@<machine>`, with its status and what it's doing.
- **Messages** between your own agents are free-form and always allowed (`send_message`); tasks still follow your rules, and rules can name sessions with patterns such as `kind:claude-code`.
- **Delivery** into Claude Code uses its inbox socket: no development flag anywhere, and it works in `claude -p`.
- **Assistants** (Muse, Grok Bot, ChatGPT, Codex) connect from the hub page with Network → **Connect an assistant**, which mints a token and shows the connect prompt.

Join a machine: install the plugin, then run `bridge join '<join line>'` there (or `/agent-bridge:join <join line>` in Claude Code). Keep a folder off the network with `/agent-bridge:off`. Full steps: [docs/agents/claude-code.md](docs/agents/claude-code.md).

Design: [docs/superpowers/specs/2026-10-19-agent-bridge-design.md](docs/superpowers/specs/2026-10-19-agent-bridge-design.md). Status: early development.

## Run it locally

1. Install dependencies: `bun install`
2. Generate a starter config and every secret: `bun hub/src/cli.ts init`. This writes `bridge.yaml` (if missing) and `.env` (mode 600). With `--shell`, it writes `bridge-secrets.sh` as `export` lines instead.
3. Edit `bridge.yaml`: agents, rules and triggers.
4. Check the setup: `bun hub/src/cli.ts doctor`.
5. Start the hub: `bun hub/src/cli.ts serve`
6. Try it. Bun loads `.env` only into the hub process, not your shell, so export a token first (the same value as in `.env`):
   ```
   export BRIDGE_TOKEN_GROK_BOT=...
   curl -H "Authorization: Bearer $BRIDGE_TOKEN_GROK_BOT" http://localhost:8790/api/agents
   ```

`BRIDGE_PUBLIC_URL` must be the public https address agents will use. Agent cards, the OpenAPI `servers` entry and the task links agents are given embed it. `http://localhost:8790` is only for local testing.

## Environment

| Variable | Required | Purpose |
|---|---|---|
| `BRIDGE_PUBLIC_URL` | yes | The hub's public https address. Agent cards, the OpenAPI document and the task links agents are given use it. |
| `BRIDGE_TOKEN_<NAME>` | one per agent | The agent's bearer token, at least 24 characters. `<NAME>` is the agent name in upper case with `-` turned into `_`. |
| `BRIDGE_SIGNING_SECRET` | yes | Signs hub page sessions; at least 32 characters. Changing it signs everyone out. |
| `BRIDGE_ADMIN_PASSWORD` | yes | The hub page password; at least 12 characters. |
| `BRIDGE_PLUGIN_SOURCE` | no | The plugin's marketplace source (a GitHub `owner/repo` or a path) that the `/join` page tells new machines to install from. |
| `BRIDGE_DB_PATH` | no | Default `./bridge.db`. |
| `BRIDGE_CONFIG` | no | Default `./bridge.yaml`. |
| `PORT` | no | Default `8790`. |

`BRIDGE_NTFY_*` variables from earlier versions are ignored if still set, and the hub logs `ntfy_ignored` at startup with their names.

## Approvals

When a task is sent between a pair set to `ask`, it waits for your answer:
- **A pop-up on each joined machine** that has a Claude Code session open, one per machine: a floating panel on macOS, a notification with Approve and Deny on Linux. Windows machines show no pop-up; use the hub page there.
- **The hub page** lists the waiting task with Approve and Deny, and a note field.
- **The first answer wins**, from any machine or from the page. The other pop-ups close.
- **The agent's result** names the machines showing a pop-up and links the task page, which needs sign-in.

Software with full control of a joined machine can answer its pop-up: it's a speed bump that keeps approval out of the agents' tool path, not a guarantee. See [the spec's security notes](docs/superpowers/specs/2026-10-21-desktop-approvals-design.md#7-security-notes). Setup and details: [docs/agents/claude-code.md](docs/agents/claude-code.md#4-approvals-on-this-machine).

## Hub page

Open `<BRIDGE_PUBLIC_URL>/hub` and sign in with `BRIDGE_ADMIN_PASSWORD`. The page shows:
- the live directory: every Claude Code session, assistant and `bridge.yaml` agent, with status, what each is doing and when each was last seen
- tasks waiting for approval
- history, filterable by agent and status

**Network** (`/hub/network`) lists machines and assistants, with **Add a machine** (a fresh join line) and **Connect an assistant** (a token and a connect prompt). Removing a machine drops its sessions at once. The public `/join` page walks a new machine through installing the plugin and joining.

Sign-in locks for everyone for 15 minutes after 10 failed attempts; existing sessions keep working.

Signing out clears the cookie but doesn't revoke a copied one. To sign out everywhere, change `BRIDGE_SIGNING_SECRET`.

## Ways in

| Way in | Where | For |
|---|---|---|
| Web API | `/api/*`, described at `/api/openapi.json` | Any agent that can make web requests (Muse's Custom Connector, Grok Bot's computer) |
| MCP | `/mcp` | MCP clients (Claude Code, Codex, ChatGPT, Cursor, Grok Bot) |
| A2A | `/a2a/<agent>/.well-known/agent-card.json` | A2A clients |
| Live stream | `GET /api/stream` (server-sent events) | The Claude Code plugin: registers the session, nudges when work arrives, and carries approval requests to pop-up sessions |
| Approval answers | `POST /api/approvals/:taskId` | The Claude Code plugin only: answers a pop-up's request |

## Connect your agents

| Agent | Guide |
|---|---|
| Claude Code | [docs/agents/claude-code.md](docs/agents/claude-code.md): joining machines, the agent-bridge plugin (tools, live delivery, approval pop-ups) |
| Grok Bot | [docs/agents/grok-bot.md](docs/agents/grok-bot.md): MCP, added by asking in chat |
| Meta Muse | [docs/agents/muse.md](docs/agents/muse.md): a Custom Connector from the OpenAPI document (needs a regular domain) |
| Codex | [docs/agents/codex.md](docs/agents/codex.md): three lines in `~/.codex/config.toml` |

After connecting, run the [smoke-test checklist](docs/smoke-test.md).

## Build and deploy

- `bun run build` writes single-file executables for macOS arm64, Linux x64 and Linux arm64 to `dist/` (`bun run build host` for this machine only).
- `docker build -t agent-bridge .` builds the image. Its data lives in `/data` and its config at `/config/bridge.yaml`.
- [docs/deploy/cloud.md](docs/deploy/cloud.md): Render (with `render.yaml`) or Fly, on your own domain. This is the recommended setup.
- [docs/deploy/mac.md](docs/deploy/mac.md): launchd plus Tailscale Funnel. Works for every agent except Muse.

## Tests

`bun test`. `bun run typecheck` checks both packages (hub and plugin).

## License

Licensed under either of [MIT](LICENSE-MIT) or [Apache-2.0](LICENSE-APACHE), at your option.
