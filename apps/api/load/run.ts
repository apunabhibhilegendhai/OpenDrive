import { spawn } from 'node:child_process';
import { createHmac, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { freemem, totalmem } from 'node:os';
import { fileURLToPath } from 'node:url';

/**
 * Upload load harness — the driver.
 *
 * Drives the *public HTTP surface* of the real API over real sockets: POST /uploads, PUT parts,
 * POST complete and the finalize poll. The API itself runs in a child process (`server-process.ts`)
 * so the reported peak RSS belongs to the server, not to the synthetic client sharing its heap.
 *
 * Two substitutions, both printable in the result: the metadata driver is an in-memory double
 * (`db-double.ts`) because this environment has no PostgreSQL, and the storage backend discards
 * bytes (`discard-provider.ts`) instead of going to Telegram. Session records, quota holds,
 * capacity checks, part admission, finalize jobs and every route are the shipping code.
 *
 * Two modes:
 *   one level:  LOAD_TEST_USERS=100 pnpm load
 *   a sweep:    pnpm load          — each level in its own process, so a level that exhausts memory
 *                                    cannot take the sweep down with it
 */

const RESULT_PREFIX = 'LOAD_RESULT ';
const SERVER_READY_PREFIX = 'LOAD_SERVER_READY ';
const SERVER_SAMPLE_PREFIX = 'LOAD_SERVER_SAMPLE ';
const TEST_JWT_SECRET = 'load-harness-secret-not-used-anywhere-else';
const TEST_ISSUER = 'https://load-harness.invalid/auth/v1';
const TEST_AUDIENCE = 'authenticated';
/** The schema default for `profiles.storage_quota_bytes`. */
const DEFAULT_USER_QUOTA_BYTES = 5_368_709_120;
/** The API's real per-principal open-session cap; the harness must not quietly exceed it. */
const MAX_FILES_PER_USER = 3;
/** The API's configured part size (`STORAGE_CHUNK_SIZE_BYTES` default). */
const MAX_PART_BYTES = 8 * 1024 * 1024;

interface LevelOptions {
  users: number;
  filesPerUser: number;
  sizesBytes: number[];
  partConcurrency: number;
  pollIntervalMs: number;
  partDelayMs: number;
  bufferParts: boolean;
  rssCapMiB: number;
  levelTimeoutMs: number;
  userQuotaBytes: number;
  rateLimitEnabled: boolean;
}

interface FailureSample {
  code: string;
  detail: string;
  count: number;
}

interface LevelResult {
  mode: 'discard';
  users: number;
  filesPerUser: number;
  sizesBytes: number[];
  partConcurrency: number;
  partDelayMs: number;
  bufferParts: boolean;
  rateLimitEnabled: boolean;
  userQuotaBytes: number;
  usersTotal: number;
  usersCompleted: number;
  usersFailed: number;
  /** Labels of users with at least one failed file, capped so a total failure stays readable. */
  failedUsers: string[];
  filesTotal: number;
  filesCompleted: number;
  filesFailed: number;
  aborted: 'rss-cap' | 'timeout' | null;
  bytesAdvertised: number;
  bytesReceived: number;
  wallMs: number;
  throughputMiBps: number;
  fileMs: { p50: number; p95: number; max: number };
  peakInFlightParts: number | null;
  serverBaselineRssMiB: number | null;
  serverPeakRssMiB: number | null;
  driverPeakRssMiB: number;
  rssCapMiB: number | null;
  serverPeakExternalMiB: number | null;
  serverEventLoopP99Ms: number | null;
  serverEventLoopMaxMs: number | null;
  metadataQueries: number | null;
  /** True when the run drove a deployment given by LOAD_TEST_BASE_URL. */
  externalTarget: boolean;
  failures: FailureSample[];
  note: string;
}

interface ServerStats {
  baselineRssMiB: number;
  peakRssMiB: number;
  peakExternalMiB: number;
  peakInFlightParts: number;
  loopP99Ms: number;
  loopMaxMs: number;
  metadataQueries: number;
}

interface ServerHandle {
  readonly port: number;
  stats: () => ServerStats;
  stop: () => Promise<void>;
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative number, received "${raw}"`);
  }
  return Math.floor(parsed);
}

function envBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  throw new Error(`${name} must be "true" or "false", received "${raw}"`);
}

/** `100mb`, `2gb`, `1024` — a size list for the run. */
function parseSizes(raw: string): number[] {
  const sizes = raw.split(',').map((piece) => {
    const text = piece.trim().toLowerCase();
    const match = /^(\d+(?:\.\d+)?)\s*(kb|mb|gb)?$/.exec(text);
    if (match === null) throw new Error(`Cannot read size "${piece}" in LOAD_TEST_SIZES`);
    const amount = Number(match[1]);
    const unit = match[2] ?? '';
    const factor = unit === 'gb' ? 1024 ** 3 : unit === 'mb' ? 1024 ** 2 : unit === 'kb' ? 1024 : 1;
    return Math.floor(amount * factor);
  });
  for (const size of sizes) {
    if (size <= 0) throw new Error('Every LOAD_TEST_SIZES entry must be greater than zero');
  }
  return sizes;
}

function readLevelOptions(users: number): LevelOptions {
  const filesPerUser = envInt('LOAD_TEST_FILES_PER_USER', 2);
  if (filesPerUser < 1 || filesPerUser > MAX_FILES_PER_USER) {
    throw new Error(
      `LOAD_TEST_FILES_PER_USER must be between 1 and ${MAX_FILES_PER_USER}: the API allows at ` +
        'most three open upload sessions per principal, and the harness does not raise that limit.',
    );
  }
  return {
    users,
    filesPerUser,
    sizesBytes: parseSizes(process.env.LOAD_TEST_SIZES ?? '100mb,2gb'),
    partConcurrency: Math.max(1, envInt('LOAD_TEST_PART_CONCURRENCY', 6)),
    pollIntervalMs: Math.max(5, envInt('LOAD_TEST_POLL_MS', 50)),
    partDelayMs: envInt('LOAD_TEST_PART_DELAY_MS', 0),
    bufferParts: envBool('LOAD_TEST_BUFFER_PARTS', true),
    rssCapMiB: envInt('LOAD_TEST_RSS_CAP_MB', 3000),
    levelTimeoutMs: envInt('LOAD_TEST_LEVEL_TIMEOUT_MS', 120_000),
    userQuotaBytes: envInt('LOAD_TEST_USER_QUOTA_BYTES', DEFAULT_USER_QUOTA_BYTES),
    rateLimitEnabled: envBool('LOAD_TEST_RATE_LIMIT', false),
  };
}

/**
 * A locally signed access token — the same HS256 path the integration suite proves.
 *
 * The secret/issuer/audience can be overridden so the same driver can point at a deployment that
 * verifies HS256 tokens (`LOAD_TEST_JWT_SECRET`, `LOAD_TEST_JWT_ISSUER`, `LOAD_TEST_JWT_AUDIENCE`).
 * Against a deployment with asymmetric keys, supply real tokens with `LOAD_TEST_TOKEN_FILE` instead.
 */
function signToken(userId: string): string {
  const secret = process.env.LOAD_TEST_JWT_SECRET ?? TEST_JWT_SECRET;
  const issuer = process.env.LOAD_TEST_JWT_ISSUER ?? TEST_ISSUER;
  const audience = process.env.LOAD_TEST_JWT_AUDIENCE ?? TEST_AUDIENCE;
  const encode = (value: unknown): string =>
    Buffer.from(JSON.stringify(value)).toString('base64url');
  const issuedAt = Math.floor(Date.now() / 1000);
  const header = encode({ alg: 'HS256', typ: 'JWT' });
  const payload = encode({
    sub: userId,
    role: 'authenticated',
    aud: audience,
    iss: issuer,
    iat: issuedAt,
    exp: issuedAt + 3600,
  });
  const signature = createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url');
  return `${header}.${payload}.${signature}`;
}

/** One bearer token per line, for a deployment whose keys cannot be reproduced locally. */
function loadTokens(): string[] | null {
  const path = process.env.LOAD_TEST_TOKEN_FILE;
  if (path === undefined || path.trim() === '') return null;
  const tokens = readFileSync(path, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (tokens.length === 0) throw new Error(`LOAD_TEST_TOKEN_FILE (${path}) contains no tokens`);
  return tokens;
}

interface Problem {
  code: string;
  detail: string;
}

async function failureOf(response: Response): Promise<Problem> {
  let code = 'UNEXPECTED_RESPONSE';
  let detail = `HTTP ${response.status}`;
  try {
    const body = (await response.json()) as { code?: unknown; detail?: unknown };
    if (typeof body.code === 'string') code = body.code;
    if (typeof body.detail === 'string') detail = body.detail;
  } catch {
    // A non-JSON body leaves the status as the only fact available.
  }
  return { code, detail };
}

/** Starts the API process and waits until it has bound a port. */
function startServer(): Promise<ServerHandle> {
  const script = fileURLToPath(new URL('./server-process.ts', import.meta.url));
  const child = spawn(process.execPath, ['--import', 'tsx', script], {
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stats: ServerStats = {
    baselineRssMiB: 0,
    peakRssMiB: 0,
    peakExternalMiB: 0,
    peakInFlightParts: 0,
    loopP99Ms: 0,
    loopMaxMs: 0,
    metadataQueries: 0,
  };
  let stderr = '';
  let settled = false;

  return new Promise((resolve, reject) => {
    const readyTimeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      reject(new Error(`server did not become ready in 30s\n${stderr.slice(-2000)}`));
    }, 30_000);

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });

    let pending = '';
    child.stdout.on('data', (chunk: string) => {
      pending += chunk;
      let index = pending.indexOf('\n');
      while (index !== -1) {
        const line = pending.slice(0, index);
        pending = pending.slice(index + 1);
        if (line.startsWith(SERVER_READY_PREFIX)) {
          if (settled) return;
          settled = true;
          clearTimeout(readyTimeout);
          const ready = JSON.parse(line.slice(SERVER_READY_PREFIX.length)) as { port: number };
          resolve({
            port: ready.port,
            stats: () => stats,
            stop: async () => {
              if (child.exitCode !== null) return;
              const closed = new Promise<void>((done) => {
                child.once('close', () => done());
              });
              child.kill('SIGTERM');
              const forced = setTimeout(() => child.kill('SIGKILL'), 5000);
              await closed;
              clearTimeout(forced);
            },
          });
        } else if (line.startsWith(SERVER_SAMPLE_PREFIX)) {
          const sample = JSON.parse(line.slice(SERVER_SAMPLE_PREFIX.length)) as {
            rssMiB: number;
            externalMiB: number;
            inFlightParts: number;
            peakInFlightParts: number;
            loopP99Ms: number;
            loopMaxMs: number;
            metadataQueries: number;
          };
          if (stats.baselineRssMiB === 0) stats.baselineRssMiB = sample.rssMiB;
          if (sample.rssMiB > stats.peakRssMiB) stats.peakRssMiB = sample.rssMiB;
          if (sample.externalMiB > stats.peakExternalMiB)
            stats.peakExternalMiB = sample.externalMiB;
          if (sample.peakInFlightParts > stats.peakInFlightParts) {
            stats.peakInFlightParts = sample.peakInFlightParts;
          }
          if (sample.loopP99Ms > stats.loopP99Ms) stats.loopP99Ms = sample.loopP99Ms;
          if (sample.loopMaxMs > stats.loopMaxMs) stats.loopMaxMs = sample.loopMaxMs;
          stats.metadataQueries = sample.metadataQueries;
        }
        index = pending.indexOf('\n');
      }
    });

    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(readyTimeout);
      reject(error);
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(readyTimeout);
      reject(
        new Error(`server exited before ready (exit ${String(code)})\n${stderr.slice(-2000)}`),
      );
    });
  });
}

interface FileTask {
  /** Filename label; a user id locally, a token-file index against a deployment. */
  label: string;
  index: number;
  sizeBytes: number;
  token: string;
}

interface RunShared {
  /**
   * One immutable blob for every part of every file, sliced per part. A `Uint8Array` body is copied
   * by the HTTP client per request, which would make the synthetic client the memory bottleneck it
   * is supposed to be measuring; a Blob slice allocates nothing.
   */
  body: Blob;
  maxPartBytes: number;
  options: LevelOptions;
  signal: AbortSignal;
  deadline: number;
}

/** One file, end to end, through the published routes and published response shapes. */
async function uploadOneFile(
  origin: string,
  token: string,
  task: FileTask,
  shared: RunShared,
): Promise<number> {
  const { options, signal, deadline } = shared;
  if (signal.aborted) throw new Error('ABORTED: run stopped before this file started');

  const initiate = await fetch(`${origin}/api/v1/uploads`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      filename: `load-${task.label}-${task.index}.bin`,
      sizeBytes: task.sizeBytes,
      mimeType: 'application/octet-stream',
      visibility: 'private',
    }),
    signal,
  });
  if (initiate.status !== 201) {
    const problem = await failureOf(initiate);
    throw new Error(`${problem.code}: ${problem.detail}`);
  }
  const opened = (await initiate.json()) as { uploadId: string; chunkSizeBytes: number };
  const partSize = opened.chunkSizeBytes;
  const partCount = Math.ceil(task.sizeBytes / partSize);
  if (partSize > shared.maxPartBytes) {
    throw new Error(
      `HARNESS: the API advertised a ${partSize}-byte part, above this driver's ` +
        `${shared.maxPartBytes}-byte send buffer`,
    );
  }

  let nextPart = 1;
  const worker = async (): Promise<void> => {
    while (true) {
      const partNumber = nextPart;
      nextPart += 1;
      if (partNumber > partCount) return;
      if (signal.aborted) throw new Error('ABORTED: run stopped mid-file');
      if (Date.now() > deadline)
        throw new Error(`TIMEOUT: run budget expired at part ${partNumber}`);
      const offset = (partNumber - 1) * partSize;
      const length = Math.min(partSize, task.sizeBytes - offset);
      const response = await fetch(
        `${origin}/api/v1/uploads/${opened.uploadId}/parts/${partNumber}`,
        {
          method: 'PUT',
          headers: {
            authorization: `Bearer ${token}`,
            'content-type': 'application/octet-stream',
            'content-length': String(length),
          },
          body: shared.body.slice(0, length),
          signal,
        },
      );
      if (response.status !== 200) {
        const problem = await failureOf(response);
        throw new Error(`${problem.code}: ${problem.detail}`);
      }
      await response.arrayBuffer();
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(options.partConcurrency, partCount) }, () => worker()),
  );

  // Large objects answer 202 and are polled until servable, exactly as the browser client does.
  while (true) {
    if (signal.aborted) throw new Error('ABORTED: run stopped during finalize');
    if (Date.now() > deadline) throw new Error('TIMEOUT: finalize did not settle in budget');
    const complete = await fetch(`${origin}/api/v1/uploads/${opened.uploadId}/complete`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      signal,
    });
    if (complete.status === 200) {
      await complete.arrayBuffer();
      return task.sizeBytes;
    }
    if (complete.status === 202) {
      await complete.arrayBuffer();
      await new Promise((resolve) => {
        setTimeout(resolve, options.pollIntervalMs);
      });
      continue;
    }
    const problem = await failureOf(complete);
    throw new Error(`${problem.code}: ${problem.detail}`);
  }
}

