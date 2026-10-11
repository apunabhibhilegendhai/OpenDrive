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

|                      | `memory-test`                         | `telegram-experimental`                                                                                     | Future providers (candidates, undecided) |
| -------------------- | ------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| Status               | Test double, enabled in dev/test only | Implemented; passes the provider contract suite. Real-API verification pending — see D27                    | Not chosen                               |
| multipartUpload      | yes                                   | yes: objects are split into parts, each uploaded as one chat document                                       | provider-dependent                       |
| singleShotUpload     | yes                                   | yes, capped at the part ceiling: a whole object must fit in one document                                    | usually yes                              |
| resumableUpload      | **no** (process-local)                | **no**: staged part state is process-local; a restart loses in-progress uploads                             | provider-dependent                       |
| rangedRead           | yes                                   | **no**: retrieval is whole-object; parts are concatenated server-side, ranged reads unsupported             | usually yes                              |
| directDownloadUrl    | no                                    | **no**: a Telegram file link embeds the bot token, so links are never issued                                | usually yes                              |
| serverSideChecksum   | yes                                   | no: Telegram publishes no checksum; the provider verifies the whole-object SHA-256 by read-back at finalize | usually yes                              |
| permanentRetention   | **no**                                | **no**: nothing guarantees retention; the platform's own rules and the account state decide                 | provider-dependent                       |
| guaranteedDurability | **no**                                | **no**                                                                                                      | provider-dependent                       |
| deleteIsFinal        | yes                                   | no: deletion removes the messages immediately, but nothing proves the platform does not retain copies       | provider-dependent                       |
| maxObjectSizeBytes   | 16 MiB (configurable)                 | 2 GiB configured target (no hard Telegram ceiling once objects are split into parts)                        | provider-dependent                       |
| minPartSizeBytes     | 1 byte                                | 1 byte                                                                                                      | provider-dependent                       |
| maxPartSizeBytes     | 1 MiB (configurable)                  | 20 MiB — the standard Bot API download ceiling; raise with a Local Bot API server                           | provider-dependent                       |
| Cost                 | free                                  | free, within the account's own limits                                                                       | provider-dependent                       |

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

Consequence for the product: the `STORAGE_PROVIDER=telegram-experimental` setting now resolves
to a **real provider** (experimental, `productionSafe: false`) when the Telegram credentials are
present, and `health()` reports its reachability. However, real-API limits have not been
measured (no bot token/channel in the development environment — see D27), so
`maxFileSizeVerified` stays `false` and uploads remain refused until that verification
happens. The in-memory provider remains a **test double**: bytes live in the process heap, are
lost on restart, are not durable and are not encrypted, and `resolveStorageProvider` refuses it
when `NODE_ENV=production`.

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
