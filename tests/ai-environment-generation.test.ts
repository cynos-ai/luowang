import { strict as assert } from 'node:assert';
import Database from 'better-sqlite3';
import { it, vi } from 'vitest';
import { preparationFixture } from './environment-fixture.js';
import { runMigrations } from '../src/server/db/migrate.js';
import { createConfigurationStore } from '../src/server/configuration.js';
import { createScopedSecretStore } from '../src/server/security/scoped-secret-store.js';
import { createEnvironmentGenerationService } from '../src/server/projects/environment-generation.js';
import type { ProjectConfigurationStore } from '../src/server/projects/configuration.js';
import type { ConnectionResourceService } from '../src/server/projects/connection-resources.js';
import type { GitRepository } from '../src/server/repository/git-repository.js';

function prepareState(database: Database.Database) {
  database.exec(
    "CREATE TABLE projects(project_id TEXT PRIMARY KEY); INSERT INTO projects VALUES('p'); CREATE TABLE project_automation_state(project_id TEXT,key TEXT,value TEXT,updated_at TEXT,PRIMARY KEY(project_id,key));",
  );
}

it('generates an isolated draft from a fixed commit and never saves or starts a Run', async () => {
  const database = new Database(':memory:');
  runMigrations(database);
  prepareState(database);
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
        assert.equal(input.thinkingPolicy, 'highest');
        assert.equal(input.config.thinking, deployment.getHarness().agents.main.thinking);
        input.onThinkingResolved?.('high');
        assert.equal(deployment.getHarness().agents.main.thinking, 'high');
        assert.deepEqual(input.toolNames, [
          'read_project_file',
          'submit_environment_definition',
          'list_project_files',
          'report_missing_inputs',
        ]);
        assert.ok(input.userMessage.includes('seed.sql'));
        return {
          async prompt(message: string) {
            const actualPrompt = JSON.parse(message);
            assert.equal(actualPrompt.targetCommit, commit);
            assert.deepEqual(actualPrompt.paths, ['package.json', 'src/']);
            assert.equal(actualPrompt.files[0].path, 'seed.sql');
            assert.equal(message, input.userMessage);
            const listing = await input.customTools
              .find((tool) => tool.name === 'list_project_files')!
              .execute('list', { directory: 'src/' }, input.signal, undefined, {} as never);
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
                definition: {
                  summary: 'fixture',
                  preparation: preparationFixture,
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
                },
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
  prepareState(database);
  let models = 0;
  const generation = createEnvironmentGenerationService({
    database,
    deployment: { getHarness: () => ({ agents: { main: { model: 'fixture' } } }) } as never,
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

it('persists missing inputs and draft decisions, carries manual runtime and failure context, and rejects stale application', async () => {
  const { environmentFixture } = await import('./environment-fixture.js');
  const f = environmentFixture();
  let mode: 'missing' | 'draft' = 'missing';
  const calls: Array<Record<string, unknown>> = [];
  const options = {
    ...f,
    repoRoot: '/repo',
    executionContext: () => ({ kind: 'local', platform: 'linux/amd64' }),
    validationFailure: () => ({ stage: 'health', message: 'HTTP 503' }),
    loadSource: async () => ({
      commit: f.commit,
      repository: { directory: '/repo', listTree: async () => [] } as unknown as GitRepository,
    }),
    sessions: {
      async create(
        input: Parameters<import('../src/server/runs/types.js').AgentSessionFactory['create']>[0],
      ) {
        return {
          async prompt(message: string) {
            calls.push(JSON.parse(message));
            const tool = input.customTools!.find(
              (value) =>
                value.name ===
                (mode === 'missing' ? 'report_missing_inputs' : 'submit_environment_definition'),
            )!;
            await tool.execute(
              'submit',
              mode === 'missing'
                ? { items: [{ item: '.env.test', reason: '需要提供测试服务地址配置' }] }
                : {
                    definition: {
                      summary: 'application and tools',
                      preparation: preparationFixture,
                      files: [
                        {
                          path: '.luowang-generated/compose.yml',
                          content:
                            'services:\n  app:\n    image: node:24\n  tools:\n    image: node:24',
                        },
                      ],
                      runtime: f.configuration.get(f.project.projectId).runtime,
                    },
                  },
              input.signal,
              undefined,
              {} as never,
            );
          },
          dispose() {},
        };
      },
    },
  };
  let service = createEnvironmentGenerationService(options);
  try {
    service.start(f.project.projectId, {
      requirements: '保留手动健康检查',
      useValidationFailure: true,
    });
    await vi.waitFor(() =>
      assert.equal(service.current(f.project.projectId)?.status, 'needs_input'),
    );
    assert.deepEqual(calls[0].currentConfiguration, {
      runtimeMode: 'managed',
      startType: 'compose',
      executionDockerfile: '',
      runtime: f.configuration.get(f.project.projectId).runtime,
      environmentDescription: f.configuration.get(f.project.projectId).environmentDescription,
    });
    assert.equal(calls[0].requirements, '保留手动健康检查');
    assert.deepEqual(calls[0].validationFailure, { stage: 'health', message: 'HTTP 503' });
    await service.close();
    service = createEnvironmentGenerationService(options);
    assert.equal(service.current(f.project.projectId)?.missingInputs[0].item, '.env.test');
    mode = 'draft';
    const started = service.start(f.project.projectId);
    await vi.waitFor(() => assert.equal(service.current(f.project.projectId)?.status, 'completed'));
    assert.equal(calls[1].validationFailure, null);
    const draft = service.current(f.project.projectId)!.draft!;
    draft.runtime.healthPath = '/health';
    service.apply(f.project.projectId, started.id, draft);
    await service.close();
    service = createEnvironmentGenerationService(options);
    assert.equal(service.current(f.project.projectId)?.reviewState, 'applied');
    assert.equal(f.configuration.get(f.project.projectId).runtime.healthPath, '/health');
    const updated = service.start(f.project.projectId);
    await vi.waitFor(() => assert.equal(service.current(f.project.projectId)?.status, 'completed'));
    const old = service.current(f.project.projectId)!.draft!;
    f.configuration.update(f.project.projectId, { runtime: { ...old.runtime, servicePort: 9090 } });
    assert.equal(service.current(f.project.projectId)?.stale, true);
    assert.throws(() => service.apply(f.project.projectId, updated.id, old), /已变化/);
    service.discard(f.project.projectId, updated.id);
    await service.close();
    service = createEnvironmentGenerationService(options);
    assert.equal(service.current(f.project.projectId)?.reviewState, 'discarded');
    assert.equal(f.configuration.get(f.project.projectId).runtime.servicePort, 9090);
  } finally {
    await service.close();
    f.database.close();
  }
});
