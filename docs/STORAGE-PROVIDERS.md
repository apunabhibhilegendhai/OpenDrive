# Storage providers

File contents live behind the `StorageProvider` contract in
[packages/shared/src/storage/types.ts](../packages/shared/src/storage/types.ts). This document
is the honest capability matrix and the rules for enabling a provider.

## 1. Why capabilities instead of assumptions

Providers differ in ways that break naive upload code: some cannot do multipart, some cannot
serve byte ranges, some cannot guarantee durability, some hand out direct download URLs that
bypass your own authorization. A provider therefore declares
`StorageCapabilities` (`multipartUpload`, `singleShotUpload`, `resumableUpload`, `rangedRead`,
`directDownloadUrl`, `serverSideChecksum`, `permanentRetention`, `guaranteedDurability`,
`deleteIsFinal`, `maxObjectSizeBytes`, `minPartSizeBytes`, `maxPartSizeBytes`).

`assertCapability(provider, capability, operation)` throws
`STORAGE_CAPABILITY_UNSUPPORTED` when the flag is false, so an unsupported path fails early
and loudly instead of producing a half-written object. A flag may only be `true` if the
contract suite in `packages/shared/src/storage/testing/storage-contract.ts` passes for it.

## 2. Current matrix

|                      | `memory-test`                         | `telegram-experimental`                                                                                                                                                        | Future providers (candidates, undecided) |
| -------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------- |
| Status               | Test double, enabled in dev/test only | Implemented; passes the provider contract suite. Real-API verification pending — see D27                                                                                       | Not chosen                               |
| multipartUpload      | yes                                   | yes: objects are split into parts, each uploaded as one chat document                                                                                                          | provider-dependent                       |
| singleShotUpload     | yes                                   | yes, capped at the part ceiling: a whole object must fit in one document                                                                                                       | usually yes                              |
| resumableUpload      | **no** (process-local)                | **no**: staged part state is process-local; a restart loses in-progress uploads                                                                                                | provider-dependent                       |
| rangedRead           | yes                                   | yes: a range read asks only the parts (and sub-ranges) that cover it, so a partial read of a multi-GiB object never pulls the whole object                                     | usually yes                              |
| directDownloadUrl    | no                                    | **no**: a Telegram file link embeds the bot token, so links are never issued                                                                                                   | usually yes                              |
| serverSideChecksum   | yes                                   | no: Telegram publishes no checksum; the provider verifies the whole-object SHA-256 by read-back at finalize                                                                    | usually yes                              |
| permanentRetention   | **no**                                | **no**: nothing guarantees retention; the platform's own rules and the account state decide                                                                                    | provider-dependent                       |
| guaranteedDurability | **no**                                | **no**                                                                                                                                                                         | provider-dependent                       |
| deleteIsFinal        | yes                                   | no: `deleteMessage` removes the message, but Telegram keeps serving the file (measured live: still downloadable 35s later), so deletion is recorded in-process, never provable | provider-dependent                       |
| maxObjectSizeBytes   | 16 MiB (configurable)                 | 2 GiB configured target (no hard Telegram ceiling once objects are split into parts)                                                                                           | provider-dependent                       |
| minPartSizeBytes     | 1 byte                                | 1 byte                                                                                                                                                                         | provider-dependent                       |
| maxPartSizeBytes     | 1 MiB (configurable)                  | 20 MiB default — the standard Bot API download ceiling; raise it (up to the server's 2000 MB) only with a `--local` Bot API server, see §3.1                                   | provider-dependent                       |
| Cost                 | free                                  | free, within the account's own limits                                                                                                                                          | provider-dependent                       |

`memory-test` is a **test double**: bytes live in the process heap, are lost on restart, are
shared with no other process, are not durable and are not encrypted. `resolveStorageProvider`
refuses it when `NODE_ENV=production` (`apps/api/src/storage/registry.ts`), and a test asserts
that refusal.

## 3. Telegram storage: evaluation, not endorsement

Telegram is treated as an **experimental** backend. It is not "unlimited free storage", and no
document may describe it as such. Concrete concerns, all of which must be resolved before it
is enabled for real files:

1. **Operational limits are not a contract.** Bot API limits (request rate, file size, upload
   methods) change without notice. Any implementation must read the effective limits at
   startup, clamp them against the platform's own limits, and report the smaller number.
2. **Durability is unstated.** There is no per-object durability guarantee, no restoration
   mechanism, and no way to verify that a stored object is still retrievable without trying.
   `guaranteedDurability` and `permanentRetention` therefore stay `false`, and the platform
   must not treat Telegram as the only copy of anything important.
3. **Credential exposure risk.** Direct file links embed the bot token in the URL
   (`https://api.telegram.org/file/bot<token>/<path>`). That URL must never be logged, cached,
   sent to a browser, or stored in `storage_objects.provider_ref`. If direct links are ever
   used, they must be proxied by the API, not handed to clients.
4. **Platform rules and account risk.** Automated bulk storage can violate the platform's
   terms and can lead to rate limiting or account loss, which would take every file with it.
   This is a product and legal decision, not just a technical one.
5. **Not compliant object storage.** No retention policy, no legal hold, no data residency
   controls, no audit surface, no SLA. Retention or deletion claims cannot be made about
   objects stored there.
6. **Size and streaming.** The standard Bot API can upload a document up to its own per-file
   ceiling but can only download single files up to 20 MiB. The provider therefore splits
   objects into parts at or below 20 MiB (default) and streams each part with bounded memory;
   multipart delivery needs no local-disk staging even for multi-gigabyte objects. A
   _whole-object_ (single-shot) upload must fit in one Telegram file, so it is refused above
   the part ceiling. When such an upload arrives as a stream it is spooled once to a temp file
   — never buffered whole in memory — and each attempt streams a fresh copy from disk, so a
   transient failure is retried from byte zero instead of resuming an exhausted stream.
   Retrieval is whole-object: a read streams the concatenation of the parts, and ranged reads
   are not supported. Verification (part of `finalizeUpload`) reads the parts back through a
   bounded window (`maxVerifyConcurrency`, further capped by a byte budget) rather than one at
   a time, because live measurement showed single-stream reads are throttled to ≈0.17 MiB/s
   and a sequential verify would take hours at the 2 GiB target. Each part is read whole so a
   transient drop can be retried from scratch, and every read failure is surfaced as
   `STORAGE_UNAVAILABLE`. Transient upload failures are retried with backoff the same way.

### 3.1 Optional self-hosted Local Bot API server (the route to 2000 MB per file)

The 20 MiB download ceiling and the 50 MB upload ceiling belong to the **public** Bot API, not
to Telegram. A self-hosted [Bot API server](https://github.com/tdlib/telegram-bot-api),
configured with the MTProto application credentials from my.telegram.org (`api_id` /
`api_hash`), can raise them — but **only when it is started with `--local`**. Without `--local`
the server behaves like the cloud API and keeps the same upload/download limits; its `--dir`
merely chooses where files are cached. Raising `TELEGRAM_MAX_PART_SIZE_BYTES` while pointing at
a non-`--local` server does not lift the ceiling and makes large parts fail.

```sh
# --local is the flag that raises the limits; --dir is only the storage location.
telegram-bot-api \
  --api-id="$TELEGRAM_API_ID" \
  --api-hash="$TELEGRAM_API_HASH" \
  --local \
  --http-port=8081 \
  --dir=/var/lib/telegram-bot-api
```

```dotenv
# The app still authenticates with a bot token; only the base URL changes.
STORAGE_PROVIDER=telegram-experimental
TELEGRAM_BOT_TOKEN=<bot token>
TELEGRAM_STORAGE_CHAT_ID=<chat id>
TELEGRAM_API_BASE_URL=http://127.0.0.1:8081
# The Local Bot API server accepts up to 2000 MB per *file*, but the HTTP transport in front
# of the API does not: a Cloudflare-proxied hostname rejects any request body above 100 MiB
# with 413 (measured 2026-10-13). Keep this at the edge ceiling so parts can actually arrive.
TELEGRAM_MAX_PART_SIZE_BYTES=104857600
```

With `--local`, `getFile` returns an **absolute on-disk path** instead of an HTTP URL, so the
provider reads the bytes straight from the filesystem when the API process shares the server's
disk. When it does not (the API runs elsewhere), set both of:

```dotenv
TELEGRAM_WORK_DIR=/var/lib/telegram-bot-api            # the server's --dir
TELEGRAM_FILES_BASE_URL=https://files.example/telegram # a file server exposing --dir
```

The provider then rewrites the absolute path to `${TELEGRAM_FILES_BASE_URL}/<path relative to
TELEGRAM_WORK_DIR>` (an nginx location serving `--dir` works). Without either, a local absolute
path is read from disk; an absolute path with `TELEGRAM_FILES_BASE_URL` but no `TELEGRAM_WORK_DIR`
is refused with a configuration error rather than silently mis-fetched. The public API never
returns absolute paths, so nothing extra is configured for the cloud path.

`api_id` / `api_hash` configure the **server**, not the app: `loadConfig` never reads them, and
they live in `.env` only so an operator keeps them with the rest of the configuration. They do
not replace the bot token — a self-hosted server authenticates the same way the public one does.
Before pointing the app at a new local server, call the Bot API `logOut` method on the bot's
**previous** server (a token is logged in to one server at a time); a bot logged in to two servers
may silently drop updates. The local server speaks plain HTTP only, so put it behind a TLS
termination proxy for any remote access.

> **Confirmed in the upstream README.** `tdlib/telegram-bot-api` states that `--local` is what
> enables features unavailable at `https://api.telegram.org`: "Upload files up to 2000 MB" and
> "Receive the absolute local path as a value of the `file_path` field". Without `--local` the
> server keeps the cloud API's limits, so `--dir` alone changes nothing.

> **Two ceilings, not one.** The server's documented local upload limit is **2000 MB** —
> 2,000,000,000 bytes, _less_ than the 2 GiB product target (`TARGET_MAX_FILE_SIZE_BYTES` =
> 2,147,483,648 bytes). An object at or below 2,000,000,000 bytes is spooled and sent as one
> document (below); a true 2 GiB object still exceeds what a single `--local` send carries and
> keeps multipart delivery. Do **not** raise `TELEGRAM_MAX_PART_SIZE_BYTES` toward the gigabyte
> to shrink the part count: every part travels browser→edge, and the edge rejects a body above
> 100 MiB.

> **The edge caps a request body at 100 MiB — not the Bot API.** `--local` raises Telegram's
> per-file ceiling to 2000 MB, but the API is served through a **Cloudflare-proxied** hostname,
> and Cloudflare rejects any single request whose `Content-Length` exceeds **100 MiB** with
> `413` before it reaches the origin (measured 2026-10-13: 104857600 bytes passes, 105906176
> fails). This is a transport ceiling, not a Telegram one, and it applies to _each part_, so
> neither `TELEGRAM_MAX_PART_SIZE_BYTES` nor `STORAGE_CHUNK_SIZE_BYTES` should exceed
> `104857600` on a proxied hostname. At 100 MiB a 2 GiB object arrives as 21 parts (verified
> byte-exact end to end on 2026-10-13: three parts, SHA-256 match on download). A file that large
> is still stored as **one** Telegram document: when the provider points at the loopback Local
> Bot API server it spools the received parts and sends the reassembled object as a single
> `sendDocument` at finalize, so the chat holds one file rather than N (D39). The browser→edge hop
> remains part-sized; only the server→Telegram hop carries the whole object.

> **Partly verified.** A bot token and a private channel were supplied, and the provider was
> driven against the live Bot API on 2026-10-11 (see D27 and D29). The 2000 MB `--local` ceiling
> and its absolute-path `getFile` behaviour are still unmeasured against a running local server;
> the disk / file-server read paths and the streaming, retrying upload are covered by unit tests
> only.

Consequence for the product: `STORAGE_PROVIDER=telegram-experimental` resolves to a **real
provider** (experimental, `productionSafe: false`) when the Telegram credentials are present, and
`health()` reports its reachability. Single-shot and multipart uploads round-trip correctly against
the live API, but no object near the 2 GiB target has been stored, so `maxFileSizeVerified` stays
`false`; the Phase 2 upload routes are 501 stubs regardless. The in-memory provider remains a
**test double**: bytes live in the process heap, are lost on restart, are not durable and are not
encrypted, and `resolveStorageProvider` refuses it when `NODE_ENV=production`.

## 4. Rules for enabling a provider

1. Implement `StorageProvider` and declare capabilities honestly — no optimistic flags.
2. Pass the contract suite against the real provider, including capability-failure paths.
3. Record the verification in `docs/DECISIONS.md`: what was tested, against what limits, on
   what date, with the measured maximum object size.
4. Only then may `maxFileSizeVerified` become `true`, and only up to the measured size.
5. Wire `health()` into readiness so a broken provider shows as `unavailable` rather than
   failing mid-upload.
6. Never store provider identifiers or locators outside `storage_objects`, and never return
   them from the API.
