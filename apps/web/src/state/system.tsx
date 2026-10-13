import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import type {
  HealthResponse,
  LimitsResponse,
  MeResponse,
  ReadinessResponse,
} from '@opendrive/shared';
import { useApi, useSession } from '../lib/auth/session.js';
import { describeFailure } from '../lib/api/errors.js';

/**
 * Deployment state: what this API can actually do right now.
 *
 * Readiness is the authority for capability flags. `storage: not_configured` disables uploads in
 * the interface instead of letting a person discover it through a 503, and an unverified file
 * ceiling is shown as unverified rather than as a promise.
 */
export interface SystemState {
  health: HealthResponse | null;
  readiness: ReadinessResponse | null;
  limits: LimitsResponse | null;
  me: MeResponse | null;
  loading: boolean;
  error: string | null;
  /** Uploads are offered only when the storage provider is attached. */
  canUpload: boolean;
  /** One sentence explaining why uploads are unavailable, when they are. */
  uploadBlocker: string | null;
  refresh: () => Promise<void>;
}

const SystemContext = createContext<SystemState | null>(null);

export function useSystem(): SystemState {
  const value = useContext(SystemContext);
  if (value === null) throw new Error('useSystem must be used inside <SystemProvider>');
  return value;
}

export function SystemProvider({ children }: { children: ReactNode }) {
  const api = useApi();
  const { state, epoch } = useSession();
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [readiness, setReadiness] = useState<ReadinessResponse | null>(null);
  const [limits, setLimits] = useState<LimitsResponse | null>(null);
  const [me, setMe] = useState<MeResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    const controller = new AbortController();
    try {
      const [healthResult, readinessResult, limitsResult] = await Promise.all([
        api.health(controller.signal).catch(() => null),
        api.readiness(controller.signal).catch(() => null),
        api.limits(controller.signal).catch(() => null),
      ]);
      setHealth(healthResult);
      setReadiness(readinessResult);
      setLimits(limitsResult);
      if (healthResult === null && readinessResult === null && limitsResult === null) {
        setError('The API did not answer. It may be stopped or unreachable.');
      }
    } catch (failure) {
      setError(describeFailure(failure));
    } finally {
      setLoading(false);
    }
  }, [api]);

  // Quota and identity belong to the current principal; they are re-read whenever it changes.
  useEffect(() => {
    void refresh();
  }, [refresh, epoch]);

  useEffect(() => {
    let cancelled = false;
    const hasPrincipal = state.kind === 'signed-in' || state.kind === 'anonymous';
    if (!hasPrincipal) {
      setMe(null);
      return;
    }
    void (async () => {
      try {
        const result = await api.me();
        if (!cancelled) setMe(result);
      } catch {
        if (!cancelled) setMe(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [api, state.kind, epoch]);

  const storage = readiness?.dependencies.find((dependency) => dependency.name === 'storage');
  const canUpload = storage?.status === 'ok';
  const uploadBlocker =
    canUpload || readiness === null
      ? null
      : `Uploads are unavailable: ${storage?.detail ?? 'the storage provider is not configured'}.`;

  const value = useMemo<SystemState>(
    () => ({
      health,
      readiness,
      limits,
      me,
      loading,
      error,
      canUpload,
      uploadBlocker,
      refresh,
    }),
    [health, readiness, limits, me, loading, error, canUpload, uploadBlocker, refresh],
  );

  return <SystemContext.Provider value={value}>{children}</SystemContext.Provider>;
}
