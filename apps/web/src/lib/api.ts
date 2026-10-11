import {
  healthResponseSchema,
  limitsResponseSchema,
  readinessResponseSchema,
} from '@opendrive/shared';
import type { HealthResponse, LimitsResponse, ReadinessResponse } from '@opendrive/shared';

/**
 * API client.
 *
 * Responses are parsed through the shared schemas rather than trusted: if the server and
 * the client drift, this surfaces as an explicit "unexpected response" state instead of
 * rendering `undefined` into the page.
 *
 * Base URL resolution: `VITE_API_BASE_URL` when set (deployed setups), otherwise same-origin
 * relative paths, which the Vite dev server proxies to the API.
 */

/** Build-time override; an empty value means "use same-origin relative paths". */
const configuredBaseUrl: unknown = import.meta.env.VITE_API_BASE_URL;
export const API_BASE_URL: string =
  typeof configuredBaseUrl === 'string' ? configuredBaseUrl.replace(/\/+$/, '') : '';

export type ProbeResult<T> =
  | { state: 'ok'; data: T }
  | { state: 'unexpected'; status: number; detail: string }
  | { state: 'unreachable'; detail: string };

export interface BuildStatus {
  health: ProbeResult<HealthResponse>;
  readiness: ProbeResult<ReadinessResponse>;
  limits: ProbeResult<LimitsResponse>;
  checkedAt: string;
}

async function probe<T>(
  path: string,
  schema: {
    safeParse: (
      value: unknown,
    ) => { success: true; data: T } | { success: false; error: { issues: { message: string }[] } };
  },
  init?: RequestInit,
): Promise<ProbeResult<T>> {
  let response: Response;
  try {
    response = await fetch(`${API_BASE_URL}${path}`, {
      headers: { accept: 'application/json' },
      ...init,
    });
  } catch (error) {
    return {
      state: 'unreachable',
      detail: error instanceof Error ? error.message : 'network error',
    };
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return {
      state: 'unexpected',
      status: response.status,
      detail: 'Response body is not JSON.',
    };
  }

  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    return {
      state: 'unexpected',
      status: response.status,
      detail: parsed.error.issues[0]?.message ?? 'Response does not match the published contract.',
    };
  }

  // Readiness and metadata endpoints answer non-2xx on purpose (503 while degraded).
  // A parsed body is still the authoritative answer, so it is reported as data.
  return { state: 'ok', data: parsed.data };
}

export async function fetchBuildStatus(signal?: AbortSignal): Promise<BuildStatus> {
  const init = signal === undefined ? undefined : { signal };
  const [health, readiness, limits] = await Promise.all([
    probe('/healthz', healthResponseSchema, init),
    probe('/readyz', readinessResponseSchema, init),
    probe('/api/v1/limits', limitsResponseSchema, init),
  ]);
  return { health, readiness, limits, checkedAt: new Date().toISOString() };
}
