/** Request recovery is not the same fact as role completion or artifact quality. */
export function classifyEvaluationSession(input: {
  requestErrors: readonly string[];
  lastModelStopReason?: string;
  orchestratorError?: string;
  stopReason?: string;
  aborted: boolean;
}) {
  const terminalModelError = ['error', 'aborted'].includes(input.lastModelStopReason ?? '');
  const failed = Boolean(
    input.orchestratorError || input.stopReason || input.aborted || terminalModelError,
  );
  return {
    sessionStatus: failed ? ('failed' as const) : ('completed' as const),
    requestStatus:
      input.requestErrors.length === 0
        ? ('clean' as const)
        : !terminalModelError && !input.aborted && !input.stopReason
          ? ('recovered' as const)
          : ('unrecovered' as const),
    requestErrorCount: input.requestErrors.length,
    reason:
      input.orchestratorError ??
      input.stopReason ??
      (input.aborted
        ? 'session_timeout'
        : terminalModelError
          ? `model_${input.lastModelStopReason}`
          : undefined),
    // Callers must validate artifacts and obtain independent quality scores separately.
  };
}
