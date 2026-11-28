# Contributing to Portico

This page is for people working on Portico's code. To use Portico or run your own server, see the [README](README.md).

Checks before a pull request: `bun run typecheck`, `bun test`, and `bun run typecheck` in `e2e/`.

## Local development

```sh
bun install
bun test
bun run typecheck                 # both packages: server and plugin
export PORTICO_SECRETS_KEY="$(bun server/src/cli.ts key)"   # once per data folder: keep the key to start that folder again
bun server/src/cli.ts serve       # http://localhost:8790; prints the setup link at first start
```

To skip the setup page, seed a database first, then serve that database:

```sh
mkdir -p dev && bun server/scripts/dev-seed.ts ./dev/portico.db
PORTICO_DATA_DIR=./dev bun server/src/cli.ts serve
```

The seed script prints a sign-in cookie for the owner and the password.

`e2e/local.sh` runs the browser suite against a server started from the current checkout, on a free port with a throwaway data folder: how a branch is tested before it is merged (see `e2e/README.md`).

## Build

- `bun run build` writes single-file executables for macOS arm64, Linux x64 and Linux arm64 to `dist/` (`bun run build host` for this computer only).
- `docker build -t portico .` builds the image. It keeps all data in `/data` and needs no config mount.

## Deploys

This is how the hosted app (`app.portico.chat`) and its dev copy (`dev.portico.chat`) are deployed. Your own Portico doesn't need any of it.

`.github/workflows/deploy.yml` runs after CI passes for a push to `main`, or when started by hand on `main`. It deploys the exact commit CI tested, one deploy at a time:

1. **Dev.** Deploys to `portico-dev` and waits until `dev.portico.chat/healthz` answers with that commit. If either fails, the image that ran before is deployed again, migration or not, because dev's data is disposable, and the run stops there.
2. **Browser suite.** Runs `e2e/` against dev. One run: a failure stops the deploy before production, with no second try.
3. **Plan.** Reads the commit live on `app.portico.chat/healthz`. The deploy counts as a migration when that commit is unknown, isn't an ancestor of the new one, or the changes since touch `server/src/migrations.ts` or `server/src/db.ts`.
4. **A visible change waits.** When a pull request behind one of the commits going out carries the label `visible`, the run stops here in the environment `visible-change` until its reviewer approves. Meanwhile the change is recorded on dev with `e2e/smoke.sh` (below) and the reviewer watches that. Without the label this step is skipped. If the check can't tell (GitHub gives no answer, or the live commit is unknown), the run waits too; and if the environment is missing or has no reviewer, the run fails before production instead of walking through.
5. **Production.** Without a migration, deploys in the `production` environment. With one, deploys in `production-migration`, which waits for a reviewer, and snapshots the volume first. Then it checks, with GETs only, that `/healthz` answers with the commit and that the sign-in page and `/api/agent/openapi.json` answer 200.
6. **If that check fails.** Without a migration, the previous image is deployed again and the run fails. With one, nothing is rolled back, because the old code would run on a changed database: the run fails and its summary names the snapshot, for a person to decide.

On dev and on production the image is built and pushed first (`scripts/deploy/build-image.sh`), and released from that image in a second step. The build changes nothing that runs, so one that hangs is cut off after 8 minutes and tried once more, on Fly's own builder instead of Depot. The release is never tried again by itself; one that takes over 10 minutes is stopped and counts as failed, so the rollback that follows always has its time.

Nothing runs unless the repository variable `DEPLOY_ENABLED` is `true`; unset it to stop deploys. Each run's summary page says what was deployed and how it went.

| Where in GitHub's settings | What to create |
| --- | --- |
| Repository variable | `DEPLOY_ENABLED` = `true` |
| Environment `dev` | Secrets `FLY_API_TOKEN` (a deploy token for `portico-dev`: `fly tokens create deploy -a portico-dev`), `DESCOPE_PROJECT_ID` and `DESCOPE_MANAGEMENT_KEY` (the dev-only Descope project) |
| Environment `production` | Secret `FLY_API_TOKEN` (a deploy token for `portico-chat`) |
| Environment `production-migration` | Its own secret `FLY_API_TOKEN` for `portico-chat`, and a required reviewer |
| Environment `visible-change` | A required reviewer, and no secret: its job deploys nothing |
| Label `visible` | On pull requests that change what a user sees or does |

A migration and a visible change are asked about separately: a deploy that is both waits twice, once in `visible-change` and once in `production-migration`.

### Recording a visible change

A change is visible when a user would see or do something differently: a screen, its wording, a flow, an email. Its pull request gets the label `visible` and a line naming the flows to record, `Smoke flows: join`. A change to code, tests or the deploy that leaves every screen and email as it was is not visible.

Each flow is a small file in `e2e/smoke/flows/`. Once the Deploy run has put the commit on dev and is waiting, record it on a computer with the repository, `ffmpeg` and the dev Descope entry:

```sh
e2e/smoke.sh --commit <commit> join     # the run's summary page prints this line with the commit and flows filled in
```

It refuses to start unless `dev.portico.chat/healthz` reports that commit. It writes `smoke.mp4` (H.264, phone size, a caption under each step), numbered screenshots and `steps.md` to `~/portico-smoke/<commit>/<flow>/`, never into the repository, and removes the test person's sign-in and agents from dev afterwards, as the browser suite does. See `e2e/README.md` for writing a flow and for how the recording is sent.
