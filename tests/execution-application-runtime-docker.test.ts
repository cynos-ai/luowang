import { strict as assert } from 'node:assert';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { it } from 'vitest';

import {
  localDockerHostAddress,
  startComposeApplication,
  startSingleContainerApplication,
} from '../src/server/projects/application-runtime.js';
import { normalizeComposeDefinition } from '../src/server/projects/compose-contract.js';
import {
  createAttachedProjectCommandSession,
  createDockerRuntime,
} from '../src/server/projects/execution-container.js';
import { injectManagedFiles } from '../src/server/projects/managed-file-runtime.js';

const dockerIt = process.env.LUOWANG_DOCKER_SMOKE === '1' ? it : it.skip;

dockerIt(
  'builds Compose from the fixed product tree and executes tests in the selected service',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'luowang-compose-runtime-'));
    const buildSource = join(root, 'fixed');
    const commandSource = join(root, 'run');
    const projectId = '12345678-1234-4123-8123-123456789abc';
    const runId = '01K00000000000000000000003';
    const targetCommit = 'a'.repeat(40);
    const baseDocker = createDockerRuntime();
    let composeBuilds = 0;
    const docker = {
      async run(args: string[], options: { timeoutMs: number; signal?: AbortSignal }) {
        if (args[0] === 'compose' && args.includes('build')) composeBuilds += 1;
        const result = await baseDocker.run(args, options);
        if (result.exitCode !== 0)
          process.stderr.write(`docker ${args[0]} fixture failure: ${result.stderr}\n`);
        return result;
      },
    };
    let owner: Awaited<ReturnType<typeof startComposeApplication>> | undefined;
    try {
      await mkdir(join(commandSource, 'docs/scenario-testing/scenarios'), { recursive: true });
      await mkdir(buildSource, { recursive: true });
      await writeFile(join(buildSource, 'marker.txt'), 'fixed-product');
      await writeFile(join(commandSource, 'marker.txt'), 'patched-run');
      await writeFile(
        join(commandSource, 'read-fixture.js'),
        "process.stdout.write(require('node:fs').readFileSync('config/fixture.env', 'utf8'));\n",
      );
      await writeFile(
        join(commandSource, 'docs/scenario-testing/scenarios/CHECK.md'),
        '# patched scenario\n',
      );
      await writeFile(
        join(buildSource, 'app.js'),
        [
          "const http = require('node:http');",
          "const marker = require('node:fs').readFileSync('marker.txt', 'utf8');",
          'http.createServer(async (_req, res) => {',
          "  const dependency = await fetch('http://database:7777').then((value) => value.text());",
          "  const managed = require('node:fs').readFileSync('/runtime-source/config/app.env', 'utf8').trim();",
          '  res.end(`${marker}|${dependency}|${managed}`);',
          "}).listen(8080, '0.0.0.0');",
        ].join('\n'),
      );
      await writeFile(
        join(buildSource, 'database.js'),
        [
          "const fs = require('node:fs');",
          "fs.writeFileSync('/data/ready', 'db-ok');",
          "require('node:http').createServer((_req, res) => res.end(fs.readFileSync('/data/ready', 'utf8'))).listen(7777, '0.0.0.0');",
        ].join('\n'),
      );
      const base =
        'FROM docker.m.daocloud.io/library/node:24.14.1-bookworm-slim@sha256:b506e7321f176aae77317f99d67a24b272c1f09f1d10f1761f2773447d8da26c\n';
      await writeFile(
        join(buildSource, 'Dockerfile.app'),
        `${base}WORKDIR /app\nCOPY app.js marker.txt ./\nCMD ["node", "app.js"]\n`,
      );
      await writeFile(
        join(buildSource, 'Dockerfile.database'),
        `${base}WORKDIR /app\nCOPY database.js ./\nCMD ["node", "database.js"]\n`,
      );
      await writeFile(
        join(buildSource, 'Dockerfile.runner'),
        `${base}WORKDIR /app\nCMD ["sleep", "infinity"]\n`,
      );

      const publishHost = localDockerHostAddress();
      const definition = normalizeComposeDefinition({
        source: [
          'services:',
          '  app:',
          '    build:',
          '      context: .',
          '      dockerfile: Dockerfile.app',
          '    depends_on: [database]',
          '    ports: ["8080"]',
          '    volumes: [".:/runtime-source:ro"]',
          '  database:',
          '    build:',
          '      context: .',
          '      dockerfile: Dockerfile.database',
          '    volumes: ["database-data:/data"]',
          '  runner:',
          '    build:',
          '      context: .',
          '      dockerfile: Dockerfile.runner',
          '    depends_on: [app]',
          '    volumes: [".:/workspace:ro"]',
          'volumes:',
          '  database-data: {}',
        ].join('\n'),
        instanceId: projectId,
        projectId,
        attemptId: runId,
        enabledServices: ['app', 'database', 'runner'],
        applicationService: 'app',
        commandService: 'runner',
        servicePort: 8080,
        publishHost,
      });
      owner = await startComposeApplication({
        docker,
        definition,
        buildSourceDirectory: buildSource,
        commandSourceDirectory: commandSource,
        targetCommit,
        runtime: {
          workingDirectory: '.',
          prepareCommand: [],
          startCommand: [],
          servicePort: 8080,
          healthPath: '/',
          healthTimeoutSeconds: 60,
          composeFile: 'compose.yml',
          composeServices: ['app', 'database', 'runner'],
          applicationService: 'app',
          commandService: 'runner',
        },
        publishHost,
        prepareSourceVolume: (serviceName, containerId, destinationRoot) =>
          injectManagedFiles({
            docker,
            containerId,
            serviceName,
            destinationRoot,
            files: [
              {
                id: 'app-fixture',
                revision: 1,
                path: 'config/app.env',
                serviceName: 'app',
                content: 'APP_MANAGED=ready\n',
              },
              {
                id: 'fixture',
                revision: 1,
                path: 'config/fixture.env',
                serviceName: 'runner',
                content: 'FIXTURE_VALUE=managed\n',
              },
            ],
          }),
        afterStart: (serviceName, containerId) =>
          injectManagedFiles({
            docker,
            containerId,
            serviceName,
            files: [
              {
                id: 'fixture',
                revision: 1,
                path: 'config/fixture.env',
                serviceName: 'runner',
                content: 'FIXTURE_VALUE=managed\n',
              },
            ],
          }),
      });

      assert.equal(
        await fetch(`${owner.environment.baseUrl}/`).then((value) => value.text()),
        'fixed-product|db-ok|APP_MANAGED=ready',
      );
      const session = await createAttachedProjectCommandSession(
        {
          projectId,
          runId,
          targetCommit,
          repositoryDirectory: commandSource,
          containerId: owner.containerId,
          sourceRoot: owner.commandSourceRoot,
          workingDirectory: owner.commandSourceRoot,
        },
        docker,
      );
      const result = await session.run('node read-fixture.js', {
        cwd: commandSource,
        runId,
        targetCommit,
      });
      assert.equal(result.exitCode, 0);
      assert.equal(result.stdout, 'FIXTURE_VALUE=managed\n');
      await session.close();
      assert.equal(
        await fetch(`${owner.environment.baseUrl}/`).then((value) => value.text()),
        'fixed-product|db-ok|APP_MANAGED=ready',
      );
      assert.equal(composeBuilds, 1);
      const cachedImageIds = owner.imageIds;
      await owner.close();
      owner = undefined;
      const secondDefinition = normalizeComposeDefinition({
        source: [
          'services:',
          '  app:',
          '    build:',
          '      context: .',
          '      dockerfile: Dockerfile.app',
          '    depends_on: [database]',
          '    ports: ["8080"]',
          '    volumes: [".:/runtime-source:ro"]',
          '  database:',
          '    build:',
          '      context: .',
          '      dockerfile: Dockerfile.database',
          '    volumes: ["database-data:/data"]',
          '  runner:',
          '    build:',
          '      context: .',
          '      dockerfile: Dockerfile.runner',
          '    depends_on: [app]',
          '    volumes: [".:/workspace:ro"]',
          'volumes:',
          '  database-data: {}',
        ].join('\n'),
        instanceId: projectId,
        projectId,
        attemptId: '01K00000000000000000000005',
        enabledServices: ['app', 'database', 'runner'],
        applicationService: 'app',
        commandService: 'runner',
        servicePort: 8080,
        publishHost,
      });
      assert.equal(secondDefinition.definitionHash, definition.definitionHash);
      assert.notEqual(secondDefinition.projectName, definition.projectName);
      owner = await startComposeApplication({
        docker,
        definition: secondDefinition,
        buildSourceDirectory: buildSource,
        commandSourceDirectory: commandSource,
        targetCommit,
        cachedImageIds,
        runtime: {
          workingDirectory: '.',
          prepareCommand: [],
          startCommand: [],
          servicePort: 8080,
          healthPath: '/',
          healthTimeoutSeconds: 60,
          composeFile: 'compose.yml',
          composeServices: ['app', 'database', 'runner'],
          applicationService: 'app',
          commandService: 'runner',
        },
        publishHost,
        prepareSourceVolume: (serviceName, containerId, destinationRoot) =>
          injectManagedFiles({
            docker,
            containerId,
            serviceName,
            destinationRoot,
            files: [
              {
                id: 'app-fixture',
                revision: 1,
                path: 'config/app.env',
                serviceName: 'app',
                content: 'APP_MANAGED=ready\n',
              },
              {
                id: 'fixture',
                revision: 1,
                path: 'config/fixture.env',
                serviceName: 'runner',
                content: 'FIXTURE_VALUE=managed\n',
              },
            ],
          }),
      });
      assert.equal(composeBuilds, 1);
      assert.equal(
        await fetch(`${owner.environment.baseUrl}/`).then((value) => value.text()),
        'fixed-product|db-ok|APP_MANAGED=ready',
      );
    } finally {
      await owner?.close();
      await rm(root, { recursive: true, force: true });
    }
  },
  10 * 60_000,
);

