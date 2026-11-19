# Portico end-to-end suite

A small browser and API suite that runs against a **deployed** Portico by URL. It signs real test people in, joins
real agents through the consent page, and sends real messages and files. Today it targets the dev deployment,
`https://dev.portico.chat` (hosted Portico with Descope sign-in), whose data is disposable.

## Run

```sh
cd e2e
bun install
bunx playwright install chromium
./run.sh                      # everything
./run.sh tests/05-*           # one scenario; any Playwright arguments pass through
./run.sh --headed --debug     # watch and step
E2E_KEEP=1 ./run.sh           # keep the test people and agents and reuse them on the next run
./run.sh --cleanup            # delete what kept or crashed runs left behind
E2E_HTML_REPORT=1 ./run.sh    # also write playwright-report/
```

A failed test leaves a trace and screenshots under `test-results/`: `bunx playwright show-trace <trace.zip>`.

## What it needs

Everything comes from the environment:

| Variable | Meaning |
| --- | --- |
| `E2E_BASE_URL` | The Portico to test. Default `https://dev.portico.chat`. |
| `DESCOPE_PROJECT_ID` | The Descope project that deployment signs people in with (the dev-only project). |
| `DESCOPE_MANAGEMENT_KEY` | A management key of that project, to make and delete test users. |

When the two Descope variables are unset, `run.sh` reads them with `jq` from `~/.descope/projects.json`, entry
`portico-dev` (`E2E_DESCOPE_ENTRY` names another entry). The key is never printed and never written into the repo.
`e2e/.state/` (git-ignored) holds the run's session cookies and agent tokens for the dev deployment until the teardown.

## The production guard

The suite makes people, agents, Porticos and messages, so it never runs against production. `run.sh` and
`playwright.config.ts` both refuse to start when the host of `E2E_BASE_URL` is `portico.chat` or `www.portico.chat`.
Keep it that way: point it only at a deployment whose data may be thrown away, with that deployment's own Descope project.

## How it works

- **Sign-in without the Descope screen** (`lib/descope.ts`, `lib/person.ts`): a test user is made with Descope's
  management API (`e2e-<role>-<run id>@dev.portico.chat`), a real session JWT comes from an embedded sign-in link, and
  `POST /api/session { token }` sets the `portico_session` cookie, exactly as the sign-in page does once Descope's
  component finishes. The suite checks that the sign-in pages load the component, but it does not type into it.
- **Agents** (`lib/agent.ts`): `POST /api/join`, then the person allows the join on the real consent page in a browser
  (handle the first time, the 4-digit code, Allow), then the agent polls for its token. `allowOnConsentPage` and
  `decideHeld` are the two page helpers. `AgentClient` wraps the REST
  agent API: `call(tool, args)`, `send`, `inbox`, `receive(subject)`, `outcome(messageId)`, `task`, `upload`,
  `download`, and `raw` for checking refusals.
- **The cast** (`lib/world.ts`): alice (agents `probe`, `helper`) and bob (`scout`, `owl`), made the first time a
  scenario asks and reused by every scenario after it. The server lets one address start 10 joins per 15 minutes, and a
  fresh run uses 4, so the suite runs with one worker and never joins twice for the same agent. While editing
  scenarios, use `E2E_KEEP=1`: a rerun then starts a single join.
- **Cleanup** (`lib/teardown.ts`): after the run, the Descope users it made are deleted, along with the agents and
  Porticos they made. The people's rows stay in the dev deployment's database: Portico has no way to delete a person.

## Scenarios

| File | What it covers |
| --- | --- |
| `tests/01-sign-in.spec.ts` | A new person signs in, picks a handle on the welcome page, sees their Portico. |
| `tests/02-agent-join.spec.ts` | An agent-started join on the consent page: signed-out view, wrong code, Allow, token, `list_porticos`. |
| `tests/03-own-agents.spec.ts` | Two agents of one person message each other; Activity and the Portico's page show the conversation. |
| `tests/04-two-people.spec.ts` | Alice makes and shares a Portico on the pages; Bob comes in with the link and an agent; a DM; Bob's own conversations answer Alice like unknown IDs. |
| `tests/05-held-message.spec.ts` | A held message allowed, and another turned down, on `/held/<id>`; the other person can't open that page. |
| `tests/06-files.spec.ts` | A file uploaded to the bucket, sent, downloaded by the receiver, and passed on into another Portico. |

## Adding a scenario

Add `tests/NN-name.spec.ts`. Files run in name order, one at a time.

```ts
import { expect, test, unique } from "../lib/fixtures";

test("what a person would say happened", async ({ world, browserAs }) => {
  const alice = await world.person("alice");           // signed in, handle chosen
  const probe = await world.agent("alice", "probe");   // reused; joined through the consent page if new
  const helper = await world.agent("alice", "helper");

  const subject = unique("Something to do");           // a subject no other test or run used
  await probe.send({ to: "helper", subject, text: "…" });
  await helper.receive(subject);

  const page = await browserAs(alice);                  // a signed-in page, closed after the test
  await page.goto("/activity");
  await expect(page.getByText(subject, { exact: true }).first()).toBeVisible();
});
```

Scenarios that need two people call `await world.shared()` for the Portico that joins alice's `probe` and bob's
`scout`. Stick to the cast's agents where possible: every new agent name is one more join against the limit. Find
elements by role, label and visible text, so a scenario reads like the page.
