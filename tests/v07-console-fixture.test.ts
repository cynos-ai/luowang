import { strict as assert } from 'node:assert';

import { it } from 'vitest';

import { createV07ConsoleFixture, V07_FIXTURE_MARKER } from './e2e/fixtures/v07-console-fixture.js';

it('builds a marked, internally scoped v0.7 console fixture', () => {
  const fixture = createV07ConsoleFixture();
  assert.equal(fixture.marker, V07_FIXTURE_MARKER);
  assert.equal(fixture.workspace.activeRun?.project.projectId, fixture.projects[0].projectId);
  assert.equal(fixture.workspace.queue[0].project.projectId, fixture.projects[1].projectId);
  assert.equal(fixture.workspace.projects.length, fixture.projects.length);
  assert.ok(fixture.workspace.projects.every((item) => item.readiness.status !== undefined));
  assert.ok(
    fixture.projectData[fixture.projects[0].projectId].evidence.every((item) =>
      item.objectKey.startsWith(`projects/${fixture.projects[0].projectId}/`),
    ),
  );
  assert.deepEqual(fixture.workspace.partialErrors, []);
  assert.ok(fixture.getResponses['/api/workspace']);
  assert.ok(fixture.getResponses['/api/system/status']);
  assert.ok(fixture.getResponses['/api/system/resources']);
});

it('builds empty and locally degraded states without inventing readiness', () => {
  const empty = createV07ConsoleFixture({ state: 'empty' });
  assert.equal(empty.workspace.activeRun, null);
  assert.deepEqual(empty.workspace.projects, []);
  assert.deepEqual(empty.workspace.attention, []);

  const partial = createV07ConsoleFixture({ state: 'partial-error' });
  assert.equal(partial.workspace.projects[1].readiness.status, 'not_checked');
  assert.equal(partial.workspace.projects[1].readiness.checkedAt, null);
  assert.equal(partial.workspace.partialErrors.length, 1);
  assert.equal(partial.workspace.projects[0].readError, null);
  assert.equal(partial.workspace.projects[1].readError?.code, 'PROJECT_READ_FAILED');
});

it('contains no credential-like production values in serialized fixture responses', () => {
  const serialized = JSON.stringify(createV07ConsoleFixture());
  assert.equal(serialized.includes('synthetic-password'), false);
  assert.equal(serialized.includes('providerApiKey'), false);
  assert.equal(serialized.includes('gitToken'), false);
  assert.equal(serialized.includes('Bearer '), false);
  assert.equal(serialized.includes('/home/'), false);
});