dockerIt(
  'runs a single-container application from both native and containerized control planes',
  async () => {
    const source = await mkdtemp(join(tmpdir(), 'luowang-single-runtime-'));
    const baseDocker = createDockerRuntime();
    const runId = '01K00000000000000000000004';
    let owner: Awaited<ReturnType<typeof startSingleContainerApplication>> | undefined;
    try {
      await writeFile(
        join(source, 'app.js'),
        [
          "const http = require('node:http');",
          "const managed = require('node:fs').readFileSync('config/runtime.env', 'utf8').trim();",
          "http.createServer((_request, response) => response.end(managed)).listen(8090, '0.0.0.0');",
        ].join('\n'),
      );
      const imageId = (
        await baseDocker.run(
          ['image', 'inspect', '--format', '{{.Id}}', 'luowang-quality:execution-server'],
          { timeoutMs: 10_000 },
        )
      ).stdout.trim();
      owner = await startSingleContainerApplication({
        docker: baseDocker,
        instanceId: '12345678-1234-4123-8123-123456789abc',
        projectId: '12345678-1234-4123-8123-123456789abc',
        runId,
        targetCommit: 'b'.repeat(40),
        imageId,
        sourceDirectory: source,
        runtime: {
          workingDirectory: '.',
          prepareCommand: [],
          startCommand: ['node', 'app.js'],
          servicePort: 8090,
          healthPath: '/',
          healthTimeoutSeconds: 30,
          composeFile: '',
          composeServices: [],
          applicationService: '',
          commandService: '',
        },
        beforeStart: (containerId) =>
          injectManagedFiles({
            docker: baseDocker,
            containerId,
            files: [
              {
                id: 'single-fixture',
                revision: 1,
                path: 'config/runtime.env',
                serviceName: null,
                content: 'SINGLE_MANAGED=ready\n',
              },
            ],
          }),
      });
      assert.equal(
        await fetch(`${owner.environment.baseUrl}/`).then((response) => response.text()),
        'SINGLE_MANAGED=ready',
      );
    } finally {
      await owner?.close();
      await rm(source, { recursive: true, force: true });
    }
  },
  5 * 60_000,
);
