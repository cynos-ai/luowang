import { strict as assert } from 'node:assert';
import Database from 'better-sqlite3';
import { it, vi } from 'vitest';
import { runMigrations } from '../src/server/db/migrate.js';
import { createConfigurationStore } from '../src/server/configuration.js';
import { createScopedSecretStore } from '../src/server/security/scoped-secret-store.js';
import { createEnvironmentGenerationService } from '../src/server/projects/environment-generation.js';
import type { ProjectConfigurationStore } from '../src/server/projects/configuration.js';
import type { ConnectionResourceService } from '../src/server/projects/connection-resources.js';
import type { GitRepository } from '../src/server/repository/git-repository.js';

it('generates an isolated draft from a fixed commit and never saves or starts a Run', async () => {
  const database = new Database(':memory:');
  runMigrations(database);
  database.exec('ALTER TABLE test_request_queue ADD COLUMN project_id TEXT');
  const deployment = createConfigurationStore(database, {
    repoDir: '/repos',
    reportDir: '/reports',
  });
  deployment.updateHarness({
    agents: {
      ...deployment.getHarness().agents,
      main: { ...deployment.getHarness().agents.main, thinking: 'high' },
    },
  });
  let saved = 0;
  const configuration = {
    get: () => ({ runtimeMode: 'managed', generatedDefinition: null }),
    update: () => {
      saved++;
    },
  } as unknown as ProjectConfigurationStore;
  const resources = {
    listProjectFiles: () => [{ id: 'f', path: 'seed.sql', purpose: 'data', revision: 1 }],
  } as unknown as ConnectionResourceService;
  const commit = 'a'.repeat(40);
  const repository = {
    directory: '/repos/fixed',
    listTree: async (sha: string) => {
      assert.equal(sha, commit);
      return [
        { path: 'package.json', type: 'blob', mode: '100644' },
        { path: 'src/main.js', type: 'blob', mode: '100644' },
      ];
    },
    readTextFileAtCommit: async (sha: string, path: string) => {
      assert.equal(sha, commit);
      assert.equal(path, 'package.json');
      return { content: '{"scripts":{"start":"node app.js"}}' };
    },
  } as unknown as GitRepository;
  let disposed = 0;
  const generation = createEnvironmentGenerationService({
    database,
    deployment,
    configuration,
    resources,
    secrets: createScopedSecretStore(database, 'test-key'),
    repoRoot: '/repos',
    loadSource: async () => ({ repository, commit }),
    sessions: {
      async create(input) {
        assert.equal(input.role, 'main-a');
        assert.equal(input.config.thinking, 'low');
        assert.equal(deployment.getHarness().agents.main.thinking, 'high');
        assert.deepEqual(input.toolNames, [
          'read_project_file',
          'submit_environment_definition',
          'list_project_files',
        ]);
        assert.ok(input.userMessage.includes('seed.sql'));
        return {
          async prompt(message: string) {
            const actualPrompt = JSON.parse(message);
            assert.equal(actualPrompt.targetCommit, commit);
            assert.deepEqual(actualPrompt.paths, ['package.json', 'src/']);
            assert.equal(actualPrompt.files[0].path, 'seed.sql');
            assert.equal(message, input.userMessage);
            const listing = await input.customTools[2].execute(
              'list',
              { directory: 'src/' },
              input.signal,
              undefined,
              {} as never,
            );
            assert.deepEqual(JSON.parse((listing.content[0] as { text: string }).text).entries, [
              'src/main.js',
            ]);
            const read = input.customTools[0];
            await read.execute(
              'read',
              { path: 'package.json' },
              input.signal,
              undefined,
              {} as never,
            );
            await assert.rejects(() =>
              read.execute('read', { path: '.git/config' }, input.signal, undefined, {} as never),
            );
            await input.customTools[1].execute(
              'submit',
              {
                definition: JSON.stringify({
                  summary: 'fixture',
                  files: [
                    {
                      path: '.luowang-generated/compose.yml',
                      content:
                        'services:\n  app:\n    image: node:24\n  tools:\n    image: node:24',
                    },
                  ],
                  runtime: {
                    servicePort: 3000,
                    composeFile: '.luowang-generated/compose.yml',
                    composeServices: ['app', 'tools'],
                    applicationService: 'app',
                    commandService: 'tools',
                  },
                }),
              },
              input.signal,
              undefined,
              {} as never,
            );
          },
          dispose() {
            disposed++;
          },
        };
      },
    },
  });
  try {
    const task = generation.start('p');
    assert.throws(() => generation.start('p'), /正在生成/);
    await vi.waitFor(() => assert.equal(generation.get('p', task.id).status, 'completed'));
    const completed = generation.get('p', task.id);
    assert.equal(completed.filesRead, 1);
    assert.equal(completed.draft?.generatedDefinition.sourceCommit, commit);
    assert.equal(saved, 0);
    assert.equal(
      (database.prepare('SELECT count(*) AS n FROM test_request_queue').get() as { n: number }).n,
      0,
    );
    assert.equal(disposed, 1);
    assert.throws(() => generation.get('another-project', task.id));
    completed.draft!.generatedDefinition.summary = 'tampered';
    assert.equal(generation.get('p', task.id).draft!.generatedDefinition.summary, 'fixture');
  } finally {
    await generation.close();
    database.close();
  }
});

it('cancels source preparation and does not start a model session afterwards', async () => {
  const database = new Database(':memory:');
  database.exec('CREATE TABLE test_request_queue(project_id TEXT,status TEXT)');
  let models = 0;
  const generation = createEnvironmentGenerationService({
    database,
    deployment: {} as never,
    configuration: { get: () => ({}) } as never,
    resources: { listProjectFiles: () => [] } as never,
    secrets: {} as never,
    repoRoot: '/repos',
    loadSource: async (_id, signal) =>
      new Promise((_, reject) =>
        signal.addEventListener('abort', () => reject(signal.reason), { once: true }),
      ),
    sessions: {
      async create() {
        models++;
        throw new Error('must not start');
      },
    },
  });
  try {
    const task = generation.start('p');
    generation.stop('p', task.id);
    await vi.waitFor(() => assert.equal(generation.get('p', task.id).status, 'cancelled'));
    assert.equal(models, 0);
  } finally {
    await generation.close();
    database.close();
  }
});
