import { createCipheriv, createHash } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { TelegramHttpTransport } from './telegram-transport.js';
import { TelegramStorageProvider } from './telegram.js';

/**
 * Live harness for the single-document 2 GB path.
 *
 * Pushes a single 2 GB (decimal) object as ONE Telegram document through the whole-object
 * path (`uploadWholeObject`), which requires a self-hosted Local Bot API server started with
 * `--local` (see docs/STORAGE-PROVIDERS.md section 3.1). Verifies the SHA-256 by reading the
 * single document back, then deletes it.
 *
 * Gated behind OD_LIVE_SINGLE_2GB=1 so the normal offline suite never touches the network.
 * `.github/workflows/live-telegram-2gb.yml` runs it, on demand, against a `--local` server
 * on the runner; locally it is skipped unless the gate and the connection env are set.
 *
 * The upload is spooled to a temp file (the transport streams it; memory stays bounded), so
 * the test process needs ~2 GB of free disk in the OS temp directory.
 *
 * Environment:
 *   OD_LIVE_SINGLE_2GB=1           gate
 *   TELEGRAM_BOT_TOKEN             bot token (from .env)
 *   TELEGRAM_STORAGE_CHAT_ID       target chat/channel
 *   TELEGRAM_API_BASE_URL          e.g. http://127.0.0.1:8081 (required for --local)
 *   OD_SINGLE_SIZE                 object size in bytes (default 2000000000 = 2000 MB)
 *   OD_SINGLE_READBACK=0           skip the read-back hash pass
 *   TELEGRAM_FILES_BASE_URL        only if the API cannot read the server's disk
 *   TELEGRAM_WORK_DIR              only if using TELEGRAM_FILES_BASE_URL
 */

const KEY = Buffer.alloc(32, 0x5a);
const SIZE = numberFromEnv('OD_SINGLE_SIZE', 2_000_000_000); // 2000 MB, Telegram's --local ceiling
const READ_BACK = process.env.OD_SINGLE_READBACK !== '0';
const LOG = process.env.OD_LOG_FILE ?? '';

function numberFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  const parsed = raw === undefined ? Number.NaN : Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function log(line: string): void {
  console.log(line);
  if (LOG !== '') appendFileSync(LOG, `${new Date().toISOString()} ${line}\n`);
}

let peakRssMiB = 0;
function rssMiB(): number {
  const rss = Math.round(process.memoryUsage().rss / 1024 / 1024);
  peakRssMiB = Math.max(peakRssMiB, rss);
  return rss;
}

/** SHA-256 of the whole AES-256-CTR keystream, computed in bounded chunks. */
function hashWholePattern(size: number): string {
  const hash = createHash('sha256');
  const cipher = createCipheriv('aes-256-ctr', KEY, Buffer.alloc(16));
  const zeros = Buffer.alloc(4 * 1024 * 1024);
  let remaining = size;
  while (remaining > 0) {
    const take = Math.min(remaining, zeros.length);
    hash.update(cipher.update(zeros.subarray(0, take)));
    remaining -= take;
  }
  cipher.final();
  return hash.digest('hex');
}

/** The whole object as one sequential keystream, produced in bounded chunks. */
async function* wholeStream(size: number): AsyncGenerator<Buffer> {
  const cipher = createCipheriv('aes-256-ctr', KEY, Buffer.alloc(16));
  const zeros = Buffer.alloc(4 * 1024 * 1024);
  let remaining = size;
  while (remaining > 0) {
    const take = Math.min(remaining, zeros.length);
    yield cipher.update(zeros.subarray(0, take));
    remaining -= take;
  }
  cipher.final();
}

const botToken = process.env.TELEGRAM_BOT_TOKEN ?? '';
const chatId = process.env.TELEGRAM_STORAGE_CHAT_ID ?? '';
const apiBaseUrl = process.env.TELEGRAM_API_BASE_URL ?? '';
const live =
  process.env.OD_LIVE_SINGLE_2GB === '1' && botToken !== '' && chatId !== '' && apiBaseUrl !== '';

describe('Telegram live single-document 2 GB round trip', () => {
  it.skipIf(!live)(
    'sends 2000 MB as one document, verifies read-back, and deletes',
    async () => {
      const transport = new TelegramHttpTransport({
        botToken,
        chatId,
        apiBaseUrl,
        filesBaseUrl: process.env.TELEGRAM_FILES_BASE_URL,
        workDir: process.env.TELEGRAM_WORK_DIR,
      });
      const provider = new TelegramStorageProvider({
        transport,
        // The whole-object path is gated on this ceiling, so it must admit the full document.
        maxPartSizeBytes: SIZE,
      });

      const expected = hashWholePattern(SIZE);
      log(`[single] size=${SIZE} bytes apiBase=${apiBaseUrl}`);
      log(`[single] expected whole-object SHA-256 = ${expected}`);

      const session = await provider.initiateUpload({
        uploadId: 'upl_live_single',
        fileId: 'file_live_single',
        filename: 'live-single-2gb.bin',
        sizeBytes: SIZE,
        mimeType: 'application/octet-stream',
        chunkSizeBytes: SIZE,
        checksumSha256: expected,
        sessionTtlSeconds: 6 * 60 * 60,
      });

      let stored: Awaited<ReturnType<typeof provider.uploadWholeObject>> | null = null;
      try {
        log('[single] spooling and sending (single document) ...');
        const started = Date.now();
        stored = await provider.uploadWholeObject({
          session,
          source: wholeStream(SIZE),
          sizeBytes: SIZE,
          checksumSha256: expected,
        });
        const seconds = (Date.now() - started) / 1000;
        log(
          `[single] stored in ${seconds.toFixed(0)}s ` +
            `(${(SIZE / 1024 / 1024 / seconds).toFixed(2)} MiB/s, rss ${rssMiB()} MiB), ` +
            `checksum=${stored.checksumSha256}`,
        );
        expect(stored.sizeBytes).toBe(SIZE);
        expect(stored.checksumSha256).toBe(expected);

        const metadata = await provider.getMetadata(stored.ref);
        log(`[single] metadata size=${metadata.sizeBytes} checksum=${metadata.checksumSha256}`);
        expect(metadata.sizeBytes).toBe(SIZE);

        if (READ_BACK) {
          const readStarted = Date.now();
          const result = await provider.openReadStream(stored.ref);
          const readHash = createHash('sha256');
          let readBytes = 0;
          for await (const chunk of result.stream) {
            readHash.update(chunk);
            readBytes += chunk.byteLength;
          }
          const readHex = readHash.digest('hex');
          log(
            `[single] read back ${readBytes} bytes in ${((Date.now() - readStarted) / 1000).toFixed(0)}s -> ${readHex}`,
          );
          expect(readBytes).toBe(SIZE);
          expect(readHex).toBe(expected);
        } else {
          log('[single] skipping read-back pass (OD_SINGLE_READBACK=0)');
        }
        log(`[single] peak observed RSS = ${peakRssMiB} MiB`);
      } finally {
        if (stored !== null) {
          const outcome = await provider.deleteObject(stored.ref);
          log(`[single] delete outcome ${JSON.stringify(outcome)}`);
          await expect(provider.getMetadata(stored.ref)).rejects.toThrow();
        } else {
          await provider.abortUpload(session, 'failed').catch(() => undefined);
          log('[single] aborted; no object finalized');
        }
      }
    },
    6 * 60 * 60 * 1000,
  );
});
