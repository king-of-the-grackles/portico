# agent-bridge (working name)

A small self-hosted hub that lets personal AI agents from different companies (Claude Code, Grok Bot, Meta Muse, ChatGPT/Codex) hand each other tasks, with rules you control. Pairs of agents you haven't allowed are blocked; tasks on pairs set to `ask` wait for approval. The approval push and page come in a later release; until then those tasks expire after `task_expiry_hours`.

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

## Ways in

| Way in | Where | For |
|---|---|---|
| Web API | `/api/*`, described at `/api/openapi.json` | Any agent that can make web requests (Muse's Custom Connector, Grok Bot's computer) |
| MCP | `/mcp` | MCP clients (Claude Code, Codex, Cursor) |
| A2A | `/a2a/<agent>/.well-known/agent-card.json` | A2A clients (Grok Bot) |

## Tests

`bun test`