function percentile(values: readonly number[], fraction: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.floor(sorted.length * fraction));
  return Math.round(sorted[index] ?? 0);
}

async function runLevel(options: LevelOptions): Promise<LevelResult> {
  // External mode: drive a deployment instead of starting one. Server-side memory is then not
  // observable from here, so those fields report null rather than a number this process cannot see.
  const externalBaseUrl = process.env.LOAD_TEST_BASE_URL?.replace(/\/+$/, '') ?? null;
  const server = externalBaseUrl === null ? await startServer() : null;
  const origin = externalBaseUrl ?? `http://127.0.0.1:${server?.port ?? 0}`;
  const controller = new AbortController();
  const deadline = Date.now() + options.levelTimeoutMs;
  const startedAt = Date.now();

  // One buffer for every part in the run, wrapped once in a Blob so each request sends a slice
  // rather than a copy. The driver must not become the memory bottleneck it is measuring.
  const sharedBody = new Blob([new Uint8Array(MAX_PART_BYTES)]);
  let driverPeakRssMiB = Math.round(process.memoryUsage().rss / 1024 / 1024);
  let aborted: LevelResult['aborted'] = null;
  const stop = (reason: 'rss-cap' | 'timeout'): void => {
    if (aborted !== null) return;
    aborted = reason;
    controller.abort();
  };
  const sampler = setInterval(() => {
    const driverRss = Math.round(process.memoryUsage().rss / 1024 / 1024);
    if (driverRss > driverPeakRssMiB) driverPeakRssMiB = driverRss;
    if (server !== null && server.stats().peakRssMiB >= options.rssCapMiB) stop('rss-cap');
    if (Date.now() > deadline) stop('timeout');
  }, 50);

  const failures = new Map<string, FailureSample>();
  const latencies: number[] = [];
  const tokens = loadTokens();
  if (tokens !== null && tokens.length < options.users) {
    throw new Error(
      `LOAD_TEST_TOKEN_FILE has ${tokens.length} token(s) but the run has ${options.users} users; ` +
        'each synthetic user needs its own credential',
    );
  }
  const tasks: FileTask[] = [];
  for (let user = 0; user < options.users; user += 1) {
    const userId = randomUUID();
    const label = tokens === null ? `user-${user}` : `token-${user}`;
    const token = tokens === null ? signToken(userId) : (tokens[user] as string);
    for (let index = 0; index < options.filesPerUser; index += 1) {
      tasks.push({
        label,
        index,
        sizeBytes: options.sizesBytes[index % options.sizesBytes.length] ?? options.sizesBytes[0]!,
        token,
      });
    }
  }

  const fileTasks = tasks.map(async (task) => {
    const fileStarted = Date.now();
    try {
      await uploadOneFile(origin, task.token, task, {
        body: sharedBody,
        maxPartBytes: MAX_PART_BYTES,
        options,
        signal: controller.signal,
        deadline,
      });
      latencies.push(Date.now() - fileStarted);
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const code = message.includes(':') ? (message.split(':')[0] ?? 'ERROR') : 'ERROR';
      const existing = failures.get(code);
      if (existing === undefined) {
        failures.set(code, { code, detail: message.slice(0, 200), count: 1 });
      } else {
        existing.count += 1;
      }
      return false;
    }
  });

  // One barrier: every file for every user starts in the same tick, so the API sees the burst a
  // fleet of browsers would produce rather than a ramp the harness invented.
  const outcomes = await Promise.all(fileTasks);

  clearInterval(sampler);
  const wallMs = Date.now() - startedAt;
  const stats = server?.stats() ?? null;
  await server?.stop();

  const completed = outcomes.filter(Boolean).length;
  const bytesReceived = tasks
    .filter((_task, index) => outcomes[index] === true)
    .reduce((total, task) => total + task.sizeBytes, 0);

  // A user counts as succeeded only when every one of their files completed.
  const perUser = new Map<string, number>();
  tasks.forEach((task, index) => {
    const failuresForUser = perUser.get(task.label) ?? 0;
    perUser.set(task.label, failuresForUser + (outcomes[index] === true ? 0 : 1));
  });
  const usersCompleted = [...perUser.values()].filter((failed) => failed === 0).length;
  const failedUsers = [...perUser.entries()]
    .filter(([, failed]) => failed > 0)
    .map(([label]) => label)
    .slice(0, 20);

  return {
    mode: 'discard',
    users: options.users,
    filesPerUser: options.filesPerUser,
    sizesBytes: options.sizesBytes,
    partConcurrency: options.partConcurrency,
    partDelayMs: options.partDelayMs,
    bufferParts: options.bufferParts,
    rateLimitEnabled: options.rateLimitEnabled,
    userQuotaBytes: options.userQuotaBytes,
    usersTotal: options.users,
    usersCompleted,
    usersFailed: options.users - usersCompleted,
    failedUsers,
    filesTotal: tasks.length,
    filesCompleted: completed,
    filesFailed: tasks.length - completed,
    aborted,
    bytesAdvertised: tasks.reduce((total, task) => total + task.sizeBytes, 0),
    bytesReceived,
    wallMs,
    throughputMiBps:
      Math.round((bytesReceived / 1024 / 1024 / (Math.max(wallMs, 1) / 1000)) * 10) / 10,
    fileMs: {
      p50: percentile(latencies, 0.5),
      p95: percentile(latencies, 0.95),
      max: latencies.length === 0 ? 0 : Math.round(Math.max(...latencies)),
    },
    peakInFlightParts: stats?.peakInFlightParts ?? null,
    serverBaselineRssMiB: stats?.baselineRssMiB ?? null,
    serverPeakRssMiB: stats?.peakRssMiB ?? null,
    driverPeakRssMiB,
    rssCapMiB: server === null ? null : options.rssCapMiB,
    serverPeakExternalMiB: stats?.peakExternalMiB ?? null,
    serverEventLoopP99Ms: stats?.loopP99Ms ?? null,
    serverEventLoopMaxMs: stats?.loopMaxMs ?? null,
    metadataQueries: stats?.metadataQueries ?? null,
    externalTarget: externalBaseUrl !== null,
    failures: [...failures.values()].sort((left, right) => right.count - left.count).slice(0, 8),
    note:
      externalBaseUrl !== null
        ? 'External target: server memory and in-flight part counts are not observable from this ' +
          'process, so they are reported as null. Throughput and latency include the real network.'
        : 'Metadata is an in-memory double and storage discards bytes; session, part, quota and ' +
          'finalize code paths are the shipping ones. RSS is the API process only. Throughput is ' +
          'loopback, not a real network.',
  };
}

