# Upload load harness

Measures how the upload engine behaves when many principals upload at once. It exists because the
repo had no load test at all, and "can it take 100–1000 users?" was being answered from
configuration rather than from a reading.

It drives the **public HTTP API** over real sockets — `POST /uploads`, `PUT /uploads/:id/parts/:n`,
`POST /uploads/:id/complete` and the finalize poll — so the session registry, quota holds, capacity
checks, part admission, state transitions and background finalize jobs are the shipping code. It is
not a unit test of the routes and it does not reach into `src/`.

Nothing here runs in CI or in `pnpm test`. It is a manual instrument, and it never builds or ships.

## Run it

```bash
pnpm load                                     # sweep: 10, 25, 50, 100, 300, 1000 users
pnpm load                                     # (same script; override with env)
LOAD_TEST_USERS=25 pnpm load                   # one level
```

Each level runs in its own process and the API runs in a child of that, so a level that exhausts
memory reports its last sample instead of taking the sweep down.

## What the numbers mean

- **`parts-in-flight`** — parts the API was executing in the storage provider at the peak sample.
  This is the quantity that drives memory.
- **`serverRSS`** — peak resident memory of the **API process only** (not the synthetic client).
- **`MiB/s`** — aggregate bytes acknowledged over wall time, measured on loopback.
- **`loop p99`** — event-loop delay p99 inside the API process. Large values mean the server is
  blocking, not just busy.
- **`files=`** — completed / total. With `ABORTED (rss-cap)` the run stopped at the configured
  memory ceiling; that is a result, not a harness failure.

`LOAD_TEST_RSS_CAP_MB` (default 3000) is a safety valve: the sampler aborts the level just after the
server passes it, because the alternative is letting the operating system decide.

## What is simulated, and what is not

| Piece                                   | In a local run                           | Why                                                                                                                   |
| --------------------------------------- | ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Routes, auth, sessions, quota, finalize | **real code**                            | This is what is being measured                                                                                        |
| Metadata database                       | in-memory double (`db-double.ts`)        | no PostgreSQL in this environment; it answers the exact queries the upload path issues and throws on anything else    |
| Storage backend                         | discard provider (`discard-provider.ts`) | no Telegram/network; it counts every byte and keeps none                                                              |
| Backend service time                    | `LOAD_TEST_PART_DELAY_MS` (default 0)    | a real backend holds each part's buffer for the whole send; with 0 the harness measures the no-backpressure best case |
| Network                                 | loopback                                 | throughput is not a network measurement                                                                               |

The discard provider in buffered mode (`LOAD_TEST_BUFFER_PARTS=true`, the default) reproduces what
the deployed Telegram path does per part: merge the incoming chunks, then copy them into the request
body, and hold both for the duration of the send. That is why per-part memory here is comparable to
production. With `LOAD_TEST_BUFFER_PARTS=false` it streams instead, which isolates the route's own
overhead from the backend's buffering.

## Point it at a real deployment

`LOAD_TEST_BASE_URL https://api.example.com` makes the driver skip starting a server and drive that
origin instead. Server-side memory and in-flight counts are then reported as `null`, because this
process cannot observe them.

Credentials come from one of:

- `LOAD_TEST_TOKEN_FILE=/path/tokens.txt` — one bearer token per line, one user per token. Use this
  against a deployment with asymmetric keys (Supabase Cloud).
- `LOAD_TEST_JWT_SECRET` / `LOAD_TEST_JWT_ISSUER` / `LOAD_TEST_JWT_AUDIENCE` — mint HS256 tokens
  locally, for a deployment that verifies a shared secret. Each generated user id must be able to
  provision a profile (the API does that on first use).

A real deployment also needs `UPLOAD_MAX_ACTIVE_SESSIONS_PER_PRINCIPAL` ≥ `LOAD_TEST_FILES_PER_USER`
and a per-user quota that covers the requested sizes.

## Knobs

| Variable                     | Default                 | Meaning                                              |
| ---------------------------- | ----------------------- | ---------------------------------------------------- |
| `LOAD_TEST_USERS`            | unset (sweep)           | users in one level                                   |
| `LOAD_TEST_LEVELS`           | `10,25,50,100,300,1000` | sweep levels                                         |
| `LOAD_TEST_FILES_PER_USER`   | `2`                     | 1–3; the API's real open-session cap is 3            |
| `LOAD_TEST_SIZES`            | `100mb,2gb`             | cycled across a user's files                         |
| `LOAD_TEST_PART_CONCURRENCY` | `6`                     | parallel parts per file (matches the browser client) |
| `LOAD_TEST_PART_DELAY_MS`    | `0`                     | simulated backend service time per part              |
| `LOAD_TEST_BUFFER_PARTS`     | `true`                  | reproduce the deployed backend's per-part buffering  |
| `LOAD_TEST_RSS_CAP_MB`       | `3000`                  | server memory ceiling that aborts a level            |
| `LOAD_TEST_LEVEL_TIMEOUT_MS` | `120000`                | wall-clock budget per level                          |
| `LOAD_TEST_POLL_MS`          | `50`                    | finalize poll interval (the browser uses 3000)       |
| `LOAD_TEST_USER_QUOTA_BYTES` | `5368709120`            | per-user quota in the metadata double                |
| `LOAD_TEST_RATE_LIMIT`       | `false`                 | enable the API's real per-principal limiter          |
| `LOAD_TEST_BASE_URL`         | unset                   | drive an external deployment                         |

## Files

- `run.ts` — driver, sweep orchestration, result reporting.
- `server-process.ts` — the API process for one level; samples its own RSS and event-loop delay.
- `db-double.ts` — in-memory metadata database.
- `discard-provider.ts` — storage provider that counts bytes and keeps none.
- `RESULTS.md` — the readings taken on 2026-10-18, with their reproduction commands.
