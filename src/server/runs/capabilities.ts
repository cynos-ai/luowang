import type { StorageCapability, TestDataManager } from './test-data.js';

export interface EnvironmentObservation {
  status: 'reachable' | 'unavailable' | 'unknown' | 'not_configured';
  checkedAt: string | null;
  reason:
    | 'http_response'
    | 'server_error'
    | 'request_failed'
    | 'invalid_url'
    | 'not_checked'
    | 'not_configured';
  statusCode?: number;
}

export interface RunCapabilities {
  observedAt: string;
  configuration: { projectId: string; revision: number } | null;
  environment: EnvironmentObservation;
  browser: { configured: boolean; verification: 'not_checked' | 'available' | 'unavailable' };
  controlledHttp: { available: boolean; savedSessionReplay: boolean };
  controlledCommand: { available: boolean; verification: 'on_execution' };
  accountStorage: StorageCapability;
  cleanup: { configured: boolean | null; verification: 'after_final_main' };
}

/** Shared with readiness. No credentials, response body or agent-selected URL is accepted. */
export async function checkEnvironmentAccess(
  baseUrl: string,
  request: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<EnvironmentObservation> {
  const observed = (
    status: EnvironmentObservation['status'],
    reason: EnvironmentObservation['reason'],
    statusCode?: number,
  ): EnvironmentObservation => ({
    status,
    reason,
    checkedAt: new Date().toISOString(),
    ...(statusCode === undefined ? {} : { statusCode }),
  });
  signal?.throwIfAborted();
  if (!baseUrl) return observed('not_configured', 'not_configured');
  let url: URL;
  try {
    url = new URL(baseUrl);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
      return observed('unavailable', 'invalid_url');
  } catch {
    return observed('unavailable', 'invalid_url');
  }
  try {
    const response = await request(url, {
      method: 'GET',
      redirect: 'manual',
      headers: { accept: '*/*' },
      signal: AbortSignal.any([AbortSignal.timeout(10_000), ...(signal ? [signal] : [])]),
    });
    await response.body?.cancel();
    signal?.throwIfAborted();
    return response.status < 500
      ? observed('reachable', 'http_response', response.status)
      : observed('unavailable', 'server_error', response.status);
  } catch {
    signal?.throwIfAborted();
    return observed('unavailable', 'request_failed');
  }
}

export async function collectRunCapabilities(input: {
  runId: string;
  baseUrl: string;
  browserConfigured: boolean;
  testData: TestDataManager;
  configuration?: RunCapabilities['configuration'];
  checkEnvironment?: (signal?: AbortSignal) => Promise<EnvironmentObservation>;
  signal?: AbortSignal;
  now: () => Date;
}): Promise<RunCapabilities> {
  input.signal?.throwIfAborted();
  const [environment, accountStorage] = await Promise.all([
    input.checkEnvironment?.(input.signal) ??
      Promise.resolve<EnvironmentObservation>({
        status: input.baseUrl ? 'unknown' : 'not_configured',
        checkedAt: null,
        reason: input.baseUrl ? 'not_checked' : 'not_configured',
      }),
    input.testData.checkStorageCapability?.(input.runId, input.signal) ??
      Promise.resolve<StorageCapability>({
        status: 'unknown',
        checkedAt: null,
        reason: 'not_checked',
      }),
  ]);
  input.signal?.throwIfAborted();
  return {
    observedAt: input.now().toISOString(),
    configuration: input.configuration ?? null,
    environment,
    browser: { configured: input.browserConfigured, verification: 'not_checked' },
    controlledHttp: {
      available: Boolean(input.baseUrl),
      savedSessionReplay: Boolean(input.baseUrl),
    },
    controlledCommand: { available: true, verification: 'on_execution' },
    accountStorage,
    cleanup: {
      configured: input.testData.cleanupAvailable ?? null,
      verification: 'after_final_main',
    },
  };
}
