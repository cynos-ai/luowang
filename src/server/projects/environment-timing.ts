import type {
  EnvironmentStage,
  EnvironmentValidationTask,
} from '../../shared/environment-preparation.js';

/** Monotonic elapsed time; wall timestamps identify events, not duration arithmetic. */
export function createEnvironmentTimeline(
  steps: EnvironmentValidationTask['steps'],
  clock = () => ({ at: new Date().toISOString(), tick: performance.now() }),
) {
  let active: { step: EnvironmentValidationTask['steps'][number]; tick: number } | undefined;
  function finish(status: 'passed' | 'failed', message?: string) {
    if (!active) return;
    const end = clock();
    active.step.status = status;
    active.step.finishedAt = end.at;
    active.step.durationMs = Math.max(0, Math.round(end.tick - active.tick));
    if (message) active.step.message = message;
    active = undefined;
  }
  return {
    finish,
    enter(stage: EnvironmentStage) {
      if (active?.step.stage === stage) return;
      finish('passed');
      const start = clock();
      const step: EnvironmentValidationTask['steps'][number] = {
        stage,
        status: 'running',
        startedAt: start.at,
        finishedAt: null,
        durationMs: null,
      };
      steps.push(step);
      active = { step, tick: start.tick };
    },
  };
}
