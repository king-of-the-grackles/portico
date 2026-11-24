# Portico end-to-end suite

A small browser and API suite that runs against a Portico by URL. It signs real test people in, joins real agents
through the consent page, and sends real messages and files. It runs in two places:

- **On this computer, against the current checkout** (`./local.sh`): how a branch is tested before it is merged.
- **Against the dev deployment**, `https://dev.portico.chat` (`./run.sh`): what the Deploy workflow does after it has
  deployed `main` there. Dev is deployed only by that workflow; a branch is never deployed to it.

## Run a branch locally

```sh
cd e2e
bunx playwright install chromium   # once
./local.sh                    # everything, against a server started from this checkout
./local.sh tests/05-*         # one scenario; any Playwright arguments pass through
```

`local.sh` installs the dependencies if they are missing, starts `bun server/src/cli.ts serve` from the checkout it
is in, waits for `/healthz`, runs the suite, and then stops the server and removes its data, also when the run fails
or is interrupted. Each run gets:

- a free port (from `free-port` when that command exists), with `PORTICO_PUBLIC_URL=http://localhost:<port>`. The
  session cookie is `Secure` only on https, so sign-in works on localhost;
- a new empty data folder in the temp directory and a secrets key made for the run;
- the dev-only Descope project for sign-in, the same one `run.sh` uses. The test users the run makes there are the
  only thing it touches outside this computer, and it deletes them at the end;
- no Resend key, so no email is sent, and no bucket, so files live in the data folder;
- an otherwise empty environment: none of the shell's `PORTICO_*`, `AWS_*` or platform variables reach the server.

All 16 scenarios run locally and none is skipped. One check inside `06-files` is left out: with a bucket each
Portico's copy of a file has its own download address, and without one Portico serves every file at `/files/<id>`.
The join limit and the loop guard below start from zero on every run, because the server is new each time, so local
runs can follow each other straight away. `E2E_KEEP` does nothing here: the server the people lived on is gone.

A failed run leaves the server's log in `test-results/server.log`, beside the traces. If a run is killed outright
before its cleanup, `./run.sh --cleanup` deletes the Descope test users it left.

## Run against dev

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

## Record a visible change on dev

`./smoke.sh` records one flow on dev as a short video for a person who reads no code: what they watch before a
visible change goes to production (see "Deploys" in the main README).

```sh
cd e2e
./smoke.sh --list                               # the flows there are
./smoke.sh --commit <commit> join               # record smoke/flows/join.flow.ts
./smoke.sh --commit <commit> --out <folder> join
```

- `--commit` is the commit being approved. The run refuses to start unless dev's `/healthz` reports it.
- Each flow writes `smoke.mp4`, `01-<step>.png` and so on, and `steps.md` to `<folder>/<commit>/<flow>/`. The folder
  defaults to `~/portico-smoke` and may not be inside the repository.
- It needs `ffmpeg`, `fc-match` and a sans-serif font, so it runs on a person's or an agent's computer, not in CI.
- It signs in as the suite does, with a new test person in the dev-only Descope project, and cleans up the same way:
  the Descope user and the person's agents are removed. Nothing else on dev is read or changed.
- A token is never on screen. The 4-digit join code is, and it is used up in the same recording.

A flow is a Playwright test that imports `test` from `smoke/lib/recorder.ts` and gets `rec`, a phone-sized browser
with video on, beside the suite's `world`:

```ts
test("What the video shows, as its title", async ({ world, rec }) => {
  await rec.page.goto("/");
  await rec.step("sign-in", "A signed-out visitor is sent to the sign-in page.");
  await rec.type("Handle", "sam");                      // typed a key at a time
  await rec.step("welcome", "The person picks a handle.", { shot: false });   // in the video, no screenshot
  rec.cannotShow("Typing into the sign-in screen.");    // said in steps.md
});
```

Keep a flow to what `smoke/render.ts` accepts: 30 to 90 seconds, 3 to 5 screenshots, captions of at most three
lines. Make people through `world` (`newcomer`, `person`, `agent`) so the cleanup knows them. Try a new flow against
a local server first: start one as `local.sh` does and set `E2E_BASE_URL`. Production is refused.

### Sending the recording

The recording goes to the person who approves, in their Portico chat. Every screenshot is sent as a file of its own, never combined into one sheet, so each can be opened and answered:

1. **First message:** `smoke.mp4`, with the steps from `steps.md` as text in the message.
2. **Second message:** the screenshots as separate PNG files, up to five, under the names the flow gave them
   (`01-sign-in.png`), each listed by name in the message text with one line saying what it shows. A flow saves five
   screenshots at most, so they fit one message.

Each subject starts with who it is for and names the pull request, for example
`For Chris: PR #21 on dev, the join flow (video)`. Several flows are sent one after another, each as its own pair.

## What it needs

Everything comes from the environment:

| Variable | Meaning |
| --- | --- |
| `E2E_BASE_URL` | The Portico to test. Default `https://dev.portico.chat`. |
| `DESCOPE_PROJECT_ID` | The Descope project that deployment signs people in with (the dev-only project). |
| `DESCOPE_MANAGEMENT_KEY` | A management key of that project, to make and delete test users. |

When the two Descope variables are unset, `run.sh` reads them with `jq` from `~/.descope/projects.json`, entry
`portico-dev` (`E2E_DESCOPE_ENTRY` names another entry). The key is never printed and never written into the repo.
`e2e/.state/` (git-ignored) holds the run's session cookies and agent tokens until the teardown.

## The production guard

The suite makes people, agents, Porticos and messages, so it never runs against production. `run.sh` and
`playwright.config.ts` both refuse to start when the host of `E2E_BASE_URL` is `portico.chat`, `www.portico.chat` or
`app.portico.chat` (the live app). `dev.portico.chat` and localhost are allowed.
Keep it that way: point it only at a deployment whose data may be thrown away, with that deployment's own Descope project.

