import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import Database from 'better-sqlite3';
import { it, vi } from 'vitest';
import { createEnvironmentValidationService } from '../src/server/projects/environment-validation.js';
import { createDeploymentConfigurationStore } from '../src/server/projects/deployment-configuration.js';
import { GitRepository } from '../src/server/repository/git-repository.js';
import { ensureSystemMetadata, runMigrations } from '../src/server/db/migrate.js';
import { projectIdentityMigration } from '../src/server/db/migrations/0009-project-identity.js';
import { migrateLegacyRunOwnership } from '../src/server/db/migrations/0011-project-run-ownership.js';
import { migrateLegacyConfigurationOwnership } from '../src/server/db/migrations/0012-project-configuration-ownership.js';
import { migrateProjectQueueContext } from '../src/server/db/migrations/0014-project-queue-context.js';
import { migrateProjectImageState } from '../src/server/db/migrations/0015-project-image-state.js';
import { migrateExecutionRuntime } from '../src/server/db/migrations/0022-execution-runtime.js';
import { createProjectStore } from '../src/server/projects/store.js';
import {
  createProjectConfigurationStore,
  normalizeRuntimeDefinition,
} from '../src/server/projects/configuration.js';
import { createConnectionResourceService } from '../src/server/projects/connection-resources.js';
import { createScopedSecretStore } from '../src/server/security/scoped-secret-store.js';
import { createProjectRunRuntimeEnvironmentFactory } from '../src/server/projects/run-runtime-factory.js';
import type { ProjectTaskRuntime } from '../src/server/projects/task-runtime.js';
import {
  createAttachedProjectCommandSession,
  type DockerRuntime,
} from '../src/server/projects/execution-container.js';
import { createConfigurationStore } from '../src/server/configuration.js';

const exec = promisify(execFile);
const dockerIt = process.env.LUOWANG_DOCKER_SMOKE === '1' ? it : it.skip;

