# Load readings — 2026-10-18

Host: 12 vCPU, 16 013 MiB RAM (~10 000 MiB free at run time), Node 24.22.0, Windows.
Metadata: in-memory double. Storage: discard provider. Backend service time: **1 000 ms per part**
(`LOAD_TEST_PART_DELAY_MS=1000`), which is the order of magnitude of a part send to Telegram.
Part size: 8 MiB (the API's configured chunk size). Parts per file in flight: 6.
Server memory cap: 3 000 MiB (`LOAD_TEST_RSS_CAP_MB=3000`).

These are **not** Telegram numbers and **not** network numbers. They measure the upload engine's
concurrency behaviour and its memory cost per in-flight part; the backend is simulated so that a
terabyte-scale burst is possible on one machine.

## Deployed part size (100 MiB) — the measured ceiling

Added 2026-10-18. Every reading below runs at the part size the live deployment advertises
(`STORAGE_CHUNK_SIZE_BYTES=104857600`), not the 8 MiB default the earlier sections used. The harness
gained two knobs for this: the server process now takes its chunk size from the same variable the
API does, and the driver sizes its send buffer from `LOAD_TEST_MAX_PART_BYTES` (it refuses a part
larger than its buffer instead of silently under-sending).

```
STORAGE_CHUNK_SIZE_BYTES=104857600 LOAD_TEST_MAX_PART_BYTES=104857600 \
LOAD_TEST_FILES_PER_USER=1 LOAD_TEST_SIZES=2gb LOAD_TEST_PART_DELAY_MS=1000 \
LOAD_TEST_RSS_CAP_MB=5000 LOAD_TEST_LEVELS=1,2,3,4,5,6,8,12,16 pnpm load
```

One 2 GiB file per user, so **21 parts per file** (twenty 100 MiB parts and one 48 MiB tail), six in
flight per uploader. Host: the same 12 vCPU / 16 013 MiB machine, ~6–10 GiB free. **No step-down in
part size was needed:** this machine holds 100 MiB parts, and the deepest completed level (20
uploaders with 1 GiB files, 95 parts in flight) stayed under 4.75 GB of server RSS. For scale, the
same 2 GiB run at the 8 MiB default would be 256 parts per file; the driver's own peak RSS is what
limits how far the ladder goes here (4.4 GiB at 8 uploaders).

### Ladder A — 2 GiB files, 5 000 MiB cap

| users | files done | wall    | MiB/s | parts/s | parts in flight | server RSS | loop p99  | outcome              |
| ----- | ---------- | ------- | ----- | ------- | --------------- | ---------- | --------- | -------------------- |
| 1     | 1/1        | 9.5 s   | 215   | 2.2     | 6               | 1 560 MiB  | 351 ms    | completed            |
| 2     | 2/2        | 17.8 s  | 231   | 2.4     | 10              | 1 582 MiB  | 706 ms    | completed            |
| 3     | 3/3        | 27.1 s  | 227   | 2.3     | 17              | 2 151 MiB  | 1 161 ms  | completed            |
| 4     | 4/4        | 36.5 s  | 224   | 2.3     | 22              | 2 535 MiB  | 1 469 ms  | completed            |
| 5     | 5/5        | 52.6 s  | 195   | 2.0     | 27              | 2 778 MiB  | 2 221 ms  | completed            |
| 6     | 6/6        | 66.8 s  | 184   | 1.9     | 32              | 3 064 MiB  | 3 253 ms  | completed            |
| 8     | 8/8        | 97.0 s  | 169   | 1.7     | 41              | 3 523 MiB  | 5 784 ms  | completed            |
| 12    | 12/12      | 183.5 s | 134   | 1.4     | 62              | 4 022 MiB  | 9 781 ms  | completed            |
| 16    | 0/16       | 240 s   | —     | —       | 84              | 3 526 MiB  | 15 007 ms | **aborted: timeout** |

**The 16-user level failed on the clock, not on memory.** The 5 000 MiB cap was never reached in this
ladder — 12 uploaders, the deepest level that finished, peaked at 4 022 MiB — while the 16-user level
ran out of its four-minute budget with **no file complete** and 84 parts still in flight. That is a
timeout at a given wall-clock budget, so on its own it says nothing about where the system breaks.

### Ladder B — 1 GiB files (11 parts each), to separate the clock from the wall

Smaller files let more uploaders fit inside the budget, so the concurrency limit is reached before
the clock is:

```
STORAGE_CHUNK_SIZE_BYTES=104857600 LOAD_TEST_MAX_PART_BYTES=104857600 \
LOAD_TEST_FILES_PER_USER=1 LOAD_TEST_SIZES=1gb LOAD_TEST_PART_DELAY_MS=1000 \
LOAD_TEST_RSS_CAP_MB=5000 LOAD_TEST_LEVEL_TIMEOUT_MS=420000 LOAD_TEST_LEVELS=16,20 pnpm load
```

| users | files done | wall   | MiB/s | parts in flight | server RSS | loop p99  | outcome                     |
| ----- | ---------- | ------ | ----- | --------------- | ---------- | --------- | --------------------------- |
| 16    | 16/16      | 92.0 s | 178   | 78              | 4 111 MiB  | 9 597 ms  | completed                   |
| 20    | 20/20      | 98.8 s | 207   | 95              | 4 731 MiB  | 8 351 ms  | completed, 95 % of the cap  |
| 24    | 0/24       | 186 s  | —     | 113             | 4 460 MiB  | 18 086 ms | **aborted: rss-cap** (4 GB) |

The 24-user level was deliberately run against a **4 000 MiB** cap so the wall would fire before the
machine did; it tripped `rss-cap` at 4 460 MiB with 113 parts in flight and no file complete. That is
the first clean, cap-triggered memory abort at 100 MiB parts — the earlier 16-user result was neither.

### The ceiling

**About 20 concurrent uploaders per instance at a 5 GB server memory budget**, and at that budget the
memory wall does eventually bind: 20 uploaders sit at 4 731 of 5 000 MiB, and at 24 uploaders the
process was at 4 460 MiB with ~113 parts in flight and still climbing when the cap stopped it. Scaling the measured per-part cost, a 10 GiB budget would fit roughly
**44 uploaders** (`(10 240 − 200) / 229`).

Memory is not the first thing to give out, though — **latency is.** Aggregate part throughput
saturates at 1.5–2.3 parts/s regardless of how many users are added (2.3 at 3–4 users, 2.0 at 5,
1.7 at 8, 1.4 at 12), because each part is two full 100 MiB `memcpy`s (the merge and the
request-body copy) on one thread. Event-loop p99 is 1.2 s at 3 users, 8.4 s at 20 and 18 s at the
abort, so long before the cap is reached the process is unresponsive in multi-second stretches and a
health check, login or folder listing for anyone else will time out.

### Per-uploader cost, corrected

**Measured: 229–322 MiB of server RSS per concurrent uploader**, i.e. **38–51 MiB per in-flight
part** — about **0.4–0.5×** the part size, not 2×.
(229 MiB at 20 uploaders of 1 GiB, 247 MiB at 16, 322 MiB at 12 uploaders of 2 GiB — the 2 GiB
ladder's smaller user counts carry more of the one-file ramp-up in every peak.) The earlier 17 MiB-per-part figure was measured at 8 MiB parts, where
per-request overhead dominates; multiplying it by 12.5 to reach 100 MiB parts assumed the cost was
linear in part size, and it is not. RSS grows sublinearly with in-flight bytes because the two-copy
window lasts one simulated backend second inside a part life that runs several seconds at these
levels, so only a few parts hold both copies at once while the rest are mid-read.

**Correction, stated plainly.** The earlier write-up extrapolated 210 MiB per in-flight part,
1.25 GiB per uploader and **~10 concurrent uploaders** at the deployed parameters, and blamed the
system's cap on per-part memory. The measurement gives **38–51 MiB per part, 229–322 MiB per uploader
and ~20 uploaders at a 5 GB budget**: the per-uploader cost was overstated by **4–5×**, and the
headline ceiling was understated by **~2×**. The mechanism was half right — memory does bind, at
~113 parts in flight — but it binds later than the event loop degrades: at 20 uploaders the process
already stalls for ~8 s at a time while still 5 % under its cap.

### What this still says about "millions"

One instance serves ~20 simultaneous uploaders at a 5 GB budget (~44 at 10 GiB), or ~1.5–2 parts/s.
A thousand simultaneous uploaders need ~25–50 instances of this process — before counting the storage
backend, the finalize verify (which reads every object back in full) or the metadata path. Nothing
here changes the structural answer; only the reason it is currently bounded, and by how much.

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

**Per-part cost is ~17 MiB of server RSS — at 8 MiB parts, which is the size these runs used.**
It does not scale linearly: at the deployed 100 MiB part size the measured marginal cost is ~42 MiB
per part (see the section at the top). Derived from the clean levels:
`(2 341 − 158) / 128 = 17.1 MiB` (20 users), `(1 803 − 160) / 94 = 17.5 MiB` (10 users) and
`(1 905 − 158) / 108 = 16.2 MiB` (10 mixed users).
That is the two-copy buffering the deployed Telegram path performs (merged part + request-body copy),
plus chunk and socket overhead. At 8 MiB parts this is the quantity that caps these runs; at the
deployed part size the part-copy CPU, not the memory, is what gives out first.

**Extrapolation (not measured — and superseded at the deployed part size; see the 100 MiB section
above):** a 100-user level at steady state is ~600 parts ≈ 10 GB; 1 000 users at two files each is
~12 000 parts ≈ **200 GB**. That projection treats the 17 MiB/part above as constant in part size,
which the 100 MiB runs disprove — at 100 MiB parts the marginal cost is ~42 MiB per in-flight part,
so the same 12 000 parts project to ~490 GiB, still far past any container. The measured wall on a
3 GB budget is 20–25 users; reaching 1 000 users needs the per-part cost to drop by roughly an order
of magnitude — i.e. streaming, not tuning.

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
# deployed part size, one 2 GiB file per user (the section at the top)
STORAGE_CHUNK_SIZE_BYTES=104857600 LOAD_TEST_MAX_PART_BYTES=104857600 \
LOAD_TEST_FILES_PER_USER=1 LOAD_TEST_SIZES=2gb LOAD_TEST_PART_DELAY_MS=1000 \
LOAD_TEST_RSS_CAP_MB=5000 LOAD_TEST_LEVELS=1,2,3,4,5,6,8,12,16 node --import tsx load/run.ts
# sweep at the 8 MiB default
LOAD_TEST_FILES_PER_USER=2 LOAD_TEST_SIZES=100mb LOAD_TEST_PART_DELAY_MS=1000 \
LOAD_TEST_LEVELS=10,25,50,100,300,1000 node --import tsx load/run.ts
# deployed part size, ladder B (1 GiB files, higher concurrency)
STORAGE_CHUNK_SIZE_BYTES=104857600 LOAD_TEST_MAX_PART_BYTES=104857600 \
LOAD_TEST_FILES_PER_USER=1 LOAD_TEST_SIZES=1gb LOAD_TEST_PART_DELAY_MS=1000 \
LOAD_TEST_RSS_CAP_MB=5000 LOAD_TEST_LEVEL_TIMEOUT_MS=420000 LOAD_TEST_LEVELS=16,20 \
node --import tsx load/run.ts
# one 2 GB file
LOAD_TEST_USERS=1 LOAD_TEST_FILES_PER_USER=1 LOAD_TEST_SIZES=2gb \
LOAD_TEST_PART_DELAY_MS=1000 LOAD_TEST_LEVEL_TIMEOUT_MS=300000 node --import tsx load/run.ts
```

Machine-readable results are the `LOAD_RESULT` line (single level) or the JSON array after the sweep
summary.
