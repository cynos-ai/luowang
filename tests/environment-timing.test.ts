import { strict as assert } from 'node:assert';
import { it } from 'vitest';
import { createEnvironmentTimeline } from '../src/server/projects/environment-timing.js';
import type { EnvironmentValidationTask } from '../src/shared/environment-preparation.js';

it('records monotonic stage durations independently of wall clock changes and preserves failures', () => {
  const steps: EnvironmentValidationTask['steps'] = [];
  let tick = 100;
  let at = '2026-10-09T01:00:00Z';
  const timing = createEnvironmentTimeline(steps, () => ({ tick, at }));
  timing.enter('build');
  tick = 350;
  at = '2026-10-08T01:00:00Z';
  timing.enter('dependencies');
  assert.equal(steps[0].durationMs, 250);
  assert.equal(steps[0].status, 'passed');
  tick = 400;
  timing.finish('failed', 'synthetic dependency failure');
  timing.enter('cleanup');
  timing.enter('cleanup');
  tick = 420;
  timing.finish('passed');
  assert.equal(steps.length, 3);
  assert.equal(steps[1].status, 'failed');
  assert.equal(steps[1].durationMs, 50);
  assert.equal(steps[2].durationMs, 20);
});

it('does not count business testing or idle time as environment preparation/cleanup', () => {
  const steps: EnvironmentValidationTask['steps'] = [];
  let tick = 0;
  const timing = createEnvironmentTimeline(steps, () => ({
    tick,
    at: new Date(tick).toISOString(),
  }));
  timing.enter('health');
  tick = 200;
  timing.finish('passed');
  tick = 100000;
  timing.enter('cleanup');
  tick += 50;
  timing.finish('passed');
  assert.deepEqual(
    steps.map((step) => step.durationMs),
    [200, 50],
  );
});
