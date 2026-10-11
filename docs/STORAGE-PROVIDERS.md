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
| rangedRead           | yes                                   | **no**: retrieval is whole-object; parts are concatenated server-side, ranged reads unsupported                                                                                | usually yes                              |
| directDownloadUrl    | no                                    | **no**: a Telegram file link embeds the bot token, so links are never issued                                                                                                   | usually yes                              |
| serverSideChecksum   | yes                                   | no: Telegram publishes no checksum; the provider verifies the whole-object SHA-256 by read-back at finalize                                                                    | usually yes                              |
| permanentRetention   | **no**                                | **no**: nothing guarantees retention; the platform's own rules and the account state decide                                                                                    | provider-dependent                       |
| guaranteedDurability | **no**                                | **no**                                                                                                                                                                         | provider-dependent                       |
| deleteIsFinal        | yes                                   | no: `deleteMessage` removes the message, but Telegram keeps serving the file (measured live: still downloadable 35s later), so deletion is recorded in-process, never provable | provider-dependent                       |
| maxObjectSizeBytes   | 16 MiB (configurable)                 | 2 GiB configured target (no hard Telegram ceiling once objects are split into parts)                                                                                           | provider-dependent                       |
| minPartSizeBytes     | 1 byte                                | 1 byte                                                                                                                                                                         | provider-dependent                       |
| maxPartSizeBytes     | 1 MiB (configurable)                  | 20 MiB — the standard Bot API download ceiling; raise with a Local Bot API server                                                                                              | provider-dependent                       |
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
   objects into parts at or below 20 MiB (default) and streams each part with bounded memory —
   no local-disk spooling is needed even for multi-gigabyte objects. Retrieval is whole-object:
   a read streams the concatenation of the parts, and ranged reads are not supported.
   Verification (part of `finalizeUpload`) reads the parts back through a bounded window
   (`maxVerifyConcurrency`, further capped by a byte budget) rather than one at a time, because
   live measurement showed single-stream reads are throttled to ≈0.17 MiB/s and a sequential
   verify would take hours at the 2 GiB target. Each part is read whole so a transient drop can
   be retried from scratch, and every read failure is surfaced as `STORAGE_UNAVAILABLE`.

### 3.1 Optional self-hosted Local Bot API server (the route to the 2 GiB target)

The 20 MiB download ceiling belongs to the **public** Bot API, not to Telegram. A self-hosted
[Bot API server](https://github.com/tdlib/telegram-bot-api), configured with the MTProto
application credentials from my.telegram.org (`api_id` / `api_hash`), raises the per-file ceiling
to 2 GB and is the intended way to reach the 2 GiB target without splitting an object into a
hundred parts:

```sh
telegram-bot-api \
  --api-id="$TELEGRAM_API_ID" \
  --api-hash="$TELEGRAM_API_HASH" \
  --http-port=8081 \
  --dir=/var/lib/telegram-bot-api
```

```dotenv
# The app still authenticates with a bot token; only the base URL changes.
STORAGE_PROVIDER=telegram-experimental
TELEGRAM_BOT_TOKEN=<bot token>
TELEGRAM_STORAGE_CHAT_ID=<chat id>
TELEGRAM_API_BASE_URL=http://127.0.0.1:8081
TELEGRAM_MAX_PART_SIZE_BYTES=20971520   # raise toward 2 GiB once the server is in place
```

`api_id` / `api_hash` configure the **server**, not the app: `loadConfig` never reads them, and
they live in `.env` only so an operator keeps them with the rest of the configuration. They do
not replace the bot token — a self-hosted server authenticates the same way the public one does.
Add `--local` only when the API host can read the server's `--dir` directly: it makes `getFile`
return on-disk paths instead of HTTP URLs, which this provider does not read.

> **Partly verified.** A bot token and a private channel were supplied, and the provider was driven
> against the live Bot API on 2026-10-11 (see D27 and D29). The 2 GB `--local` ceiling itself is
> still unmeasured — no local Bot API server is running.

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