## How it works

- **Sign-in without the Descope screen** (`lib/descope.ts`, `lib/person.ts`): a test user is made with Descope's
  management API (`delivered+e2e-<role>-<run id>@resend.dev`: Resend's test inbox, because the deployment
  sends real notice emails and a made-up address would bounce), a real session JWT comes from an embedded sign-in link, and
  `POST /api/session { token }` sets the `portico_session` cookie, exactly as the sign-in page does once Descope's
  component finishes. The suite checks that the sign-in pages load the component, but it does not type into it.
- **Agents** (`lib/agent.ts`): `POST /api/join`, then the person presses Allow on the real consent page in a browser
  (a handle the first time, the "started this myself" tick), the page shows a 4-digit code, and the agent hands the
  code in with its poll secret and gets its token. `joinThroughPage` is that whole flow, so a change to joining is
  made there and nowhere else. `allowOnConsentPage` answers any consent page and `decideHeld` a held message's page.
  `AgentClient` wraps the REST agent API: `call(tool, args)`, `send`, `inbox`, `receive(subject)`,
  `outcome(messageId)`, `task`, `upload`, `download`, `requestInput` and `answerTo(questionId)` for a question to the
  agent's own person, and `raw` for checking refusals.
- **The cast** (`lib/world.ts`): alice (agents `probe`, `helper`) and bob (`scout`, `owl`), made the first time a
  scenario asks and reused by every scenario after it. `world.shared()` is the Portico alice shares with bob, holding
  `probe`, `helper` and `scout`; `world.introduce()` has the two people allow each other's agents.
- **Cleanup** (`lib/teardown.ts`): after the run, the Descope users it made are deleted, along with the agents and
  Porticos they made. The people's rows stay in the dev deployment's database: Portico has no way to delete a person.

## Two server limits the suite lives with

Both matter against dev. A local run starts a new server, so it never meets a limit an earlier run used up.

- **Joins: a limit on starts per address per 15 minutes**, 10 on any Portico that doesn't say otherwise. A fresh run
  starts 8 (the four cast agents, plus four scenarios that are about joining), so on that limit only one run per 15
  minutes would pass. Dev sets `PORTICO_JOIN_STARTS_PER_ADDRESS = "500"` in `fly.dev.toml`, which is room for runs
  one straight after another; the live app's file never has that line, and a unit test checks that. Against any other
  deployment, raise the same setting there, or use `E2E_KEEP=1`: a rerun then starts 4, and a single scenario mostly
  none. A used-up limit fails with a message that says so. Still one worker and no agent joined twice: at most 5
  joins from one address may wait for a person at once, and that limit is the same everywhere.
- **Loop guard: 12 messages between two agents per 10 minutes.** Scenarios spread their messages over the pairs
  `probe`-`scout` and `helper`-`scout`, at most 6 each per run, which leaves room for one immediate rerun. A new
  scenario that sends between people should pick the less used pair, or it will trip the guard for the others.

## Scenarios

| File | What it covers |
| --- | --- |
| `tests/01-sign-in.spec.ts` | A new person signs in, picks a handle on the welcome page, sees their Portico. |
| `tests/02-agent-join.spec.ts` | A join on the consent page: signed-out view, Allow, the code on the page, wrong code, token once. And a join someone else started: Allow without the code reaching them joins nothing, another person can't see the code, "Don't allow after all". |
| `tests/03-own-agents.spec.ts` | Two agents of one person message each other; Activity and the Portico's page show the conversation. |
| `tests/04-two-people.spec.ts` | Alice makes and shares a Portico on the pages; Bob comes in with the link and an agent; a DM; Bob's own conversations answer Alice like unknown IDs. |
| `tests/05-held-message.spec.ts` | An agent that requires approval: a message allowed and another turned down on `/held/<id>`, which the other person can't open. And the outbound switch: an agent's messages to other people wait for its own person. |
| `tests/06-files.spec.ts` | A file uploaded to the bucket, sent, downloaded by the receiver, and passed on into another Portico. |
| `tests/07-new-agent.spec.ts` | An agent joined without the "started this myself" tick is held once towards the person's other agent; revoking an agent kills its token and withdraws what it had on the way. And the Joined page's "Yes, always allow" button: pressing it vouches for the new agent and lets through the message that waited. |
| `tests/08-first-contact.spec.ts` | First contact between two people's agents: "this message only" asks again next time, "always for this person" doesn't. |
| `tests/09-second-portico.spec.ts` | A share link works once; the maker is asked for each later agent; the record shows who came and went with no message text; a removed person is out. |
| `tests/10-pause.spec.ts` | A paused Portico: sends refused, the undelivered message withdrawn, resume. |
| `tests/11-mcp.spec.ts` | `/mcp` with an agent token: initialize, tools/list, `list_agents`, `send_message`. |
| `tests/12-no-reply-needed.spec.ts` | A note sent with `no_reply_needed`: the frame tells the receiver not to answer, and Today shows the task done once the note is picked up. |
| `tests/13-input-needed.spec.ts` | Input needed: an agent asks its own person with `request_input`; the card on Today and one press on a choice; the framed answer the agent gets once; the task's Waiting on pill and steps; free text on `/q/<id>`, which another person can't open; Skip. |

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

Scenarios that need two people call `await world.shared()` for the Portico that joins alice's `probe` and `helper`
with bob's `scout`. Stick to the cast's agents where possible: every new agent name is one more join against the
limit. A scenario that changes a setting (a hold switch, a pause) puts it back in a `finally`. Find
elements by role, label and visible text, so a scenario reads like the page.
