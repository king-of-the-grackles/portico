# agent-bridge (working name)

A small self-hosted hub that lets personal AI agents from different companies (Claude Code, Grok Bot, Meta Muse, ChatGPT/Codex) hand each other tasks, with rules you control. Pairs of agents you haven't allowed are blocked. Tasks on pairs set to `ask` wait for your approval, which arrives as a phone push with Approve and Deny buttons, and on the hub page.

Design: [docs/superpowers/specs/2026-10-19-agent-bridge-design.md](docs/superpowers/specs/2026-10-19-agent-bridge-design.md). Status: early development.

## Run it locally

1. Install dependencies: `bun install`
2. Generate a starter config and every secret: `bun hub/src/cli.ts init`. This writes `bridge.yaml` (if missing) and `.env` (mode 600). With `--shell`, it writes `bridge-secrets.sh` as `export` lines instead.
3. Edit `bridge.yaml`: agents, rules and triggers.
4. Check the setup: `bun hub/src/cli.ts doctor` (add `--no-push` to skip the test push).
5. Start the hub: `bun hub/src/cli.ts serve`
6. Try it. Bun loads `.env` only into the hub process, not your shell, so export a token first (the same value as in `.env`):
   ```
   export BRIDGE_TOKEN_GROK_BOT=...
   curl -H "Authorization: Bearer $BRIDGE_TOKEN_GROK_BOT" http://localhost:8790/api/agents
   ```

`BRIDGE_PUBLIC_URL` must be the public https address agents will use. Agent cards, the OpenAPI `servers` entry and approval links embed it. `http://localhost:8790` is only for local testing.

## Environment

| Variable | Required | Purpose |
|---|---|---|
| `BRIDGE_PUBLIC_URL` | yes | The hub's public https address. Agent cards, the OpenAPI document and approval links use it. |
| `BRIDGE_TOKEN_<NAME>` | one per agent | The agent's bearer token, at least 24 characters. `<NAME>` is the agent name in upper case with `-` turned into `_`. |
| `BRIDGE_SIGNING_SECRET` | yes | Signs approval links and hub page sessions; at least 32 characters. Changing it signs everyone out and voids open links. |
| `BRIDGE_ADMIN_PASSWORD` | yes | The hub page password; at least 12 characters. |
| `BRIDGE_NTFY_TOPIC` | no | Turns on phone pushes. Use 20–64 random letters, digits, `-` or `_`: anyone who knows a public topic can read it. |
| `BRIDGE_NTFY_URL` | no | The ntfy server. Default `https://ntfy.sh`. |
| `BRIDGE_NTFY_TOKEN` | no | An ntfy access token, for a protected topic or your own server. |
| `BRIDGE_DB_PATH` | no | Default `./bridge.db`. |
| `BRIDGE_CONFIG` | no | Default `./bridge.yaml`. |
| `PORT` | no | Default `8790`. |

## Approvals

When a task is sent between a pair set to `ask`, the hub pushes it to your ntfy topic with Approve, Deny and Open buttons. To get the pushes, install the ntfy app (iOS, Android or web) and subscribe to your topic; if you set `BRIDGE_NTFY_URL`, subscribe on that server. Tapping a button answers the hub directly. Opening a link in a browser shows the task and a confirm button, and only that button acts.

Without `BRIDGE_NTFY_TOPIC`, no pushes are sent; approve tasks on the hub page instead.

Approval links carry their signed token in the URL path, so a host's access logs contain them. Keep those logs private. Links stop working once the task is decided or expires.

## Hub page

Open `<BRIDGE_PUBLIC_URL>/hub` and sign in with `BRIDGE_ADMIN_PASSWORD`. The page shows:
- tasks waiting for approval
- Claude Code permission prompts relayed by the plugin
- each agent's last check-in
- history, filterable by agent and status

Sign-in locks for everyone for 15 minutes after 10 failed attempts; existing sessions and the push buttons keep working.

Signing out clears the cookie but doesn't revoke a copied one. To sign out everywhere, change `BRIDGE_SIGNING_SECRET` (this also voids open approval links).

## Ways in

| Way in | Where | For |
|---|---|---|
| Web API | `/api/*`, described at `/api/openapi.json` | Any agent that can make web requests (Muse's Custom Connector, Grok Bot's computer) |
| MCP | `/mcp` | MCP clients (Claude Code, Codex, Cursor, Grok Bot) |
| A2A | `/a2a/<agent>/.well-known/agent-card.json` | A2A clients |
| Live stream | `GET /api/stream` (server-sent events) | Push agents (the Claude Code plugin): nudges when work arrives, and answers to permission prompts |
| Permission relay | `POST /api/permission-requests` | Push agents: forwards Claude Code permission prompts to the push and the hub page |

## Connect your agents

| Agent | Guide |
|---|---|
| Claude Code | [docs/agents/claude-code.md](docs/agents/claude-code.md): the agent-bridge plugin (tools, live task delivery, permission relay) |
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
