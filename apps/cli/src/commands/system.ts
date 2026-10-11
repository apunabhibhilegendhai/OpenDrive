import {
  healthResponseSchema,
  limitsResponseSchema,
  readinessResponseSchema,
} from '@opendrive/shared';
import { EXIT_OK, EXIT_UNHEALTHY } from '../args.js';
import { fetchJson } from '../http.js';
import { formatBytes, formatDuration } from '../format.js';
import type { CommandContext } from './context.js';

/**
 * System commands.
 *
 * Every response is validated against the shared schema before it is printed: the CLI
 * doubles as a contract check against a running API, so a drifted server is caught by
 * the client instead of being silently rendered.
 */

export async function runHealth(context: CommandContext): Promise<number> {
  const { options, io } = context;
  const response = await fetchJson<unknown>(options.apiUrl, '/healthz', options.timeoutMs);
  const parsed = healthResponseSchema.safeParse(response.body);

  if (!parsed.success) {
    io.err(
      `health: ${options.apiUrl}/healthz answered ${response.status} with an unexpected body.`,
    );
    io.err(`health: first issue: ${parsed.error.issues[0]?.message ?? 'unknown'}`);
    return EXIT_UNHEALTHY;
  }

  if (options.json) {
    io.out(JSON.stringify(parsed.data, null, 2));
  } else {
    io.out(`status      ${parsed.data.status}`);
    io.out(`service     ${parsed.data.service}`);
    io.out(`version     ${parsed.data.version}`);
    io.out(`api         ${parsed.data.apiVersion}`);
    io.out(`uptime      ${formatDuration(parsed.data.uptimeSeconds)}`);
  }
  return response.status === 200 ? EXIT_OK : EXIT_UNHEALTHY;
}

export async function runReadiness(context: CommandContext): Promise<number> {
  const { options, io } = context;
  const response = await fetchJson<unknown>(options.apiUrl, '/readyz', options.timeoutMs);
  const parsed = readinessResponseSchema.safeParse(response.body);

  if (!parsed.success) {
    io.err(
      `readiness: ${options.apiUrl}/readyz answered ${response.status} with an unexpected body.`,
    );
    return EXIT_UNHEALTHY;
  }

  if (options.json) {
    io.out(JSON.stringify(parsed.data, null, 2));
  } else {
    io.out(`status      ${parsed.data.status}`);
    io.out('dependencies');
    for (const dependency of parsed.data.dependencies) {
      const requirement = dependency.required ? 'required' : 'optional';
      io.out(
        `  ${dependency.name.padEnd(10)} ${dependency.status.padEnd(15)} (${requirement}) ${dependency.detail}`,
      );
    }
    if (parsed.data.status !== 'ready') {
      io.err(
        'readiness: not ready. In Phase 0 this is expected until Postgres, Redis and storage are wired up.',
      );
    }
  }
  return parsed.data.status === 'ready' && response.status === 200 ? EXIT_OK : EXIT_UNHEALTHY;
}

export async function runLimits(context: CommandContext): Promise<number> {
  const { options, io } = context;
  const response = await fetchJson<unknown>(options.apiUrl, '/api/v1/limits', options.timeoutMs);
  const parsed = limitsResponseSchema.safeParse(response.body);

  if (!parsed.success) {
    io.err(
      `limits: ${options.apiUrl}/api/v1/limits answered ${response.status} with an unexpected body.`,
    );
    return EXIT_UNHEALTHY;
  }

  if (options.json) {
    io.out(JSON.stringify(parsed.data, null, 2));
  } else {
    const limits = parsed.data;
    io.out(
      `max file size        ${formatBytes(limits.maxFileSizeBytes)} (verified: ${limits.maxFileSizeVerified})`,
    );
    io.out(`chunk size           ${formatBytes(limits.chunkSizeBytes)}`);
    io.out(
      `chunk size range     ${formatBytes(limits.minChunkSizeBytes)} – ${formatBytes(limits.maxChunkSizeBytes)}`,
    );
    io.out(`max parts per upload ${limits.maxPartsPerUpload}`);
    io.out(`anonymous per day    ${limits.anonymousUploadsPerDay}`);
    io.out(`registered per day   ${limits.registeredUploadsPerDay}`);
    io.out(`malware scanning     ${limits.malwareScanEnabled ? 'enabled' : 'disabled'}`);
    if (!limits.maxFileSizeVerified) {
      io.err(
        'limits: the 2 GiB target is NOT verified against a storage provider yet, so uploads remain unavailable.',
      );
    }
  }
  return EXIT_OK;
}
