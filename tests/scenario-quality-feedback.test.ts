import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'vitest';
import { Type } from 'typebox';
import { createReviewReadOrder } from '../src/server/runs/review-order.js';
import { createTextResult } from '../src/server/runs/agent-session.js';
import { parseScenarioMarkdown } from '../src/server/repository/markdown.js';
import { validateScenarioContents } from '../src/server/repository/scenario-patch.js';
import { classifyEvaluationSession } from './acceptance/scenario-evaluation-status.js';

describe('scenario quality feedback', () => {
  it('does not count recovered request errors as a failed role', () => {
    const status = classifyEvaluationSession({
      requestErrors: ['timeout'],
      lastModelStopReason: 'stop',
      aborted: false,
    });
    assert.equal(status.sessionStatus, 'completed');
    assert.equal(status.requestStatus, 'recovered');
    assert.equal(status.requestErrorCount, 1);
  });

  it('keeps terminal errors and budget interruption distinct from recovery', () => {
    const terminal = classifyEvaluationSession({
      requestErrors: ['timeout'],
      lastModelStopReason: 'error',
      aborted: false,
    });
    assert.equal(terminal.sessionStatus, 'failed');
    assert.equal(terminal.requestStatus, 'unrecovered');
    const budget = classifyEvaluationSession({
      requestErrors: [],
      lastModelStopReason: 'stop',
      stopReason: 'session_request_limit',
      aborted: false,
    });
    assert.equal(budget.sessionStatus, 'failed');
    assert.equal(budget.reason, 'session_request_limit');
  });

  it('does not hide invalid role output behind request recovery', () => {
    const status = classifyEvaluationSession({
      requestErrors: ['timeout'],
      lastModelStopReason: 'stop',
      orchestratorError: 'invalid plan',
      aborted: false,
    });
    assert.equal(status.sessionStatus, 'failed');
    assert.equal(status.requestStatus, 'recovered');
    assert.equal(status.reason, 'invalid plan');
  });

  it('provides a complete parser-valid template even when the target has no scenarios', async () => {
    const role = await readFile('resources/agent-roles/main-planning.md', 'utf8');
    const template = role.match(/```markdown\n([\s\S]*?)```/)?.[1];
    assert.ok(template);
    const scene = parseScenarioMarkdown(
      template,
      'docs/scenario-testing/scenarios/AUTH-LOGIN-001.md',
    );
    assert.equal(scene.status, 'approved');
    assert.deepEqual(Object.keys(scene), ['id', 'name', 'description', 'status', 'tags']);
  });

  it('reports the full schema instead of forcing one-field-at-a-time guesses', () => {
    assert.throws(
      () =>
        validateScenarioContents(
          new Map([
            [
              'docs/scenario-testing/scenarios/TEST-001.md',
              '---\nid: TEST-001\nstatus: draft\n---\n',
            ],
          ]),
        ),
      /name.*frontmatter.*id、name、description、status、tags.*不要把 name 当作文件名/,
    );
  });

  it('denies premature body access and requires every original image before draft or review', async () => {
    const exposed: string[] = [];
    let imageCalls = 0;
    const order = createReviewReadOrder(
      async (name) => {
        exposed.push(name);
        return name;
      },
      ['a.png', 'b.png'],
      () => assert.fail('unexpected image failure'),
    );
    const image = order.wrap({
      name: 'read_evidence_image',
      label: 'image',
      description: 'image',
      parameters: Type.Object({ filename: Type.String() }),
      async execute() {
        imageCalls += 1;
        return { content: [{ type: 'image', data: 'AA==', mimeType: 'image/png' }], details: {} };
      },
    });
    const view = (filename: string) =>
      image.execute('id', { filename }, undefined, undefined, {} as never);
    await assert.rejects(order.readArtifact('execution.md'), /先读取 plan/);
    await view('a.png');
    assert.equal(imageCalls, 0);
    assert.deepEqual(exposed, []);
    await order.readArtifact('plan.md');
    await view('a.png');
    await view('unknown.png');
    await assert.rejects(order.readArtifact('execution.md'), /原始图片/);
    assert.throws(order.assertReady, /原始图片/);
    await view('b.png');
    await order.readArtifact('execution.md');
    order.assertReady();
    assert.deepEqual(exposed, ['plan.md', 'execution.md']);
  });

  it('keeps failed evidence blocking while allowing an honest review of the failure', async () => {
    let failures = 0;
    const order = createReviewReadOrder(
      async (name) => name,
      ['bad.png'],
      () => {
        failures += 1;
      },
    );
    const image = order.wrap({
      name: 'read_evidence_image',
      label: 'image',
      description: 'image',
      parameters: Type.Object({ filename: Type.String() }),
      async execute() {
        return createTextResult('unavailable', { error: true });
      },
    });
    await order.readArtifact('plan.md');
    await image.execute('id', { filename: 'bad.png' }, undefined, undefined, {} as never);
    order.assertReady();
    await order.readArtifact('execution.md');
    assert.equal(failures, 1);
  });

  it('allows a zero-image review only after the plan, without requiring nonexistent evidence', async () => {
    const order = createReviewReadOrder(
      async (name) => name,
      [],
      () => assert.fail(),
    );
    assert.throws(order.assertReady, /plan/);
    await order.readArtifact('plan.md');
    await order.readArtifact('execution.md');
    order.assertReady();
    const withPatch = createReviewReadOrder(
      async (name) => name,
      [],
      () => assert.fail(),
      true,
    );
    await withPatch.readArtifact('plan.md');
    await assert.rejects(withPatch.readArtifact('execution.md'), /scenario-changes.patch/);
    assert.throws(withPatch.assertReady, /scenario-changes.patch/);
    await withPatch.readArtifact('scenario-changes.patch');
    withPatch.assertReady();
  });
});