/**
 * Output goes to stdout, which is this tool's interface: the summary is for a person and the
 * `LOAD_RESULT` line is for whatever consumes the run.
 */
function write(line: string): void {
  process.stdout.write(`${line}\n`);
}

function shown(value: number | null, suffix = ''): string {
  return value === null ? 'n/a' : `${value}${suffix}`;
}

function printLevel(result: LevelResult): void {
  const verdict =
    result.aborted !== null
      ? `ABORTED (${result.aborted})`
      : result.filesFailed === 0
        ? 'all files completed'
        : `${result.filesFailed} file(s) failed`;
  write(
    `users=${String(result.usersCompleted).padStart(4)}/${String(result.users).padEnd(4)} ok  files=${String(result.filesCompleted).padStart(4)}/` +
      `${String(result.filesTotal).padEnd(4)} ${verdict.padEnd(22)} wall=${result.wallMs}ms  ` +
      `${result.throughputMiBps} MiB/s  parts-in-flight=${shown(result.peakInFlightParts)}  ` +
      `serverRSS=${shown(result.serverPeakRssMiB, ' MiB')} (base ` +
      `${shown(result.serverBaselineRssMiB)})  loop p99=${shown(result.serverEventLoopP99Ms, 'ms')}`,
  );
  for (const failure of result.failures) {
    write(`    ${failure.count}× ${failure.detail}`);
  }
}

