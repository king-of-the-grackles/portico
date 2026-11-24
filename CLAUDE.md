# Working in this repository

Checks before a pull request: `bun run typecheck`, `bun test`, and `bun run typecheck` in `e2e/`.

## Testing a branch, and who deploys

- **A branch is tested on this computer, never on a deployment.** `e2e/local.sh` starts Portico from the current
  checkout on a free port with a new empty data folder, runs the browser suite against it (`e2e/local.sh tests/05-*`
  for one scenario), and stops the server and removes the folder afterwards. To look at a page yourself, start
  `bun server/src/cli.ts serve` on a free port with a temporary `PORTICO_DATA_DIR` and use the headless browser.
  See `e2e/README.md`.
- **`dev.portico.chat` and `app.portico.chat` are deployed only by the Deploy workflow** (`.github/workflows/deploy.yml`),
  from `main`, after CI passes. A branch is never deployed to either, not even to dev: a hand-deployed branch with a
  migration broke that pipeline.
- **Agents never run `fly deploy` or `wrangler deploy`**, for any app. The `fly deploy` steps in the README are for
  people setting up their own Portico.
- **A change that touches `server/src/migrations.ts` or `server/src/db.ts` waits for a person.** Open the pull request,
  say that it changes the database, and leave merging and everything after it to them.

## A change a user can see

- **Label it `visible`** when a user would see or do something differently: a screen, its wording, a flow, an email.
  In the pull request's text, name the flows to record on one line: `Smoke flows: join`. When no flow in
  `e2e/smoke/flows/` shows the change, add or edit one in the same pull request (see `e2e/README.md`).
- **What the label does:** after the merge the Deploy workflow puts the commit on dev, runs the browser suite, and then
  waits in the environment `visible-change`. The flows are recorded on dev with `e2e/smoke.sh --commit <commit> <flows>`
  (the run's summary prints the line) and a person watches the recording before approving production.
- Code, tests, deploy scripts and docs that leave every screen and email as it was are not visible: no label.
