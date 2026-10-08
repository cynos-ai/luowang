import { strict as assert } from 'node:assert';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it } from 'vitest';
import {
  normalizeGeneratedDefinition,
  materializeGeneratedDefinition,
  generatedDefinitionHash,
} from '../src/server/projects/generated-definition.js';
import { normalizeComposeDefinition } from '../src/server/projects/compose-contract.js';
import {
  decodeProjectFileContent,
  encodeUploadedContent,
} from '../src/server/projects/file-content.js';

it('materializes generated files without a product Dockerfile and changes cache identity for same target edits', async () => {
  const root = await mkdtemp(join(tmpdir(), 'luowang-generated-'));
  const definition = normalizeGeneratedDefinition({
    sourceCommit: 'a'.repeat(40),
    summary: 'fixture',
    files: [{ path: '.luowang-generated/app.Dockerfile', content: 'FROM node:24\n' }],
  })!;
  const changed = {
    ...definition,
    files: [{ ...definition.files[0], content: 'FROM node:24\nRUN echo changed\n' }],
  };
  try {
    await materializeGeneratedDefinition(root, definition);
    assert.equal(
      await readFile(join(root, definition.files[0].path), 'utf8'),
      definition.files[0].content,
    );
    assert.notEqual(generatedDefinitionHash(definition), generatedDefinitionHash(changed));
    const normalize = (hash: string, run: string) =>
      normalizeComposeDefinition({
        source: 'services:\n  app:\n    build: .\n',
        instanceId: 'i',
        projectId: 'p',
        attemptId: run,
        enabledServices: ['app'],
        applicationService: 'app',
        commandService: 'app',
        servicePort: 3000,
        generatedContentHash: hash,
      });
    assert.equal(
      normalize(generatedDefinitionHash(definition), 'run1').definitionHash,
      normalize(generatedDefinitionHash(definition), 'run2').definitionHash,
    );
    assert.notEqual(
      normalize(generatedDefinitionHash(definition), 'run1').definitionHash,
      normalize(generatedDefinitionHash(changed), 'run1').definitionHash,
    );
    await assert.rejects(materializeGeneratedDefinition(root, changed), { code: 'EEXIST' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('preserves binary database bytes and accepts SQL larger than the text configuration limit', () => {
  const binary = Buffer.from([0, 0xff, 0x89, 0x1f, 0, 0x7f]);
  assert.deepEqual(
    decodeProjectFileContent(encodeUploadedContent(binary.toString('base64'), 'data')).bytes,
    binary,
  );
  const sql = Buffer.from('INSERT INTO x VALUES (1);\n'.repeat(30_000));
  const encoded = encodeUploadedContent(sql.toString('base64'), 'data');
  assert.deepEqual(decodeProjectFileContent(encoded).bytes, sql);
  assert.throws(() => encodeUploadedContent(sql.toString('base64'), 'config'));
  assert.throws(() => encodeUploadedContent('$$$', 'data'));
  assert.deepEqual(decodeProjectFileContent('old plain text').bytes, Buffer.from('old plain text'));
});

it('rejects generated paths outside the reserved preparation directory', () => {
  for (const path of ['Dockerfile', '.luowang-generated/../../app.ts', '.git/config'])
    assert.throws(() =>
      normalizeGeneratedDefinition({
        sourceCommit: 'a'.repeat(40),
        summary: '',
        files: [{ path, content: 'x' }],
      }),
    );
});