dockerIt(
  'runs a product without Dockerfile from generated Compose, imports real SQL, reuses images and resets Run data',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'luowang-ai-docker-'));
    const database = new Database(':memory:');
    database.pragma('foreign_keys=ON');
    runMigrations(database);
    ensureSystemMetadata(database, { appVersion: 'fixture' });
    runMigrations(database, [projectIdentityMigration]);
    migrateLegacyRunOwnership(database, null);
    migrateLegacyConfigurationOwnership(database, null);
    migrateProjectQueueContext(database);
    migrateProjectImageState(database);
    migrateExecutionRuntime(database);
    const project = createProjectStore(database).createVerified({
      displayName: 'fixture',
      repository: { githubRepositoryId: '101', owner: 'example', name: 'fixture' },
    });
    const secrets = createScopedSecretStore(database, 'synthetic-fixture-key');
    const resources = createConnectionResourceService({ database, secrets });
    const upload = resources.createProjectFile(project.projectId, {
      path: 'seed-upload.sql',
      purpose: 'data',
      encodedContent: Buffer.from(
        "CREATE TABLE items(id INT PRIMARY KEY,name TEXT); INSERT INTO items VALUES(42,'initial');\n",
      ).toString('base64'),
    });
    const stored = secrets.resource('project-file', upload.id).get('content');
    const repo = join(root, 'repo');
    await mkdir(repo);
    const git = (args: string[]) => exec('git', args, { cwd: repo });
    await git(['init', '-b', 'main']);
    await git(['config', 'user.name', 'Fixture']);
    await git(['config', 'user.email', 'fixture@example.test']);
    await writeFile(
      join(repo, 'app.js'),
      "const http=require('http'),fs=require('fs');http.createServer((_q,r)=>{try{r.end(fs.readFileSync('/proof/value','utf8').trim())}catch{r.statusCode=503;r.end('not initialized')}}).listen(8080,'0.0.0.0');\n",
    );
    await git(['add', '.']);
    await git(['commit', '-m', 'fixed product']);
    const commit = (await git(['rev-parse', 'HEAD'])).stdout.trim();
    const repository = new GitRepository({ directory: repo, remoteUrl: repo });
    const pgImage = (
      await exec('docker', [
        'image',
        'inspect',
        '--format',
        '{{index .RepoDigests 0}}',
        'postgres:16-alpine',
      ])
    ).stdout.trim();
    assert.match(pgImage, /@sha256:/);
    const generatedDefinition = {
      sourceCommit: commit,
      summary: 'fixture',
      files: [
        {
          path: '.luowang-generated/app.Dockerfile',
          content:
            'FROM docker.m.daocloud.io/library/node:24.14.1-bookworm-slim@sha256:b506e7321f176aae77317f99d67a24b272c1f09f1d10f1761f2773447d8da26c\nWORKDIR /app\nCOPY app.js ./\nCMD ["node","app.js"]\n',
        },
        {
          path: '.luowang-generated/compose.yml',
          content: `services:\n  app:\n    build:\n      context: ..\n      dockerfile: .luowang-generated/app.Dockerfile\n    volumes: ["proof:/proof:ro"]\n  db:\n    image: ${pgImage}\n    environment: {POSTGRES_HOST_AUTH_METHOD: trust}\n    volumes: ["data:/var/lib/postgresql/data"]\n  tools:\n    image: ${pgImage}\n    entrypoint: ["sleep","infinity"]\n    volumes: ["../:/workspace:ro", "proof:/proof"]\nvolumes:\n  data: {}\n  proof: {}\n`,
        },
      ],
    };
    const runtime = normalizeRuntimeDefinition({
      workingDirectory: '.',
      servicePort: 8080,
      healthPath: '/',
      healthTimeoutSeconds: 60,
      composeFile: '.luowang-generated/compose.yml',
      composeServices: ['app', 'db', 'tools'],
      applicationService: 'app',
      commandService: 'tools',
      initializationSteps: [
        {
          service: 'tools',
          timeoutSeconds: 60,
          command:
            'set -eu; until pg_isready -h db -U postgres; do sleep 1; done; psql -v ON_ERROR_STOP=1 -h db -U postgres -f /workspace/seed-upload.sql; psql -At -h db -U postgres -c \'SELECT name FROM items WHERE id=42\' > /proof/value; test "$(cat /proof/value)" = initial',
        },
      ],
    });
    const configuration = createProjectConfigurationStore(database);
    configuration.update(project.projectId, {
      runtimeMode: 'managed',
      startType: 'compose',
      runtime,
      generatedDefinition,
    });
    const instanceId = (
      database.prepare("SELECT value FROM system_metadata WHERE key='instance_id'").get() as {
        value: string;
      }
    ).value;
    let target: {
      docker: DockerRuntime;
      containerId: string;
      sourceRoot: string;
      workingDirectory: string;
    } | null = null;
    const task = {
      projectId: project.projectId,
      queueId: null,
      configRevision: 2,
      executionLocationId: `local:${instanceId}`,
      executionLocationRevision: 1,
      executionDockerfile: '',
      runtimeMode: 'managed',
      startType: 'compose',
      runtime,
      generatedDefinition,
      managedFiles: [
        { id: upload.id, revision: upload.revision, path: upload.path, serviceName: null },
      ],
      configuration: createConfigurationStore(database, { repoDir: repo, reportDir: root }),
    } as unknown as ProjectTaskRuntime;
    const factory = createProjectRunRuntimeEnvironmentFactory({
      database,
      task,
      secrets,
      storageRoot: root,
      setManagedCommandTarget: (_id, next) => {
        target = next;
      },
    });
    let owner: Awaited<ReturnType<typeof factory>> | undefined;
    try {
      const run1 = '01K00000000000000000000011';
      owner = await factory({ repository, runId: run1, targetCommit: commit });
      assert.equal(await fetch(owner.baseUrl!).then((r) => r.text()), 'initial');
      const first = (
        database
          .prepare('SELECT runtime_environment_json FROM run_execution_context WHERE run_id=?')
          .get(run1) as { runtime_environment_json: string }
      ).runtime_environment_json;
      assert.equal(
        JSON.parse(first).managedFiles[0].sha256,
        createHash('sha256')
          .update(
            "CREATE TABLE items(id INT PRIMARY KEY,name TEXT); INSERT INTO items VALUES(42,'initial');\n",
          )
          .digest('hex'),
      );
      assert.equal(JSON.parse(first).initializationResults[0].exitCode, 0);
      const attached = target! as {
        docker: DockerRuntime;
        containerId: string;
        sourceRoot: string;
        workingDirectory: string;
      };
      const session = await createAttachedProjectCommandSession(
        {
          projectId: project.projectId,
          runId: run1,
          targetCommit: commit,
          repositoryDirectory: repo,
          ...attached,
        },
        attached.docker,
      );
      const result = await session.run(
        'psql -h db -U postgres -c "UPDATE items SET name=\'mutated\'"',
        { runId: run1, targetCommit: commit, cwd: repo, timeoutMs: 30000 },
      );
      assert.equal(result.exitCode, 0);
      await session.close();
      await owner.close();
      owner = undefined;
      const run2 = '01K00000000000000000000012';
      owner = await factory({ repository, runId: run2, targetCommit: commit });
      assert.equal(await fetch(owner.baseUrl!).then((r) => r.text()), 'initial');
      const second = JSON.parse(
        (
          database
            .prepare('SELECT runtime_environment_json FROM run_execution_context WHERE run_id=?')
            .get(run2) as { runtime_environment_json: string }
        ).runtime_environment_json,
      );
      assert.equal(JSON.parse(first).serviceImages.app, second.serviceImages.app);
      assert.equal((await git(['status', '--porcelain'])).stdout, '');
      assert.equal(secrets.resource('project-file', upload.id).get('content'), stored);
      await owner.close();
      owner = undefined;
      const validation = createEnvironmentValidationService({
        database,
        projects: createProjectStore(database),
        configuration,
        deployment: createDeploymentConfigurationStore(database, {
          repoDir: repo,
          reportDir: root,
        }),
        resources,
        secrets,
        repoRoot: root,
        reportRoot: root,
        storageRoot: root,
        loadSource: async () => ({ repository, commit }),
      });
      try {
        validation.start(project.projectId);
        await vi.waitFor(
          () => {
            const result = validation.current(project.projectId)!;
            assert.notEqual(result.status, 'running');
            assert.equal(result.status, 'passed', JSON.stringify(result));
            assert.equal(result.cleanupConfirmed, true);
          },
          { timeout: 120000, interval: 500 },
        );
        assert.equal(
          (database.prepare('SELECT count(*) n FROM run_execution_context').get() as { n: number })
            .n,
          2,
        );
        assert.equal(
          (database.prepare('SELECT count(*) n FROM test_request_queue').get() as { n: number }).n,
          0,
        );
        configuration.update(project.projectId, {
          runtime: {
            ...runtime,
            initializationSteps: [{ service: 'tools', command: 'sleep 60', timeoutSeconds: 90 }],
          },
        });
        const cancelled = validation.start(project.projectId);
        await vi.waitFor(
          () =>
            assert.ok(
              validation
                .current(project.projectId)
                ?.steps.some((step) => step.stage === 'initialize' && step.status === 'running'),
            ),
          { timeout: 60000, interval: 100 },
        );
        validation.stop(project.projectId, cancelled.id);
        await vi.waitFor(
          () => {
            const result = validation.current(project.projectId)!;
            assert.equal(result.status, 'cancelled');
            assert.equal(result.cleanupConfirmed, true);
          },
          { timeout: 60000, interval: 500 },
        );
      } finally {
        await validation.close();
      }
    } finally {
      await owner?.close();
      const filter = `label=luowang.project-id=${project.projectId}`;
      for (const kind of ['container', 'network', 'volume']) {
        const listed = (
          await exec('docker', [kind, 'ls', '--quiet', '--filter', filter])
        ).stdout.trim();
        assert.equal(listed, '', `remaining ${kind}: ${listed}`);
      }
      database.close();
      await rm(root, { recursive: true, force: true });
    }
  },
  300000,
);