function describeDegradation(results: readonly LevelResult[]): string {
  const clean = results.filter((result) => result.aborted === null && result.filesFailed === 0);
  const degraded = results.find((result) => result.aborted !== null || result.filesFailed > 0);
  if (degraded === undefined) {
    return `none observed up to ${results.at(-1)?.users ?? 0} users`;
  }
  const previous = clean.at(-1);
  return (
    `${degraded.users} users (${degraded.aborted ?? `${degraded.filesFailed} failed files`}; ` +
    `${shown(degraded.peakInFlightParts)} parts in flight, ` +
    `${shown(degraded.serverPeakRssMiB, ' MiB')} server RSS)` +
    (previous === undefined ? '' : `; last clean level: ${previous.users} users`)
  );
}

async function sweep(levels: readonly number[]): Promise<void> {
  write(
    `Upload load sweep — levels ${levels.join(', ')} users | ` +
      `${process.env.LOAD_TEST_FILES_PER_USER ?? 2} files/user | sizes ${process.env.LOAD_TEST_SIZES ?? '100mb,2gb'} | ` +
      `buffered parts ${process.env.LOAD_TEST_BUFFER_PARTS ?? 'true'} | ` +
      `simulated backend service time ${process.env.LOAD_TEST_PART_DELAY_MS ?? 0} ms | ` +
      `storage=discard metadata=in-memory`,
  );
  write(
    `host: ${Math.round(totalmem() / 1024 / 1024)} MiB RAM (${Math.round(freemem() / 1024 / 1024)} MiB free), ` +
      `server RSS cap ${process.env.LOAD_TEST_RSS_CAP_MB ?? 3000} MiB per level` +
      (process.env.LOAD_TEST_BASE_URL === undefined
        ? ''
        : ` | external target ${process.env.LOAD_TEST_BASE_URL}`),
  );
  const results: LevelResult[] = [];
  for (const users of levels) {
    const result = await runChildLevel(users);
    results.push(result);
    printLevel(result);
  }
  write('');
  write(`first degradation: ${describeDegradation(results)}`);
  write(`${RESULT_PREFIX}${JSON.stringify(results)}`);
}

