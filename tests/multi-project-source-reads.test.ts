import { strict as assert } from 'node:assert';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import Database from 'better-sqlite3';
import { it } from 'vitest';

import { runMigrations } from '../src/server/db/migrate.js';
import { projectIdentityMigration } from '../src/server/db/migrations/0009-project-identity.js';
import { createProjectStore } from '../src/server/projects/store.js';
import { createSourceTextTool } from '../src/server/runs/change-evidence.js';
import { SourceReadStore, sourceHash } from '../src/server/runs/source-reads.js';
import { createProjectRunWorkspaceStore } from '../src/server/runs/workspace.js';
import { fixtures } from './acceptance/code-understanding/fixtures.mjs';

const runIds = ['01ARZ3NDEKTSV4RRFFQ69G5FAA', '01ARZ3NDEKTSV4RRFFQ69G5FAB'];
const path = 'src/orders.mjs';

async function invoke(tool: ToolDefinition, params: object) {
  const result = await tool.execute('synthetic-call', params);
  return JSON.parse(
    result.content
      .filter((part) => part.type === 'text')
      .map((part) => part.text)
      .join(''),
  );
}

it('keeps v0.6.0 deep-read receipts and plans inside their owning project Run', async () => {
  const root = await mkdtemp(join(tmpdir(), 'luowang-project-source-reads-'));
  const database = new Database(':memory:');
  try {
    runMigrations(database);
    runMigrations(database, [projectIdentityMigration]);
    const projects = createProjectStore(database);
    const projectIds = [
      projects.createVerified({
        displayName: 'A',
        repository: { githubRepositoryId: '101', owner: 'example', name: 'a' },
      }).projectId,
      projects.createVerified({
        displayName: 'B',
        repository: { githubRepositoryId: '102', owner: 'example', name: 'b' },
      }).projectId,
    ];
    const samples = ['refactor', 'bug-fix'].map((id) => fixtures.find((item) => item.id === id)!);
    const contexts = await Promise.all(
      projectIds.map(async (projectId, index) => {
        const workspace = await createProjectRunWorkspaceStore(database, root, projectId).create(
          runIds[index],
        );
        const source = samples[index].target[path];
        const reads = new SourceReadStore(
          runIds[index],
          sourceHash(`https://github.com/example/${index === 0 ? 'a' : 'b'}`),
          (content) => workspace.writeSourceReads(content),
        );
        const result = await invoke(
          createSourceTextTool(
            {
              baseCommit: 'a'.repeat(40),
              targetCommit: 'b'.repeat(40),
              sourceReads: reads.session('main-planning'),
              sanitize: (value) => value,
            },
            'read_target_file',
            async () => ({ status: 'ok', content: source }),
          ),
          { path },
        );
        assert.equal(result.content, source);
        return { projectId, workspace, reads, source, receipt: result.receipt };
      }),
    );
    const [a, b] = contexts;
    assert.notEqual(a.source, b.source);
    assert.notEqual(a.workspace.runningDirectory, b.workspace.runningDirectory);
    assert.notEqual(a.receipt.repositoryId, b.receipt.repositoryId);
    assert.equal(a.receipt.runId, runIds[0]);
    assert.equal(b.receipt.runId, runIds[1]);

    const aWriter = a.workspace.writer('main-a');
    const bWriter = b.workspace.writer('main-a');
    const aReference = { receiptId: a.receipt.id, coverage: 'full-file' as const };
    const bReference = { receiptId: b.receipt.id, coverage: 'full-file' as const };
    await a.reads.writePlan(
      'A maintenance judgment',
      false,
      [aReference],
      ['main-planning'],
      (text) => aWriter.writePlan(text),
    );
    await assert.rejects(
      b.reads.writePlan('foreign plan', false, [aReference], ['main-planning'], (text) =>
        bWriter.writePlan(text),
      ),
      /sourceReferences/,
    );
    assert.equal(await b.workspace.exists('plan.md'), false);
    await b.reads.writePlan('B defect judgment', false, [bReference], ['main-planning'], (text) =>
      bWriter.writePlan(text),
    );

    for (const [own, foreign] of [
      [a, b],
      [b, a],
    ] as const) {
      const metadata = JSON.parse(
        await readFile(join(own.workspace.runningDirectory, 'source-reads.json'), 'utf8'),
      );
      assert.equal(metadata.runId, own.reads.runId);
      assert.equal(metadata.repositoryId, own.reads.repositoryId);
      assert.deepEqual(
        metadata.receipts.map((receipt: { id: string }) => receipt.id),
        [own.receipt.id],
      );
      assert.ok(!JSON.stringify(metadata).includes(foreign.receipt.id));
      const plan = await own.workspace.read('plan.md');
      assert.deepEqual(JSON.parse(plan.split('\n')[1]).sourceReferences, [
        { receiptId: own.receipt.id, coverage: 'full-file' },
      ]);
      assert.ok(!plan.includes(foreign.receipt.id));
      const query = await invoke(
        own.reads.queryTool((value) => value),
        { scope: 'plan' },
      );
      assert.deepEqual(
        query.receipts.map((receipt: { id: string }) => receipt.id),
        [own.receipt.id],
      );
    }
  } finally {
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});
