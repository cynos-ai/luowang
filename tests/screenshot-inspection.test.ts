import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it } from 'vitest';
import { RunWorkspace } from '../src/server/runs/workspace.js';
import {
  createRunEvidenceStore,
  createReviewerEvidenceTools,
  createRunnerEvidenceTools,
} from '../src/server/runs/evidence.js';
import {
  appendScreenshotLabels,
  readScreenshotReceipt,
} from '../src/server/runs/screenshot-inspection.js';
import { localEvidenceTransport, TEST_PNG } from './acceptance/local-evidence.js';

it.each(['detected', 'not_detected', 'unknown'] as const)(
  'binds %s labels to image bytes, readers and report without changing upload',
  async (status) => {
    const directory = await mkdtemp(join(tmpdir(), 'luowang-capture-label-'));
    try {
      const workspace = new RunWorkspace('01K00000000000000000000000', directory);
      await workspace.create();
      const transport = localEvidenceTransport();
      const store = createRunEvidenceStore(workspace, transport.oss);
      const sha256 = createHash('sha256').update(TEST_PNG).digest('hex');
      await writeFile(join(workspace.evidenceDirectory, 'image.png'), TEST_PNG);
      const receipt = readScreenshotReceipt(
        'LUOWANG_SCREENSHOT_CAPTURE ' +
          JSON.stringify({ filename: './image.png', status, scope: 'page', sha256 }),
      );
      await store.captureScreenshot!(receipt.filename, receipt.inspection);
      const ref = await store.upload('image.png');
      assert.deepEqual(ref.screenshotInspection, receipt.inspection);
      assert.deepEqual(transport.objects.get(ref.objectKey), TEST_PNG);
      assert.deepEqual(
        (await store.readUploaded!('image.png')).screenshotInspection,
        receipt.inspection,
      );
      for (const tools of [createReviewerEvidenceTools(store), createRunnerEvidenceTools(store)]) {
        const list = await tools
          .find((t) => t.name === 'list_evidence_files')!
          .execute('list', {}, undefined, undefined, {} as never);
        assert.match(JSON.stringify(list), new RegExp(status));
      }
      const image = await createReviewerEvidenceTools(store)
        .find((t) => t.name === 'read_evidence_image')!
        .execute('read', { filename: 'image.png' }, undefined, undefined, {} as never);
      assert.match(JSON.stringify(image), new RegExp(status));
      const report = appendScreenshotLabels('# Result\nOriginal finding', [ref]);
      assert.match(report, /Original finding/);
      assert.ok(report.includes(ref.url));
      assert.equal(appendScreenshotLabels(report, [ref]), report);
      transport.objects.set(ref.objectKey, Buffer.concat([TEST_PNG, Buffer.from('tamper')]));
      await assert.rejects(() => store.readUploaded!('image.png'), /内容已改变/);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

it('rejects missing/forged receipts and changed images before upload', async () => {
  assert.throws(() => readScreenshotReceipt('old screenshot result'));
  assert.throws(() => readScreenshotReceipt('LUOWANG_SCREENSHOT_CAPTURE {"status":"safe"}'));
  const directory = await mkdtemp(join(tmpdir(), 'luowang-capture-tamper-'));
  try {
    const workspace = new RunWorkspace('01K00000000000000000000000', directory);
    await workspace.create();
    const transport = localEvidenceTransport();
    const store = createRunEvidenceStore(workspace, transport.oss);
    await writeFile(join(workspace.evidenceDirectory, 'image.png'), TEST_PNG);
    await store.captureScreenshot!('image.png', {
      status: 'detected',
      scope: 'page',
      sha256: createHash('sha256').update(TEST_PNG).digest('hex'),
    });
    await writeFile(
      join(workspace.evidenceDirectory, 'image.png'),
      Buffer.concat([TEST_PNG, Buffer.from('changed')]),
    );
    await assert.rejects(() => store.upload('image.png'), /内容已改变/);
    assert.equal(transport.objects.size, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
