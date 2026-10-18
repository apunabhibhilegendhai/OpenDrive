# Load readings — 2026-10-18

Host: 12 vCPU, 16 013 MiB RAM (~10 000 MiB free at run time), Node 24.22.0, Windows.
Metadata: in-memory double. Storage: discard provider. Backend service time: **1 000 ms per part**
(`LOAD_TEST_PART_DELAY_MS=1000`), which is the order of magnitude of a part send to Telegram.
Part size: 8 MiB (the API's configured chunk size). Parts per file in flight: 6.
Server memory cap: 3 000 MiB (`LOAD_TEST_RSS_CAP_MB=3000`).

These are **not** Telegram numbers and **not** network numbers. They measure the upload engine's
concurrency behaviour and its memory cost per in-flight part; the backend is simulated so that a
terabyte-scale burst is possible on one machine.

## 100 MB files — concurrency sweep (2 files per user)

```
LOAD_TEST_FILES_PER_USER=2 LOAD_TEST_SIZES=100mb LOAD_TEST_PART_DELAY_MS=1000 \
LOAD_TEST_LEVELS=10,25,50,100,300,1000 pnpm load
```

| users | files done | wall | MiB/s | parts in flight | server RSS | loop p99 | outcome |
| ----- | ---------- | ------ | ----- | --------------- | ---------- | --------- | -------------------- || 10 | 20/20 | 11.3 s | 177 | 78 | 1 713 MiB | 1 604 ms | completed |
| 25 | 50/50 | 24.9 s | 201 | 145 | 2 525 MiB | 3 748 ms | completed, but see below |
| 50 | 0/100 | 14.4 s | — | 217 | 3 438 MiB | 6 619 ms | **aborted: RSS cap** |
| 100 | 0/200 | 45.9 s | — | 279 | 3 902 MiB | 12 893 ms | **aborted: RSS cap** |
| 300 | 0/600 | 40.4 s | — | 266 | 3 102 MiB | 6 761 ms | **aborted: RSS cap** |
| 1000 | 0/2000 | 92.7 s | — | 481 | 4 197 MiB | 12 885 ms | **aborted: RSS cap** |

**The boundary is between 20 and 25 users, and it is not sharp.** Re-running individual levels after
the sweep: 10 users completed at 1 803 MiB, 20 users completed at 2 341 MiB, and 25 users completed
once (2 525 MiB) but aborted at 3 290 MiB on a re-run of the identical level. Run-to-run variance of
~800 MiB at the boundary means "how many users fit" depends on GC timing; "20 fits, 50 does not" is
the stable statement, and 25 is a coin toss.

## Mixed payloads — 100 MB + 1 GB + 2 GB per user

```
LOAD_TEST_USERS=3 LOAD_TEST_FILES_PER_USER=3 LOAD_TEST_SIZES=100mb,1gb,2gb \
LOAD_TEST_PART_DELAY_MS=1000 pnpm load
```

| users | files done | bytes | wall | MiB/s | parts in flight | server RSS | slowest file |
| ----- | ---------- | ------- | ------ | ----- | --------------- | ---------- | ------------- || 3 | 9/9 | 9.98 GB | 52.3 s | 182 | 50 | 1 289 MiB | 52.3 s (2 GB) |
| 10 | 30/30 | 33.3 GB | 99.9 s | 318 | 108 | 1 905 MiB | 99.8 s (2 GB) |

The mixed run is why per-file size is not the driver: 10 users with a 2 GB file each peak at 1 905 MiB
— less than 20 users with two 100 MB files (2 341 MiB) — because memory tracks _in-flight parts_, not
bytes in the object.

A single 2 GB file, alone: **1/1 completed in 47.3 s**, 6 parts in flight, server RSS 339 MiB.

So the 2 GB path works end to end — 256 parts, 202-then-poll finalize — and ten users each pushing
a 100 MB, a 1 GB and a 2 GB file complete. What fails is _more concurrent users_, and it fails on
memory, not on routes or bookkeeping.

## What the numbers say

**Per-part cost is ~17 MiB of server RSS.** Derived from the clean levels:
`(2 341 − 158) / 128 = 17.1 MiB` (20 users), `(1 803 − 160) / 94 = 17.5 MiB` (10 users) and
`(1 905 − 158) / 108 = 16.2 MiB` (10 mixed users).
That is the two-copy buffering the deployed Telegram path performs (merged part + request-body copy),
plus chunk and socket overhead. It is the single quantity that caps the system.

**Extrapolation (not measured):** a 100-user level at steady state is ~600 parts ≈ 10 GB; 1 000
users at two files each is ~12 000 parts ≈ **200 GB**. No container survives that. The measured wall
on a 3 GB budget is 20–25 users; on an 8 GB budget it would land near 50–60 users; reaching 1 000
users needs the per-part cost to drop by roughly two orders of magnitude — i.e. streaming, not
tuning.

**The event loop is the second casualty.** p99 delay climbs from 1.6 s at 10 users to 12.9 s at 100
users, so the API is not merely slow under load: it stops responding in multi-second stretches.
Metadata cost is not the cause — 4 378 queries for 30 files across 10 users is ~146 per file, and
the in-memory double answers them instantly. Allocation and GC of the part buffers are.

**Allocation is bursty, so the cap is overshot.** Levels that aborted passed 3 000 MiB by 100–1 200
MiB before the 50 ms sampler could stop them. A production guard has to be a concurrency limit, not
a memory alarm.

**No route or bookkeeping failure appeared.** Every failure in the aborted levels is `fetch failed`
because the harness cancelled in-flight requests at the cap. No 5xx, no 429 (the rate limiter was
disabled for these runs), no quota or state-machine error.

## Reproduce

```bash
cd apps/api
# sweep
LOAD_TEST_FILES_PER_USER=2 LOAD_TEST_SIZES=100mb LOAD_TEST_PART_DELAY_MS=1000 \
LOAD_TEST_LEVELS=10,25,50,100,300,1000 node --import tsx load/run.ts
# one 2 GB file
LOAD_TEST_USERS=1 LOAD_TEST_FILES_PER_USER=1 LOAD_TEST_SIZES=2gb \
LOAD_TEST_PART_DELAY_MS=1000 LOAD_TEST_LEVEL_TIMEOUT_MS=300000 node --import tsx load/run.ts
```

Machine-readable results are the `LOAD_RESULT` line (single level) or the JSON array after the sweep
summary.
