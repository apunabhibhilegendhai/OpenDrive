import { monitorEventLoopDelay } from 'node:perf_hooks';
import { loadConfig } from '../src/config.js';
import { buildServer } from '../src/server.js';
import { createServices } from '../src/services.js';
import type { AppServices } from '../src/services.js';
import type { StorageResolution } from '../src/storage/registry.js';
import { createMetadataDouble } from './db-double.js';
import { DiscardStorageProvider } from './discard-provider.js';

/**
 * The API process for a load level.
 *
 * It is a separate process from the driver on purpose: the number this harness exists to report is
 * the *server's* peak resident memory, and measuring it in the same process as the synthetic client
 * would count the client's own sockets and buffers. Nothing here changes `src/`; the server is
 * `buildServer` with two substitutions (metadata driver, storage backend) and every route,
 * repository, session registry and finalize job is the shipping implementation.
 *
 * It reports by line protocol on stdout, so a driver that never gets a clean shutdown still has the
 * last sample:
 *   LOAD_SERVER_READY {"port":1234}
 *   LOAD_SERVER_SAMPLE {"rssMiB":…,"externalMiB":…,"inFlightParts":…,"loopP99Ms":…,"filesFinalized":…}
 */

const TEST_JWT_SECRET = 'load-harness-secret-not-used-anywhere-else';
const TEST_ISSUER = 'https://load-harness.invalid/auth/v1';
const TEST_AUDIENCE = 'authenticated';

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : fallback;
}

function envBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  return fallback;
}

class CountingDiscardProvider extends DiscardStorageProvider {
  inFlight = 0;
  peakInFlight = 0;
  filesFinalized = 0;

  override async uploadPart(
    session: Parameters<DiscardStorageProvider['uploadPart']>[0],
    part: Parameters<DiscardStorageProvider['uploadPart']>[1],
  ): ReturnType<DiscardStorageProvider['uploadPart']> {
    this.inFlight += 1;
    if (this.inFlight > this.peakInFlight) this.peakInFlight = this.inFlight;
    try {
      return await super.uploadPart(session, part);
    } finally {
      this.inFlight -= 1;
    }
  }

  override async finalizeUpload(
    session: Parameters<DiscardStorageProvider['finalizeUpload']>[0],
  ): ReturnType<DiscardStorageProvider['finalizeUpload']> {
    const stored = await super.finalizeUpload(session);
    this.filesFinalized += 1;
    return stored;
  }
}

/**
 * The part size this level runs at. It must be set in both places it matters: the API's own chunk
 * size (what `POST /uploads` advertises to the driver) and the provider's part ceiling (what the
 * provider accepts). The live deployment configures 100 MiB, so a run that means to reproduce it
 * sets `STORAGE_CHUNK_SIZE_BYTES=104857600` here and `LOAD_TEST_MAX_PART_BYTES` in the driver.
 */
const partSizeBytes = envInt('STORAGE_CHUNK_SIZE_BYTES', 8 * 1024 * 1024);

const provider = new CountingDiscardProvider({
  partDelayMs: envInt('LOAD_TEST_PART_DELAY_MS', 0),
  bufferParts: envBool('LOAD_TEST_BUFFER_PARTS', true),
  maxPartSizeBytes: partSizeBytes,
});

const config = loadConfig({
  NODE_ENV: 'test',
  LOG_LEVEL: 'silent',
  DOCS_ENABLED: 'false',
  RATE_LIMIT_ENABLED: envBool('LOAD_TEST_RATE_LIMIT', false) ? 'true' : 'false',
  MALWARE_SCAN_ENABLED: 'false',
  STORAGE_PROVIDER: 'none',
  STORAGE_CHUNK_SIZE_BYTES: String(partSizeBytes),
  SUPABASE_JWT_SECRET: TEST_JWT_SECRET,
  SUPABASE_JWT_ISSUER: TEST_ISSUER,
  SUPABASE_JWT_AUDIENCE: TEST_AUDIENCE,
  USER_CACHE_ENABLED: 'false',
});

const metadata = createMetadataDouble({
  storageQuotaBytes: envInt('LOAD_TEST_USER_QUOTA_BYTES', 5_368_709_120),
});
const storage: StorageResolution = {
  provider,
  configuredName: 'memory-test',
  detail:
    'Load harness: the storage backend is replaced by a discard provider that reads every byte ' +
    'and keeps none. Session, part, quota and finalize code paths are the real ones.',
  productionSafe: false,
};
const base = createServices(config, { storage });
const services: AppServices = { ...base, db: metadata.client };

const app = await buildServer({ config, services, logger: false });
await app.listen({ host: '127.0.0.1', port: 0, backlog: 4096 });
const address = app.server.address();
if (address === null || typeof address === 'string') {
  throw new Error('load harness server did not bind a TCP port');
}
process.stdout.write(`LOAD_SERVER_READY ${JSON.stringify({ port: address.port })}\n`);

const loop = monitorEventLoopDelay({ resolution: 10 });
loop.enable();

setInterval(() => {
  const usage = process.memoryUsage();
  process.stdout.write(
    `LOAD_SERVER_SAMPLE ${JSON.stringify({
      rssMiB: Math.round(usage.rss / 1024 / 1024),
      externalMiB: Math.round(usage.external / 1024 / 1024),
      inFlightParts: provider.inFlight,
      peakInFlightParts: provider.peakInFlight,
      filesFinalized: provider.filesFinalized,
      loopP99Ms: Math.round((loop.percentile(99) / 1e6) * 100) / 100,
      loopMaxMs: Math.round((loop.max / 1e6) * 100) / 100,
      metadataQueries: metadata.stats.queries,
    })}\n`,
  );
}, 100);

process.on('SIGTERM', () => {
  void app.close().then(
    () => process.exit(0),
    () => process.exit(1),
  );
});
