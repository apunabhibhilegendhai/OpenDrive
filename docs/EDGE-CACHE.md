# Edge cache and cacheable delivery

This document describes the local byte cache that sits in front of the storage provider, and the
signed, cacheable `/cdn` URLs that let a browser element or a caching proxy fetch bytes without an
`Authorization` header. It is written to be honest about what the cache is and what it is not.

**It is not a CDN.** It is a single-node, session-scoped **origin cache** on the API host's own
disk. Bytes remain authoritative on the storage provider; the cache is derived state whose loss
costs only speed. See `docs/DECISIONS.md` D45 (the cache) and D46 (delivery URLs).

## 1. Why it exists

The only component allowed to talk to the storage provider is the API. When that provider is
Telegram, a read is throttled to roughly **0.17 MiB/s** (measured), so the second read of a large
object — a video re-fetched as many byte ranges — is painfully slow through the provider each time.
Putting a local copy in front of the provider is the one place a repeat read can get fast without
adding a service, and it costs nothing.

The design rule the cache must not break: **file bytes live on the storage provider, never in
Postgres and never in Redis** (D5, D20). The cache is a local, disposable copy, not a new
authoritative store.

## 2. The cache is a decorator, not a code path

`CachingStorageProvider` (`apps/api/src/storage/cache/caching-provider.ts`) implements the same
`StorageProvider` interface and wraps the resolved provider. It changes exactly one operation:

- **Hit** — `openReadStream` serves the bytes from a local disk blob.
- **Miss** — `openReadStream` streams the bytes through from the provider **and** starts a
  background copy of the whole object into the cache, so the **next** read is local.

Every other method delegates unchanged, and the wrapper publishes the **wrapped provider's own
capabilities** — the cache adds speed, never a capability the provider lacks. It is applied in
`applyEdgeCache` (`apps/api/src/storage/registry.ts`) and wired in `services.ts`. A storage
resolution injected by a test bypasses it, so integration tests observe the provider directly.

### Why background-fill, not synchronous read-through

A video is fetched as many byte ranges, and a **range read cannot populate a whole-object cache
entry**. Filling on the first request — while that request streams through — is what makes the
second range (and every one after it) local, without making the first one wait for a full download.
Two consequences are accepted and stated: the first read of an object is slightly _slower_ than a
direct read (provider read plus a disk write), and a fill costs one full provider read even when only
a small range was requested.

Concurrent range reads of the same object share **one** fill (keyed by the object identity), so a
burst of range requests downloads the object once, not once per request.

## 3. On-disk layout and freshness

`DiskByteCache` (`apps/api/src/storage/cache/disk-byte-cache.ts`) stores, under `EDGE_CACHE_DIR`
(default `.edge-cache`):

```
.edge-cache/
  index.json                 # derived metadata: size, storedAt, lastAccess per key
  blobs/<ab>/<key>           # the bytes, one file per object
  tmp/<key>.<uuid>.tmp       # in-progress fills (never read; renamed into place)
```

- **Key** = `sha256(providerId \0 locator \0 sizeBytes \0 checksumSha256)`. Never the raw locator:
  a Telegram locator can be a credential-bearing path and must not become a filename or appear in a
  directory listing.
- **Atomic publish** — a fill streams to a temp file and is `rename`d into place; the index records
  it only once the bytes are whole, so a reader can never observe a partial blob.
- **Verification on read** — a hit whose blob is missing or the wrong size is treated as a miss and
  dropped, so the filesystem, not the index, is the truth.
- **TTL** — `EDGE_CACHE_TTL_SECONDS` (default 7 days). After that an entry is re-fetched. There is no
  per-request revalidation against the provider: freshness is the TTL plus the object's own
  immutability (a re-upload is a new object with a new key).
- **LRU budget** — `EDGE_CACHE_MAX_BYTES` (default 5 GiB) is a **byte budget, not a size gate**: any
  object size is cacheable, and the least-recently-used entries are evicted on every write to stay
  under it. A fill larger than the whole budget is skipped (it could never be retained).
- **Delete purges** — `deleteObject` removes the cached blob before delegating, so a deleted object
  cannot be served from disk.

`close()` flushes the index best-effort on shutdown; an in-flight fill is abandoned, because the
bytes are on the provider.

## 4. Cacheable delivery URLs

`POST /api/v1/files/:fileId/delivery-url` (owner, scope `files:read`) returns `{ url, path,
expiresAt }`, where `path` is `/cdn/:fileId/:version?token=<token>` on the API origin, outside
`API_PREFIX`.

