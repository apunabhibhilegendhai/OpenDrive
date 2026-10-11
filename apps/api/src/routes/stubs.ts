import { notImplemented, problemDetailsResponseSchema } from '@opendrive/shared';

/**
 * Helpers for endpoints whose contract is published but whose implementation belongs
 * to a later phase.
 *
 * These endpoints must ANSWER (so clients and OpenAPI consumers see the real contract)
 * and must FAIL (so nothing looks like it works). They throw `501 NOT_IMPLEMENTED`
 * with a detail that names the feature and the phase. They never return fabricated
 * ids, fabricated success payloads or empty lists that could be mistaken for real data.
 */

/**
 * Phase that owns each published-but-unimplemented capability. Phase 1 implemented identity,
 * authorization and metadata; the upload engine and content transfer are Phase 2.
 */
export const STUB_PHASE = 'Phase 2' as const;

export function notImplementedHandler(
  feature: string,
  phase: string = STUB_PHASE,
): () => Promise<never> {
  return async () => {
    throw notImplemented(feature, phase);
  };
}

/** Response schemas attached to every stub so OpenAPI documents the failure shape. */
export const stubResponses = {
  501: problemDetailsResponseSchema,
} as const;
