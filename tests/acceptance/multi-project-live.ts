import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

type RunExpectation = {
  queueId: number;
  runId: string;
  targetCommit: string;
  reportCommit: string;
  result: 'passed' | 'blocked' | 'failed';
  scenarios: Record<string, 'passed' | 'blocked' | 'failed'>;
  minScreenshots: number;
  minCleanup: number;
};

type ProjectExpectation = {
  projectId: string;
  repository: string;
  runs: RunExpectation[];
};

type Manifest = { projects: ProjectExpectation[] };
type Json = Record<string, unknown>;

const sha = /^[0-9a-f]{40}$/;
const runIdPattern = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const repositoryPattern = /^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/;

function record(value: unknown, label: string): Json {
  check(value !== null && typeof value === 'object' && !Array.isArray(value), `${label} invalid`);
  return value as Json;
}

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

export function validateManifest(value: unknown): Manifest {
  const manifest = record(value, 'manifest');
  check(
    Array.isArray(manifest.projects) && manifest.projects.length >= 2,
    'at least two projects required',
  );
  const projectIds = new Set<string>();
  const repositories = new Set<string>();
  const runIds = new Set<string>();
  for (const rawProject of manifest.projects) {
    const project = record(rawProject, 'project');
    check(
      typeof project.projectId === 'string' && /^[a-f0-9-]{36}$/.test(project.projectId),
      'invalid project ID',
    );
    check(
      typeof project.repository === 'string' && repositoryPattern.test(project.repository),
      'invalid repository',
    );
    check(
      !projectIds.has(project.projectId) && !repositories.has(project.repository),
      'duplicate project',
    );
    projectIds.add(project.projectId);
    repositories.add(project.repository);
    check(Array.isArray(project.runs) && project.runs.length > 0, 'project has no runs');
    for (const rawRun of project.runs) {
      const run = record(rawRun, 'run');
      check(Number.isInteger(run.queueId) && Number(run.queueId) > 0, 'invalid queue ID');
      check(typeof run.runId === 'string' && runIdPattern.test(run.runId), 'invalid Run ID');
      check(!runIds.has(run.runId), 'duplicate Run ID');
      runIds.add(run.runId);
      check(
        typeof run.targetCommit === 'string' && sha.test(run.targetCommit),
        'invalid target commit',
      );
      check(
        typeof run.reportCommit === 'string' && sha.test(run.reportCommit),
        'invalid report commit',
      );
      check(['passed', 'blocked', 'failed'].includes(String(run.result)), 'invalid result');
      check(
        Number.isInteger(run.minScreenshots) && Number(run.minScreenshots) >= 0,
        'invalid screenshot count',
      );
      check(
        Number.isInteger(run.minCleanup) && Number(run.minCleanup) >= 0,
        'invalid cleanup count',
      );
      const scenarios = record(run.scenarios, 'scenarios');
      check(Object.keys(scenarios).length > 0, 'no expected scenarios');
      check(
        Object.values(scenarios).every((result) =>
          ['passed', 'blocked', 'failed'].includes(String(result)),
        ),
        'invalid scenario result',
      );
    }
  }
  return manifest as Manifest;
}

export function verifyRunFacts(input: {
  project: ProjectExpectation;
  expectation: RunExpectation;
  queue: unknown;
  run: unknown;
  report: unknown;
}): { screenshots: Json[]; cleanupCount: number; reportContent: string } {
  const { project, expectation } = input;
  const queue = record(input.queue, 'queue');
  const run = record(input.run, 'run');
  const report = record(input.report, 'report');
  const label = `${project.repository} Run ${expectation.runId}`;
  check(
    queue.queueId === expectation.queueId && queue.runId === expectation.runId,
    `${label}: wrong queue ownership`,
  );
  check(
    queue.status === 'completed' && queue.archiveStatus === 'completed',
    `${label}: queue not archived`,
  );
  check(queue.resolvedTargetCommit === expectation.targetCommit, `${label}: queue target changed`);
  check(
    run.runId === expectation.runId && run.targetCommit === expectation.targetCommit,
    `${label}: Run target changed`,
  );
  check(
    run.status === 'completed' && run.result === expectation.result,
    `${label}: unexpected Run result`,
  );
  check(
    run.archiveStatus === 'completed' && run.reportStatus === 'published',
    `${label}: report not published`,
  );
  check(run.reportCommitSha === expectation.reportCommit, `${label}: report commit changed`);
  check(
    report.runId === expectation.runId && report.targetCommit === expectation.targetCommit,
    `${label}: wrong indexed report`,
  );
  check(report.result === expectation.result, `${label}: indexed result differs`);
  check(
    report.path === `docs/scenario-testing/reports/${expectation.runId}`,
    `${label}: wrong report path`,
  );
  const results = Array.isArray(run.scenarioResults) ? run.scenarioResults : [];
  for (const [id, result] of Object.entries(expectation.scenarios)) {
    check(
      results.some((item) => item && item.id === id && item.result === result),
      `${label}: scenario ${id} differs`,
    );
  }
  const reportedResults = Array.isArray(report.scenarioResults) ? report.scenarioResults : [];
  for (const [id, result] of Object.entries(expectation.scenarios)) {
    check(
      reportedResults.some((item) => item && item.id === id && item.result === result),
      `${label}: indexed scenario ${id} differs`,
    );
  }
  const screenshots = Array.isArray(run.evidence)
    ? run.evidence.filter((item): item is Json => item?.contentType === 'image/png')
    : [];
  check(screenshots.length >= expectation.minScreenshots, `${label}: screenshots missing`);
  const content = String(report.content ?? '');
  check(content.includes('## Harness 清理收尾'), `${label}: cleanup section missing`);
  const cleanupCount = (content.match(/独立核验：[^\n]*absent=true/g) ?? []).length;
  check(cleanupCount >= expectation.minCleanup, `${label}: cleanup receipts missing`);
  return { screenshots, cleanupCount, reportContent: content };
}

