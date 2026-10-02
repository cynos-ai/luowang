import type {
  EvidenceReference,
  IndexedReport,
  OperationsQueueItem,
  OperationsRunSummary,
  OperationsScenario,
  SystemResourcesResponse,
  SystemStatusResponse,
  WorkspaceProjectSummary,
  WorkspaceResponse,
} from '../../../src/shared/types.js';

export const V07_FIXTURE_MARKER = 'synthetic-v07-console-fixture' as const;

export type V07FixtureState = 'running' | 'empty' | 'partial-error';

export interface V07FixtureProject {
  projectId: string;
  displayName: string;
  githubRepositoryId: string;
  repositoryOwner: string;
  repositoryName: string;
  status: 'active' | 'paused';
  configRevision: number;
  createdAt: string;
  updatedAt: string;
}

export interface V07ConsoleFixture {
  marker: typeof V07_FIXTURE_MARKER;
  now: string;
  projects: V07FixtureProject[];
  workspace: WorkspaceResponse;
  systemStatus: SystemStatusResponse;
  systemResources: SystemResourcesResponse;
  projectData: Record<
    string,
    {
      queue: OperationsQueueItem[];
      runs: OperationsRunSummary[];
      scenarios: OperationsScenario[];
      reports: IndexedReport[];
      evidence: EvidenceReference[];
      readiness: WorkspaceProjectSummary['readiness'];
    }
  >;
  getResponses: Record<string, unknown>;
}

const projectAId = '11111111-1111-4111-8111-111111111111';
const projectBId = '22222222-2222-4222-8222-222222222222';
const runId = '01K00000000000000000000001';
const targetCommit = '6405a45b6889ad92cf7cfbce12d8ec22b5040f23';

export function createV07ConsoleFixture(
  options: { state?: V07FixtureState; now?: string } = {},
): V07ConsoleFixture {
  const state = options.state ?? 'running';
  const now = options.now ?? '2026-09-27T06:20:00.000Z';
  if (state === 'empty') return emptyFixture(now);

  const projects: V07FixtureProject[] = [
    project(projectAId, '官网非生产测试', '1001', 'cynos-ai', 'cynos-website', 'active', now),
    project(
      projectBId,
      'Closure 7 Fixture',
      '1002',
      'cynos-ai',
      'luowang-closure7-fixture',
      'paused',
      now,
    ),
  ];
  const projectA = reference(projects[0]);
  const projectB = reference(projects[1]);
  const evidence: EvidenceReference[] = [
    {
      id: 'evidence-login-page',
      filename: 'login.png',
      objectKey: `projects/${projectAId}/runs/${runId}/evidence/login.png`,
      url: `/api/projects/${projectAId}/runs/${runId}/evidence/evidence-login-page`,
      contentType: 'image/png',
      sizeBytes: 2048,
      sha256: 'a'.repeat(64),
      uploadedAt: now,
      screenshotInspection: { status: 'detected', scope: 'page', sha256: 'a'.repeat(64) },
    },
  ];
  const run = fixtureRun(now, evidence);
  const scenario = fixtureScenario(now);
  const report = fixtureReport(now);
  const readinessA = {
    status: 'ready' as const,
    checkedAt: now,
    staleReason: null,
    checks: [
      {
        id: 'repository',
        label: '仓库身份',
        status: 'ok' as const,
        message: '通过',
        checkedAt: now,
      },
      { id: 'image', label: '执行镜像', status: 'ok' as const, message: '已准备', checkedAt: now },
      {
        id: 'environment',
        label: '非生产环境',
        status: 'ok' as const,
        message: '通过',
        checkedAt: now,
      },
      {
        id: 'credentials',
        label: '测试与清理凭据',
        status: 'ok' as const,
        message: '配置一致',
        checkedAt: now,
      },
      {
        id: 'deployment',
        label: '共享依赖',
        status: 'ok' as const,
        message: '模型、浏览器和对象存储可用',
        checkedAt: now,
      },
    ],
  };
  const readinessB = {
    status: 'not_checked' as const,
    checkedAt: null,
    staleReason: null,
    checks: [],
  };
  const partial = state === 'partial-error';
  const projectSummaries: WorkspaceProjectSummary[] = [
    {
      project: projectA,
      activity: 'running',
      projectQueuePosition: null,
      recentRun: runReference(run),
      readiness: readinessA,
      attentionCount: 0,
      indexedCommit: targetCommit,
      lastIndexedAt: now,
      staleReason: null,
      readError: null,
    },
    {
      project: projectB,
      activity: 'paused',
      projectQueuePosition: null,
      recentRun: null,
      readiness: readinessB,
      attentionCount: 1,
      indexedCommit: null,
      lastIndexedAt: null,
      staleReason: partial ? '项目索引暂时不可读' : null,
      readError: partial ? { code: 'PROJECT_READ_FAILED', message: '项目摘要暂时不可用' } : null,
    },
  ];
  const workspace: WorkspaceResponse = {
    fetchedAt: now,
    capacity: { occupied: 1, limit: 2 },
    activeRuns: [
      {
        queueId: 1,
        ...runReference(run),
        project: projectA,
        role: 'runner',
        stage: 'Runner 执行',
        currentScenario: 'AUTH-LOGIN-001',
        progress: { completed: 3, total: 8 },
        updatedAt: now,
      },
    ],
    queue: [
      {
        projectPosition: 1,
        waitingReason: '项目已暂停',
        queueId: 2,
        requestId: 'request-synthetic-2',
        project: projectB,
        request: '验证固定验收场景',
        trigger: 'manual',
        status: 'queued',
        createdAt: now,
      },
    ],
    projects: projectSummaries,
    recentRuns: [],
    attention: [
      {
        id: 'attention-not-checked-project-b',
        kind: 'not_ready',
        severity: 'warning',
        title: '项目尚未完成运行准备检查',
        detail: 'Closure 7 Fixture · 尚未检查',
        occurredAt: null,
        project: projectB,
        target: { kind: 'project-readiness', projectId: projectBId },
      },
    ],
    partialErrors: partial
      ? [{ projectId: projectBId, code: 'PROJECT_READ_FAILED', message: '项目摘要暂时不可用' }]
      : [],
  };
  const systemStatus = fixtureSystemStatus(now);
  const systemResources = fixtureSystemResources(now);
  const projectData = {
    [projectAId]: {
      queue: [],
      runs: [run],
      scenarios: [scenario],
      reports: [report],
      evidence,
      readiness: readinessA,
    },
    [projectBId]: {
      queue: [fixtureQueue(now)],
      runs: [],
      scenarios: [],
      reports: [],
      evidence: [],
      readiness: readinessB,
    },
  };
  return {
    marker: V07_FIXTURE_MARKER,
    now,
    projects,
    workspace,
    systemStatus,
    systemResources,
    projectData,
    getResponses: responseMap(projects, workspace, systemStatus, systemResources, projectData),
  };
}

