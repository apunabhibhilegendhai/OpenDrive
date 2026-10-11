/** Raised when the API cannot be reached, times out, or answers with a non-JSON body. */
export class CliNetworkError extends Error {}

export interface JsonResponse<T> {
  status: number;
  body: T;
}

/**
 * GETs `path` from `apiUrl` and parses the body as JSON.
 *
 * A non-2xx status is NOT an exception here: several commands need the body of a 503
 * (readiness) or a 501 (unimplemented capability) to report what happened. Transport
 * failures and unparseable bodies are exceptions, because the caller can do nothing with them.
 */
export async function fetchJson<T>(
  apiUrl: string,
  path: string,
  timeoutMs: number,
): Promise<JsonResponse<T>> {
  const url = `${apiUrl}${path}`;
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'GET',
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const reason =
      error instanceof Error && error.name === 'TimeoutError'
        ? `timed out after ${timeoutMs} ms`
        : error instanceof Error
          ? error.message
          : 'unknown transport error';
    throw new CliNetworkError(`could not reach ${url}: ${reason}`);
  }

  const text = await response.text();
  try {
    return { status: response.status, body: JSON.parse(text) as T };
  } catch (error) {
    if (error instanceof CliNetworkError) throw error;
    throw new CliNetworkError(
      `${url} answered ${response.status} with a body that is not JSON (${text.slice(0, 60)}…)`,
    );
  }
}