export function verifyEvidence(reference: unknown, body: Buffer): void {
  const evidence = record(reference, 'evidence');
  check(evidence.contentType === 'image/png', 'evidence is not PNG');
  check(
    typeof evidence.sha256 === 'string' && /^[0-9a-f]{64}$/.test(evidence.sha256),
    'evidence hash invalid',
  );
  check(body.length > 0 && body.length === evidence.sizeBytes, 'evidence size differs');
  check(
    createHash('sha256').update(body).digest('hex') === evidence.sha256,
    'evidence hash differs',
  );
}

async function main(): Promise<void> {
  const manifestPath = process.env.LUOWANG_MP_LIVE_MANIFEST;
  const password = process.env.LUOWANG_ADMIN_PASSWORD;
  const origin = process.env.LUOWANG_MP_LIVE_HARNESS_URL;
  if (!manifestPath || !password || !origin) {
    process.stdout.write(
      'multi-project live=blocked: manifest, harness URL and admin password required\n',
    );
    process.exitCode = 2;
    return;
  }
  const manifest = validateManifest(JSON.parse(await readFile(manifestPath, 'utf8')));
  const base = new URL(origin);
  check(
    ['http:', 'https:'].includes(base.protocol) &&
      !base.username &&
      !base.password &&
      base.pathname === '/',
    'invalid harness URL',
  );
  const login = await fetch(new URL('/api/auth/login', base), {
    method: 'POST',
    headers: { origin: base.origin, 'content-type': 'application/json' },
    body: JSON.stringify({ password }),
    signal: AbortSignal.timeout(30_000),
  });
  check(login.ok, `harness login HTTP ${login.status}`);
  const cookie = login.headers.get('set-cookie')?.split(';', 1)[0];
  await login.body?.cancel();
  check(cookie && /^[^=]+=.+$/.test(cookie), 'login cookie missing');
  async function harness(path: string, expected = 200): Promise<Json> {
    const response = await fetch(new URL(path, base), {
      headers: { cookie: cookie!, origin: base.origin },
      signal: AbortSignal.timeout(120_000),
    });
    check(response.status === expected, `${path}: HTTP ${response.status}, expected ${expected}`);
    if (expected === 404) {
      await response.body?.cancel();
      return {};
    }
    return record(await response.json(), path);
  }
  const summaries: Json[] = [];
  for (const project of manifest.projects) {
    const prefix = `/api/projects/${project.projectId}`;
    const queue = record(await harness(`${prefix}/queue`), 'queue response').queue;
    check(Array.isArray(queue), `${project.repository}: queue unavailable`);
    for (const expectation of project.runs) {
      const run = (await harness(`${prefix}/runs/${expectation.runId}`)).run;
      const report = (await harness(`${prefix}/reports/${expectation.runId}`)).report;
      const facts = verifyRunFacts({
        project,
        expectation,
        queue: queue.find((item) => item?.queueId === expectation.queueId),
        run,
        report,
      });
      for (const evidence of facts.screenshots) {
        const response = await fetch(
          new URL(`${prefix}/runs/${expectation.runId}/evidence/${evidence.id}`, base),
          {
            headers: { cookie: cookie!, origin: base.origin },
            signal: AbortSignal.timeout(120_000),
          },
        );
        check(
          response.ok && response.headers.get('content-type')?.startsWith('image/png'),
          `${expectation.runId}: screenshot read failed`,
        );
        verifyEvidence(evidence, Buffer.from(await response.arrayBuffer()));
      }
      for (const other of manifest.projects.filter(
        (item) => item.projectId !== project.projectId,
      )) {
        await harness(`/api/projects/${other.projectId}/runs/${expectation.runId}`, 404);
        await harness(`/api/projects/${other.projectId}/reports/${expectation.runId}`, 404);
      }
      const remote = await fetch(
        `https://api.github.com/repos/${project.repository}/contents/docs/scenario-testing/reports/${expectation.runId}/report.md?ref=${expectation.reportCommit}`,
        {
          headers: {
            accept: 'application/vnd.github+json',
            'user-agent': 'luowang-multi-project-acceptance',
          },
          signal: AbortSignal.timeout(120_000),
        },
      );
      check(remote.ok, `${project.repository}: remote report HTTP ${remote.status}`);
      const remoteFile = record(await remote.json(), 'remote report');
      check(
        remoteFile.encoding === 'base64' && typeof remoteFile.content === 'string',
        'remote report encoding invalid',
      );
      const remoteContent = Buffer.from(remoteFile.content.replace(/\s/g, ''), 'base64').toString(
        'utf8',
      );
      check(
        remoteContent === facts.reportContent,
        `${expectation.runId}: indexed and remote report differ`,
      );
      summaries.push({
        repository: project.repository,
        queueId: expectation.queueId,
        runId: expectation.runId,
        result: expectation.result,
        screenshots: facts.screenshots.length,
        cleanup: facts.cleanupCount,
        targetCommit: expectation.targetCommit,
        reportCommit: expectation.reportCommit,
      });
    }
  }
  process.stdout.write(
    `${JSON.stringify({ status: 'passed', projects: manifest.projects.length, runs: summaries })}\n`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error: unknown) => {
    process.stderr.write(
      `multi-project live=failed: ${error instanceof Error ? error.message : 'unknown error'}\n`,
    );
    process.exitCode = 1;
  });
}
