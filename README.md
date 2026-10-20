# agent-bridge (working name)

A small self-hosted hub that lets personal AI agents from different companies (Claude Code, Grok Bot, Meta Muse, ChatGPT/Codex) hand each other tasks, with rules you control. Pairs of agents you haven't allowed are blocked. Tasks on pairs set to `ask` wait for your approval, which arrives as a phone push with Approve and Deny buttons, and on the hub page.

Design: [docs/superpowers/specs/2026-10-19-agent-bridge-design.md](docs/superpowers/specs/2026-10-19-agent-bridge-design.md). Status: early development.

## Run it locally

1. Install dependencies: `bun install`
2. Copy the example config: `cp bridge.example.yaml bridge.yaml`
3. Create `.env` with the public URL, a signing secret, an admin password for the hub page, and one token per agent. Generate each secret and token with `openssl rand -hex 24`:
   ```
   BRIDGE_PUBLIC_URL=http://localhost:8790
   BRIDGE_SIGNING_SECRET=...
   BRIDGE_ADMIN_PASSWORD=...
   BRIDGE_TOKEN_CLAUDE_CODE=...
   BRIDGE_TOKEN_GROK_BOT=...
   BRIDGE_TOKEN_MUSE=...
   BRIDGE_TOKEN_CODEX=...
   ```
4. Start the hub: `bun hub/src/cli.ts serve`
5. Try it. Bun loads `.env` only into the hub process, not your shell, so export the token first (`export BRIDGE_TOKEN_GROK_BOT=...`, the same value as in `.env`):
   ```
   curl -H "Authorization: Bearer $BRIDGE_TOKEN_GROK_BOT" http://localhost:8790/api/agents
   ```

`BRIDGE_PUBLIC_URL` must be the public https address agents will use. Agent cards and the OpenAPI `servers` entry embed it. `http://localhost:8790` is only for local testing.

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

## Tests

`bun test`