- **The token** is `base64url("<fileId>.<version>.<expEpochSec>")` + `"."` + a hex HMAC-SHA256 over
  exactly that encoded payload. The key is HKDF-SHA256 (`info` = `opendrive/delivery-url/v1`) of
  `EDGE_DELIVERY_SIGNING_SECRET`, falling back to `PREVIEW_SIGNING_SECRET`, then `IP_HASH_SECRET`.
  With none of the three set, the mint route answers `503` rather than signing under a default key.
  The HKDF domain is distinct from the preview key, so a preview token can never be used as a
  delivery token even when both are configured from one secret.
- **The version** is the **storage-object id** (`sobj_…`). A re-upload is a new object and therefore
  a new URL. This is what makes `Cache-Control: public, max-age, immutable` safe: an old URL can
  never serve the wrong bytes.
- **`GET /cdn/:fileId/:version`** verifies the token, refuses unless the file is servable, refuses
  unless the active object's id equals `version` (otherwise `404` — the old bytes are genuinely
  gone), then streams through the same range machinery as the owner content route: `accept-ranges`,
  `etag` (the object checksum, or its id), `if-none-match` → `304`, `206` / `416` for ranges, and a
  `content-disposition` chosen the same way as every other download. Inline-safe types get
  `cross-origin-resource-policy: cross-origin`; everything else keeps the default same-origin.
- The route is `hide: true` — it answers bytes, not the JSON contract, so it is not part of the
  OpenAPI document.

The owner content route (`GET /api/v1/files/:id/content`) is deliberately **unchanged**: it stays
`private, no-store` and authorization-checked. `security.ts` no longer overwrites a `cache-control`
that a route set for itself, which is what lets `/cdn` be public and the owner route stay private.
`server.ts` redacts the `token` query parameter (and the `preview` parameter and the `/s/<token>`
path) from request logs.

## 5. Configuration

| Variable                       | Default       | Purpose                                                           |
| ------------------------------ | ------------- | ----------------------------------------------------------------- |
| `EDGE_CACHE_ENABLED`           | `true`        | Turn the cache off entirely (reads go straight to the provider).  |
| `EDGE_CACHE_DIR`               | `.edge-cache` | Where blobs and the index live.                                   |
| `EDGE_CACHE_MAX_BYTES`         | `5368709120`  | LRU byte budget (5 GiB). Not a per-file limit.                    |
| `EDGE_CACHE_TTL_SECONDS`       | `604800`      | How long a cached object may be served before it is re-fetched.   |
| `EDGE_DELIVERY_SIGNING_SECRET` | unset         | HMAC key for delivery URLs (falls back to preview, then IP-hash). |
| `EDGE_DELIVERY_TTL_SECONDS`    | `3600`        | Lifetime of one delivery URL.                                     |
| `EDGE_PUBLIC_MAX_AGE_SECONDS`  | `31536000`    | `Cache-Control: max-age` advertised on `/cdn` responses.          |

## 6. Honest limits

- **Session-scoped on the ephemeral host.** On the GitHub Actions runner this cache is **wiped with
  the runner**. It is an origin cache, not a geographically distributed CDN, and nothing is shared
  between nodes: a second instance re-fetches everything. Design is portable to a persistent VPS
  with no code change — point `EDGE_CACHE_DIR` at a persistent volume.
- **Not a global cache.** `public, immutable` on a `/cdn` URL helps a browser or a shared proxy in
  front of _this_ origin; it does not pre-populate anything globally, and a cache miss at any proxy
  still fills from this origin.
- **First read is slower.** A miss costs the provider read plus a disk write. The cache trades the
  first read for every later one.
- **URLs are secrets-adjacent.** A delivery token travels in the URL, so it can leak through a
  `Referer` header, browser history or a proxy log. A short TTL bounds the damage; it does not remove
  it. Anyone who holds a live URL can read the file until it expires.
- **No cross-node eviction.** Eviction is in-process and per-node. That is why
  `maintenance.edge_cache_evict` is _declared_ but not implemented: a single process does not need a
  job to evict, and a multi-node edge would.

## 7. What proves it

- `apps/api/src/storage/cache/caching-provider.test.ts` — the storage contract suite against the
  wrapper, fill-then-serve-without-touching-the-provider, range-from-cache, concurrent-fill
  de-duplication, per-object limit, purge-on-delete, failed-fill-is-a-miss, health reports state.
- `apps/api/src/storage/cache/disk-byte-cache.test.ts` — keying, commit/lookup/purge, partial-entry
  refusal, TTL staleness, LRU eviction, index reload drops missing blobs.
- `apps/api/src/delivery-tokens.test.ts` — mint/verify, expiry, version binding, tamper, wrong
  secret, payload encoding.
- `tests/integration/src/delivery.test.ts` — the mint route and `/cdn` end to end over the real
  decorator: streams without a bearer credential, the second read makes zero provider calls, `206`
  on a range, `ETag` → `304`, a tampered / cross-file / cross-version token is refused, deleting the
  file purges the cached bytes.