function emptyFixture(now: string): V07ConsoleFixture {
  const workspace: WorkspaceResponse = {
    fetchedAt: now,
    activeRuns: [],
    capacity: { occupied: 0, limit: 2 },
    queue: [],
    projects: [],
    recentRuns: [],
    attention: [],
    partialErrors: [],
  };
  const systemStatus = fixtureSystemStatus(now);
  const systemResources = {
    ...fixtureSystemResources(now),
    projects: [],
    containers: [],
    images: [],
  };
  return {
    marker: V07_FIXTURE_MARKER,
    now,
    projects: [],
    workspace,
    systemStatus,
    systemResources,
    projectData: {},
    getResponses: responseMap([], workspace, systemStatus, systemResources, {}),
  };
}

function project(
  projectId: string,
  displayName: string,
  githubRepositoryId: string,
  repositoryOwner: string,
  repositoryName: string,
  status: 'active' | 'paused',
  now: string,
): V07FixtureProject {
  return {
    projectId,
    displayName,
    githubRepositoryId,
    repositoryOwner,
    repositoryName,
    status,
    configRevision: 17,
    createdAt: now,
    updatedAt: now,
  };
}

function reference(value: V07FixtureProject) {
  return {
    projectId: value.projectId,
    displayName: value.displayName,
    repositoryOwner: value.repositoryOwner,
    repositoryName: value.repositoryName,
    status: value.status,
  };
}

function fixtureRun(now: string, evidence: EvidenceReference[]): OperationsRunSummary {
  return {
    runId,
    status: 'running',
    phase: 'runner',
    result: null,
    trigger: 'manual',
    request: '验证登录状态恢复与注册错误处理',
    baseCommit: null,
    targetCommit,
    includedCommits: [targetCommit],
    startedAt: now,
    finishedAt: null,
    errorMessage: null,
    artifactNames: [],
    evidence,
    currentScenario: 'AUTH-LOGIN-001',
    scenarioProgress: { completed: 3, total: 8 },
    activities: [{ at: now, message: 'Runner 正在执行场景', kind: 'phase' }],
    blockingReasons: [],
    updatedAt: now,
    archive: null,
    scenarioResults: [],
    confirmedBugs: [],
    issues: [],
  };
}

function runReference(run: OperationsRunSummary) {
  return {
    runId: run.runId,
    status: run.status,
    phase: run.phase,
    result: run.result,
    targetCommit: run.targetCommit,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
  };
}

