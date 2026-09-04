import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';

import { describe, it } from 'vitest';

import {
  LIVE_INPUT_NAMES,
  createLayeredReport,
  isNewSemVerTag,
  localOnlyEnvironment,
  missingLiveInputs,
  parseGitHubRepository,
  parseHarnessUrl,
  PUBLIC_QUALITY_SCRIPTS,
  redactAcceptanceText,
  selectLiveFacts,
  type ClosureProofStatuses,
} from './acceptance/closure.js';

describe('Closure 6 acceptance status layering', () => {
  it('lists every missing live input by name without exposing configured values', () => {
    const environment: NodeJS.ProcessEnv = {
      LUOWANG_LIVE_REPOSITORY: 'https://github.com/example/private-target',
      LUOWANG_LIVE_GITHUB_TOKEN: 'canary-live-secret-value',
    };
    const missing = missingLiveInputs(environment);
    assert.equal(missing.includes('LUOWANG_LIVE_REPOSITORY'), false);
    assert.equal(missing.includes('LUOWANG_LIVE_GITHUB_TOKEN'), false);
    assert.deepEqual(
      missing,
      LIVE_INPUT_NAMES.filter(
        (name) => name !== 'LUOWANG_LIVE_REPOSITORY' && name !== 'LUOWANG_LIVE_GITHUB_TOKEN',
      ),
    );
    assert.doesNotMatch(JSON.stringify(missing), /canary-live-secret-value/);
  });

  it('treats explicit safety confirmations as missing unless they equal true', () => {
    const environment = Object.fromEntries(LIVE_INPUT_NAMES.map((name) => [name, 'provided']));
    environment.LUOWANG_LIVE_NON_PRODUCTION_CONFIRMED = 'false';
    environment.LUOWANG_LIVE_REVIEWER_VISION_CONFIRMED = 'TRUE';
    environment.LUOWANG_LIVE_MAIN_THINKING = 'unsupported';
    environment.LUOWANG_LIVE_RUNNER_THINKING = 'high';
    const missing = missingLiveInputs(environment);
    assert.equal(missing.includes('LUOWANG_LIVE_NON_PRODUCTION_CONFIRMED'), true);
    assert.equal(missing.includes('LUOWANG_LIVE_REVIEWER_VISION_CONFIRMED'), false);
    assert.equal(missing.includes('LUOWANG_LIVE_MAIN_THINKING'), true);
    assert.equal(missing.includes('LUOWANG_LIVE_RUNNER_THINKING'), false);
    assert.equal(missing.includes('LUOWANG_LIVE_OSS_PRIVATE_CONFIRMED'), true);
  });

  it('builds local subprocess environment from a non-secret allowlist', () => {
    const original = {
      github: process.env.GITHUB_TOKEN,
      aws: process.env.AWS_SECRET_ACCESS_KEY,
      master: process.env.LUOWANG_MASTER_KEY,
    };
    process.env.GITHUB_TOKEN = 'canary-github-value';
    process.env.AWS_SECRET_ACCESS_KEY = 'canary-aws-value';
    process.env.LUOWANG_MASTER_KEY = 'canary-master-value';
    try {
      const environment = localOnlyEnvironment('/tmp/luowang-closure6-environment');
      assert.equal(environment.GITHUB_TOKEN, undefined);
      assert.equal(environment.AWS_SECRET_ACCESS_KEY, undefined);
      assert.equal(environment.LUOWANG_MASTER_KEY, undefined);
      assert.equal(environment.NODE_ENV, 'test');
      assert.equal(environment.HOME, '/tmp/luowang-closure6-environment/isolated-home');
      assert.doesNotMatch(JSON.stringify(environment), /canary-(?:github|aws|master)-value/);
    } finally {
      restoreEnvironment('GITHUB_TOKEN', original.github);
      restoreEnvironment('AWS_SECRET_ACCESS_KEY', original.aws);
      restoreEnvironment('LUOWANG_MASTER_KEY', original.master);
    }
  });

  it('redacts credential-shaped command output before it can enter reports', () => {
    const output = redactAcceptanceText(
      `Authorization: Bearer canary-bearer token=canary-token {"token":"canary-json-token","apiKey":"canary-json-key","password":"canary-json-password"} github_pat_1234567890abcdef AKIA1234567890ABCDEF https://user:pass@example.test/path`,
    );
    assert.doesNotMatch(output, /canary-|github_pat_|AKIA123|user:pass/);
    assert.match(output, /REDACTED/);
  });

  it('keeps release blocked when local passes but live is blocked', () => {
    const report = createLayeredReport({
      mode: 'local',
      startedAt: '2026-09-01T00:00:00.000Z',
      local: { status: 'passed', message: 'local passed' },
      live: {
        status: 'blocked',
        message: 'live inputs missing',
        missing: ['LUOWANG_LIVE_PROVIDER_API_KEY'],
      },
      proofs: proofStatuses(),
    });
    assert.equal(report.local.status, 'passed');
    assert.equal(report.live.status, 'blocked');
    assert.equal(report.release.status, 'blocked');
    assert.equal(report.acEvidence.length, 18);
    assert.equal(new Set(report.acEvidence.map((item) => item.ac)).size, 18);
    assert.equal(
      report.resourceChecks.every((item) => item.evidence.length > 0),
      true,
    );
  });

  it('selects independent completed live lifecycle facts without treating blocked as passed', () => {
    const queue = [
      {
        queueId: 1,
        requestKind: 'manual-merge-source',
        initialization: true,
        preparedMergeMode: 'initial-create',
        preparedMergeCommit: 'a'.repeat(40),
        resolvedTargetCommit: 'a'.repeat(40),
        status: 'completed',
        archiveStatus: 'completed',
        runId: 'init-run',
      },
      {
        queueId: 2,
        requestKind: 'manual-current-head',
        status: 'completed',
        archiveStatus: 'completed',
        runId: 'passed-run',
      },
    ];
    const runs = [
      {
        runId: 'init-run',
        initialization: true,
        targetCommit: 'a'.repeat(40),
        status: 'completed',
        result: 'blocked',
      },
      {
        runId: 'passed-run',
        status: 'completed',
        result: 'passed',
        scenarioProgress: { completed: 1, total: 1 },
        evidence: [{ contentType: 'image/png' }],
        activities: [{ message: '开始场景 AUTH-001' }, { message: '完成场景 AUTH-001' }],
      },
      {
        runId: 'failed-run',
        status: 'completed',
        result: 'failed',
        confirmedBugs: [{ key: 'BUG-1' }, { key: 'BUG-2' }],
        issues: [
          {
            status: 'succeeded',
            issueNumber: 1,
            issueUrl: 'https://github.com/example/repo/issues/1',
          },
          {
            status: 'succeeded',
            issueNumber: 2,
            issueUrl: 'https://github.com/example/repo/issues/2',
          },
        ],
      },
      {
        runId: 'blocked-run',
        status: 'completed',
        result: 'blocked',
        scenarioResults: [{ id: 'AUTH-001', result: 'blocked' }],
        archive: { archiveStatus: 'completed', progressed: false },
      },
      {
        runId: 'review-run',
        status: 'completed',
        result: 'blocked',
        artifactNames: ['scenario-changes.patch', 'report.md'],
        scenarioPrUrl: 'https://github.com/example/repo/pull/1',
        archive: {
          reportStatus: 'not_applicable',
          archiveStatus: 'completed',
          scenarioStatus: 'pull_request',
          progressed: false,
        },
      },
    ];
    const facts = selectLiveFacts(queue, runs);
    assert.equal(facts.initializationRunId, 'init-run');
    assert.equal(facts.passedRunId, 'passed-run');
    assert.equal(facts.failedRunId, 'failed-run');
    assert.equal(facts.blockedRunId, 'blocked-run');
    assert.equal(facts.scenarioReviewRunId, 'review-run');
    assert.equal(facts.currentHeadRetestRunId, 'passed-run');
    assert.equal(facts.progressRunId, 'passed-run');
  });

  it('rejects credential-exfiltrating live URLs and non-SemVer release tags', () => {
    assert.equal(parseHarnessUrl('http://127.0.0.1:3000', ''), 'http://127.0.0.1:3000');
    assert.throws(() => parseHarnessUrl('http://example.test:3000', 'http://example.test:3000'));
    assert.throws(() => parseHarnessUrl('https://user:pass@example.test', 'https://example.test'));
    assert.throws(() => parseHarnessUrl('https://example.test/path', 'https://example.test'));
    assert.equal(
      parseHarnessUrl('https://harness.example.test', 'https://harness.example.test'),
      'https://harness.example.test',
    );
    assert.deepEqual(parseGitHubRepository('https://github.com/cynos-ai/luowang.git'), {
      owner: 'cynos-ai',
      name: 'luowang',
    });
    assert.throws(() => parseGitHubRepository('http://github.com/cynos-ai/luowang'));
    assert.throws(() => parseGitHubRepository('https://user@github.com/cynos-ai/luowang'));
    assert.equal(isNewSemVerTag('v0.2.0'), true);
    assert.equal(isNewSemVerTag('v1.0.0'), true);
    assert.equal(isNewSemVerTag('v0.1.0'), false);
    assert.equal(isNewSemVerTag('release-latest'), false);
    assert.equal(isNewSemVerTag('v0.2.0-rc.1'), false);
  });

  it('keeps the publication AC blocked until the immutable release tag is verified', () => {
    const preRelease = createLayeredReport({
      mode: 'release',
      startedAt: '2026-09-01T00:00:00.000Z',
      local: { status: 'passed', message: 'local passed' },
      live: { status: 'passed', message: 'live passed' },
      proofs: proofStatuses(),
    });
    assert.equal(preRelease.release.status, 'passed');
    assert.equal(
      preRelease.acEvidence.find((item) => item.ac === 'AC-CLOSURE-RELEASE-01')?.status,
      'blocked',
    );
    const published = createLayeredReport({
      mode: 'release',
      startedAt: '2026-09-01T00:00:00.000Z',
      local: { status: 'passed', message: 'local passed' },
      live: { status: 'passed', message: 'live passed' },
      proofs: proofStatuses(),
      releasePublished: true,
    });
    assert.equal(
      published.acEvidence.find((item) => item.ac === 'AC-CLOSURE-RELEASE-01')?.status,
      'passed',
    );
    const livePostPublication = createLayeredReport({
      mode: 'live',
      startedAt: '2026-09-01T00:00:00.000Z',
      local: { status: 'not_run', message: 'not run' },
      live: { status: 'passed', message: 'live passed' },
      proofs: proofStatuses(),
      releasePublished: true,
    });
    assert.equal(livePostPublication.release.status, 'blocked');
    assert.equal(
      livePostPublication.acEvidence.find((item) => item.ac === 'AC-CLOSURE-RELEASE-01')?.status,
      'passed',
    );
  });

  it('derives each AC status from its corresponding proof instead of the local aggregate', () => {
    const report = createLayeredReport({
      mode: 'local',
      startedAt: '2026-09-01T00:00:00.000Z',
      local: { status: 'passed', message: 'aggregate local status' },
      live: { status: 'blocked', message: 'live blocked' },
      proofs: proofStatuses({
        merge01: 'blocked',
        data02: 'failed',
        history01: 'not_run',
        ordinaryPi: 'failed',
        acceptanceLayering: 'passed',
        acMapping: 'blocked',
      }),
    });
    const statuses = Object.fromEntries(report.acEvidence.map((item) => [item.ac, item.status]));
    assert.equal(statuses['AC-CLOSURE-MERGE-01'], 'blocked');
    assert.equal(statuses['AC-CLOSURE-DATA-02'], 'failed');
    assert.equal(statuses['AC-CLOSURE-HISTORY-01'], 'not_run');
    assert.equal(statuses['AC-CLOSURE-PI-01'], 'failed');
    assert.equal(statuses['AC-CLOSURE-ACCEPT-01'], 'passed');
    assert.equal(statuses['AC-CLOSURE-ACCEPT-02'], 'blocked');
    assert.equal(statuses['AC-CLOSURE-TARGET-01'], 'passed');
    assert.equal(
      report.resourceChecks.find((item) => item.id === 'pi-sdk-ordinary-four-session')?.status,
      'failed',
    );
    assert.equal(report.resourceChecks.at(-1)?.status, 'blocked');
  });

  it('documents Docker priority, native build dependencies, and honest acceptance boundaries', async () => {
    const readme = await readFile('README.md', 'utf8');
    assert.match(readme, /优先使用.*Docker/s);
    assert.match(readme, /python3.*make.*g\+\+/s);
    assert.match(readme, /test:acceptance:local/);
    assert.match(readme, /test:acceptance:live/);
    assert.match(readme, /test:acceptance:release/);
    assert.match(readme, /local.*只能证明.*local\.status=passed/s);
    assert.match(readme, /release\.status.*blocked/);
  });

  it('validates integrated role instruction method content when Closure 1 is present', async () => {
    const files = [
      'common.md',
      'main-planning.md',
      'runner-execution.md',
      'reviewer-audit.md',
      'main-finalization.md',
      'scenario-initialization.md',
    ];
    let contents: string[];
    try {
      contents = await Promise.all(
        files.map((file) => readFile(`resources/agent-roles/${file}`, 'utf8')),
      );
    } catch {
      return;
    }
    for (const [index, content] of contents.entries()) {
      assert.match(content, new RegExp(`luowang-role-id: ${files[index]?.replace(/\.md$/, '')}`));
      for (const heading of ['目标', '硬边界', '顺序', '输出契约', '失败规则', '反模式']) {
        assert.match(content, new RegExp(`## ${heading}`));
      }
    }
    const all = contents.join('\n');
    assert.match(all, /不得用当前实现反推正确期望/);
    assert.match(all, /证据优先级/);
    assert.match(all, /Runner 报告是待审核假设/);
    assert.match(all, /清理声明不是独立核验事实/);
    assert.match(all, /不影响验证目标的偏差可以记录后继续/);
    assert.match(all, /blocked > failed > passed/);
  });

  it('requires every public quality command before local or release acceptance can pass', () => {
    assert.deepEqual(PUBLIC_QUALITY_SCRIPTS, [
      'format:check',
      'lint',
      'typecheck',
      'test',
      'build',
      'test:e2e',
    ]);
    const report = createLayeredReport({
      mode: 'release',
      startedAt: '2026-09-01T00:00:00.000Z',
      local: { status: 'failed', message: 'quality failed' },
      live: { status: 'passed', message: 'live passed' },
      proofs: proofStatuses({ publicQuality: 'failed' }),
    });
    assert.equal(
      report.acEvidence.find((item) => item.ac === 'AC-CLOSURE-ACCEPT-01')?.status,
      'failed',
    );
    assert.equal(report.release.status, 'failed');
  });

  it('exposes separate package commands and keeps CI on local only', async () => {
    const packageJson = JSON.parse(await readFile('package.json', 'utf8')) as {
      scripts: Record<string, string>;
    };
    assert.equal(packageJson.scripts['test:acceptance'], 'npm run test:acceptance:local');
    assert.match(packageJson.scripts['test:acceptance:local'] ?? '', /closure\.ts local/);
    assert.match(packageJson.scripts['test:acceptance:live'] ?? '', /closure\.ts live/);
    assert.match(packageJson.scripts['test:acceptance:release'] ?? '', /closure\.ts release/);
    const workflow = await readFile('.github/workflows/quality.yml', 'utf8');
    assert.match(workflow, /timeout-minutes:\s*60/);
    assert.match(workflow, /cancel-in-progress:\s*true/);
    assert.match(workflow, /docker\/setup-buildx-action@v3/);
    assert.match(workflow, /docker\/build-push-action@v6/);
    assert.match(workflow, /cache-from:\s*(?:\||type=gha)/);
    assert.match(workflow, /cache-to:\s*type=gha,mode=max/);
    assert.match(workflow, /npm run test:acceptance:local/);
    assert.doesNotMatch(workflow, /npm run test:acceptance:(?:live|release)/);
    const dockerignore = await readFile('.dockerignore', 'utf8');
    assert.match(dockerignore, /!\.github\/workflows\/quality\.yml/);
  });
});

function proofStatuses(overrides: Partial<ClosureProofStatuses> = {}): ClosureProofStatuses {
  return {
    doc: 'passed',
    instr01: 'passed',
    instr02: 'passed',
    instr03: 'passed',
    merge01: 'passed',
    target01: 'passed',
    merge02: 'passed',
    data01: 'passed',
    data02: 'passed',
    active01: 'passed',
    history01: 'passed',
    ordinaryPi: 'passed',
    directInitialization: 'passed',
    scenarioReview: 'passed',
    finalRevision: 'passed',
    invalidTool: 'passed',
    mergeConflict: 'passed',
    indexerRecovery: 'passed',
    archiveRetry: 'passed',
    processRestart: 'passed',
    queueRecovery: 'passed',
    publicQuality: 'passed',
    acceptanceLayering: 'passed',
    acMapping: 'passed',
    ...overrides,
  };
}

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