/** Runs one level in its own process, so an out-of-memory level cannot end the sweep. */
function runChildLevel(users: number): Promise<LevelResult> {
  const script = fileURLToPath(new URL('./run.ts', import.meta.url));
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', script], {
      env: { ...process.env, LOAD_TEST_CHILD: '1', LOAD_TEST_USERS: String(users) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => {
      const line = stdout
        .split('\n')
        .reverse()
        .find((candidate) => candidate.startsWith(RESULT_PREFIX));
      if (line === undefined) {
        reject(
          new Error(
            `level ${users} produced no result (exit ${String(code)})\n` +
              `${stderr.split('\n').slice(-20).join('\n')}`,
          ),
        );
        return;
      }
      resolve(JSON.parse(line.slice(RESULT_PREFIX.length)) as LevelResult);
    });
  });
}

async function main(): Promise<void> {
  const explicitUsers = process.env.LOAD_TEST_USERS;
  const isChild = process.env.LOAD_TEST_CHILD === '1';
  if (explicitUsers === undefined && !isChild) {
    const levels = (process.env.LOAD_TEST_LEVELS ?? '10,25,50,100,300,1000')
      .split(',')
      .map((piece) => Number.parseInt(piece.trim(), 10))
      .filter((value) => Number.isInteger(value) && value > 0);
    if (levels.length === 0) throw new Error('LOAD_TEST_LEVELS contained no positive level');
    await sweep(levels);
    return;
  }

  const users = envInt('LOAD_TEST_USERS', 100);
  const options = readLevelOptions(users);
  const perUserBytes = options.sizesBytes
    .slice(0, options.filesPerUser)
    .reduce((total, size) => total + size, 0);
  if (perUserBytes > options.userQuotaBytes) {
    throw new Error(
      `each user would upload ${Math.round(perUserBytes / 1024 / 1024)} MiB against a ` +
        `${Math.round(options.userQuotaBytes / 1024 / 1024)} MiB quota; reduce LOAD_TEST_SIZES or ` +
        'LOAD_TEST_FILES_PER_USER, or raise LOAD_TEST_USER_QUOTA_BYTES',
    );
  }

  const result = await runLevel(options);
  if (isChild) {
    printLevel(result);
    write(`${RESULT_PREFIX}${JSON.stringify(result)}`);
    return;
  }
  printLevel(result);
  write('');
  write(JSON.stringify(result, null, 2));
}

await main();