function fixtureQueue(now: string): OperationsQueueItem {
  return {
    queueId: 2,
    requestId: 'request-synthetic-2',
    trigger: 'manual',
    triggerSources: ['manual'],
    requestIds: ['request-synthetic-2'],
    request: '验证固定验收场景',
    targetRef: null,
    requestKind: 'manual-current-head',
    sourceRef: null,
    preparedMergeCommit: null,
    preparedMergeMode: null,
    resolvedTargetCommit: null,
    status: 'queued',
    runId: null,
    claimedAt: null,
    waitingArchiveAt: null,
    completedAt: null,
    errorMessage: null,
    archiveStatus: null,
    progressed: null,
    createdAt: now,
    updatedAt: now,
    initialization: false,
  };
}

function fixtureScenario(now: string): OperationsScenario {
  return {
    id: 'AUTH-LOGIN-001',
    path: 'docs/scenario-testing/scenarios/AUTH-LOGIN-001.md',
    name: '登录状态恢复',
    description: '验证登录后刷新受保护页面仍保持会话。',
    status: 'approved',
    tags: ['core', 'module:认证'],
    content: '# 登录状态恢复\n\n验证可观察业务结果。',
    commitSha: targetCommit,
    indexedAt: now,
    history: [],
    pendingPullRequests: [],
  };
}

function fixtureReport(now: string): IndexedReport {
  return {
    runId,
    path: `docs/scenario-testing/reports/${runId}/report.md`,
    trigger: 'manual',
    baseCommit: null,
    targetCommit,
    includedCommits: [targetCommit],
    result: 'passed',
    startedAt: now,
    finishedAt: now,
    scenarioResults: [{ id: 'AUTH-LOGIN-001', result: 'passed' }],
    confirmedBugs: [],
    files: { 'report.md': '# 正式报告\n\n合成 E2E fixture。' },
    content: '# 正式报告\n\n合成 E2E fixture。',
    commitSha: targetCommit,
    indexedAt: now,
  };
}

function fixtureSystemStatus(now: string): SystemStatusResponse {
  return {
    fetchedAt: now,
    service: { name: 'luowang', version: '0.7.0-test', build: 'synthetic' },
    database: 'ok',
    secretStore: 'available',
    executionCapacity: { occupied: 1, limit: 2 },
    scheduler: {
      running: true,
      lastPollAt: now,
      nextPollAt: null,
      lastArchiveAt: null,
      nextArchiveAt: null,
      lastIndexerAt: now,
      nextIndexerAt: null,
      lastCleanupAt: null,
      nextCleanupAt: null,
      lastCronKey: null,
      lastError: null,
    },
    dependencies: [
      {
        id: 'provider',
        label: '模型 Provider',
        status: 'ok',
        message: '合成检查通过',
        checkedAt: now,
        lastSucceededAt: now,
        settingsSection: 'models',
      },
      {
        id: 'browser',
        label: '浏览器运行环境',
        status: 'ok',
        message: '合成检查通过',
        checkedAt: now,
        lastSucceededAt: now,
        settingsSection: 'browser',
      },
      {
        id: 'oss',
        label: '对象存储',
        status: 'not_checked',
        message: '尚未检查',
        checkedAt: null,
        lastSucceededAt: null,
        settingsSection: 'object-storage',
      },
    ],
    recovery: { guideId: 'multi-project-recovery', available: true },
  };
}

function fixtureSystemResources(now: string): SystemResourcesResponse {
  return {
    fetchedAt: now,
    instanceId: 'synthetic-instance',
    projects: [projectAId, projectBId],
    containers: [{ containerId: 'c'.repeat(64), projectId: projectAId, runId }],
    images: [
      {
        imageId: `sha256:${'d'.repeat(64)}`,
        projectId: projectAId,
        sizeBytes: 1024,
        disposition: 'referenced',
      },
    ],
    candidateImageBytes: 0,
  };
}

function responseMap(
  projects: V07FixtureProject[],
  workspace: WorkspaceResponse,
  systemStatus: SystemStatusResponse,
  systemResources: SystemResourcesResponse,
  projectData: V07ConsoleFixture['projectData'],
): Record<string, unknown> {
  const responses: Record<string, unknown> = {
    '/api/auth/status': { configured: true, authenticated: true },
    '/api/mode': { mode: 'multi-project' },
    '/api/projects': { projects },
    '/api/workspace': workspace,
    '/api/system/status': systemStatus,
    '/api/system/resources': systemResources,
  };
  for (const project of projects) {
    const base = `/api/projects/${project.projectId}`;
    const data = projectData[project.projectId];
    responses[`${base}/queue`] = { queue: data.queue };
    responses[`${base}/runs`] = { runs: data.runs };
    responses[`${base}/scenarios`] = { scenarios: data.scenarios };
    responses[`${base}/reports`] = { reports: data.reports };
    responses[`${base}/readiness`] = data.readiness;
  }
  return responses;
}
