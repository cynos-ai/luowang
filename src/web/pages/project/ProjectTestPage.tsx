import { useCallback, useEffect, useState, type FormEvent } from 'react';

import type {
  ConsoleReadinessSnapshot,
  OperationsQueueItem,
  RunActivity,
  RunPhase,
  RunSummary,
  WorkspaceResponse,
} from '../../../shared/types';
import { requestJson, toUserMessage } from '../../api';
import { AppLink } from '../../app/navigation';
import { useResource } from '../../app/resource';
import { AsyncRegion } from '../../components/AsyncRegion';
import { AppMessageFeedback } from '../../components/AppMessageProvider';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { Field } from '../../components/FormControls';
import { PageHeading } from '../../components/PageHeading';
import { StatusLabel } from '../../components/StatusLabel';
import { StopRequestButton } from '../../components/StopRequestButton';
import { diagnosePreparation } from '../../../shared/run-diagnostics';
import type { ProjectDetailResponse } from '../../project-types';

type TestPageData = {
  detail: ProjectDetailResponse;
  readiness: ConsoleReadinessSnapshot | null;
  current: RunSummary | null;
  queue: OperationsQueueItem[];
  runs: RunSummary[];
  workspace: WorkspaceResponse;
};

type PendingRequest =
  | { kind: 'current'; request: string; initialization: boolean }
  | {
      kind: 'merge';
      request: string;
      sourceRef: string;
      initialization: boolean;
    };

const loadError = (cause: unknown) => toUserMessage(cause, '测试状态读取失败');

export function ProjectTestPage({ projectId }: { projectId: string }) {
  const load = useCallback(
    async (signal: AbortSignal): Promise<TestPageData> => {
      const [detail, readiness, current, queue, runs, workspace] = await Promise.all([
        requestJson<ProjectDetailResponse>(`/api/projects/${projectId}`, { signal }),
        requestJson<{ readiness: ConsoleReadinessSnapshot | null }>(
          `/api/projects/${projectId}/readiness/status`,
          { signal },
        ),
        requestJson<{ run: RunSummary | null }>(`/api/projects/${projectId}/runs/current`, {
          signal,
        }),
        requestJson<{ queue: OperationsQueueItem[] }>(`/api/projects/${projectId}/queue`, {
          signal,
        }),
        requestJson<{ runs: RunSummary[] }>(`/api/projects/${projectId}/runs`, { signal }),
        requestJson<WorkspaceResponse>('/api/workspace', { signal }),
      ]);
      return {
        detail,
        readiness: readiness.readiness,
        current: current.run,
        queue: queue.queue,
        runs: runs.runs,
        workspace,
      };
    },
    [projectId],
  );
  const resource = useResource(`project-test:${projectId}`, load, loadError);
  const [showIdle, setShowIdle] = useState(false);
  const [pendingRequest, setPendingRequest] = useState<PendingRequest | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [actionError, setActionError] = useState('');
  const data = resource.value;

  useEffect(() => {
    const reloadIfVisible = () => {
      if (document.visibilityState === 'visible') resource.reload();
    };
    const interval = window.setInterval(reloadIfVisible, 2_000);
    document.addEventListener('visibilitychange', reloadIfVisible);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener('visibilitychange', reloadIfVisible);
    };
  }, [resource.reload]);

  useEffect(() => {
    setShowIdle(false);
    setPendingRequest(null);
    setMessage('');
    setActionError('');
  }, [projectId]);

  async function submitRequest() {
    if (!pendingRequest) return;
    setBusy(true);
    setMessage('');
    setActionError('');
    try {
      if (pendingRequest.kind === 'current') {
        await requestJson(`/api/projects/${projectId}/runs`, {
          method: 'POST',
          body: JSON.stringify({
            request: pendingRequest.request,
            trigger: 'manual',
            initialization: pendingRequest.initialization,
          }),
        });
      } else {
        await requestJson(`/api/projects/${projectId}/merge`, {
          method: 'POST',
          body: JSON.stringify({
            sourceRef: pendingRequest.sourceRef,
            request: pendingRequest.request,
            initialization: pendingRequest.initialization,
            confirmed: true,
          }),
        });
      }
      setPendingRequest(null);
      setShowIdle(false);
      setMessage('测试请求已进入项目队列。');
      resource.reload();
    } catch (cause) {
      setActionError(toUserMessage(cause, '测试请求提交失败'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="page-content project-test-page">
      <PageHeading title="测试" scope="当前项目" />
      <div className="page-body test-page-layout">
        <button
          className="button button-secondary"
          type="button"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            setActionError('');
            void requestJson<{ status: string; message: string }>(
              `/api/projects/${projectId}/check-for-test`,
              { method: 'POST', body: '{}' },
            )
              .then((result) => {
                if (result.status === 'failed') setActionError(result.message);
                else setMessage(result.message);
                resource.reload();
              })
              .catch((cause) => setActionError(toUserMessage(cause, '检查待测提交失败')))
              .finally(() => setBusy(false));
          }}
        >
          检查待测提交
        </button>
        <AppMessageFeedback success={message} error={actionError} />
        {data && resource.error && (
          <p className="stale-notice" role="status">
            自动刷新失败，继续显示最后可信状态：{resource.error}
          </p>
        )}
        <AsyncRegion
          loading={resource.loading && !data}
          error={!data ? resource.error : ''}
          onRetry={resource.reload}
        >
          {data?.queue.map((item) => {
            const problem = diagnosePreparation(item);
            return (
              problem && (
                <section
                  className="content-block"
                  key={`preparation-${item.queueId}`}
                  aria-label={`请求 ${item.queueId} 准备详情`}
                >
                  <h2>请求 #{item.queueId} · 尚无测试结论</h2>
                  <p>{problem.message}</p>
                  <p>
                    请求种类：{item.requestKind} · 首次观察：{problem.firstObservedAt ?? '未知'} ·
                    最近观察：{problem.lastObservedAt ?? '未知'}
                  </p>
                  {item.requestKind === 'manual-merge-source' && (
                    <p>
                      此请求涉及来源分支合并；已准备提交 {item.preparedMergeCommit ?? '未记录'}
                      ，已固定 target {item.resolvedTargetCommit ?? '未知'}。请先核对原请求的 Git
                      事实，再决定是否新建合并请求。
                    </p>
                  )}
                  <AppLink to={{ name: 'project-readiness', projectId }}>重新检查项目条件</AppLink>
                  <AppLink to={{ name: 'project-settings', projectId, section: 'environment' }}>
                    查看项目环境配置
                  </AppLink>
                </section>
              )
            );
          })}
          {data &&
            data.queue
              .filter((item) => item.status === 'queued' || item.status === 'running')
              .map((item) => (
                <div key={item.queueId} className="content-block">
                  <p>
                    请求 #{item.queueId} · {item.runId ?? '尚未创建 Run'}
                  </p>
                  <StopRequestButton
                    projectId={projectId}
                    queueId={item.queueId}
                    runId={item.runId}
                    queued={item.status === 'queued'}
                    requested={item.stopRequestedAt}
                    onChanged={resource.reload}
                  />
                </div>
              ))}
          {data && (
            <TestState
              projectId={projectId}
              data={data}
              showIdle={showIdle}
              onShowIdle={() => setShowIdle(true)}
              onRequest={setPendingRequest}
            />
          )}
        </AsyncRegion>
      </div>
      {pendingRequest && data && (
        <ConfirmDialog
          open
          title={pendingRequest.kind === 'merge' ? '确认纳入来源并测试' : '确认发起测试'}
          message={confirmationMessage(data, pendingRequest)}
          confirmLabel="确认进入队列"
          onConfirm={() => void submitRequest()}
          onClose={() => !busy && setPendingRequest(null)}
        />
      )}
    </section>
  );
}

function TestState({
  projectId,
  data,
  showIdle,
  onShowIdle,
  onRequest,
}: {
  projectId: string;
  data: TestPageData;
  showIdle: boolean;
  onShowIdle: () => void;
  onRequest: (request: PendingRequest) => void;
}) {
  const pending = data.queue.find((item) =>
    ['queued', 'running', 'waiting_archive'].includes(item.status),
  );
  const completed = data.runs.find((run) => run.status !== 'running' && run.status !== 'queued');
  if (data.current) {
    const workspaceCurrent =
      data.workspace.activeRuns.find((item) => item.project.projectId === projectId) ?? null;
    return <RunningState projectId={projectId} run={data.current} workspace={workspaceCurrent} />;
  }
  if (pending) {
    const workspaceQueue = data.workspace.queue.find(
      (item) => item.project.projectId === projectId && item.queueId === pending.queueId,
    );
    return (
      <QueuedState
        item={pending}
        position={workspaceQueue?.projectPosition ?? null}
        waitingReason={workspaceQueue?.waitingReason ?? '等待调度'}
      />
    );
  }
  if (completed && !showIdle) {
    return <CompletedState projectId={projectId} run={completed} onStartAnother={onShowIdle} />;
  }
  return <IdleState data={data} onRequest={onRequest} />;
}

function IdleState({
  data,
  onRequest,
}: {
  data: TestPageData;
  onRequest: (request: PendingRequest) => void;
}) {
  const [mode, setMode] = useState<'current' | 'merge'>('current');
  const [request, setRequest] = useState('');
  const [sourceRef, setSourceRef] = useState('');
  const [initialization, setInitialization] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const blockers = readinessBlockers(data);
  const disabled = blockers.length > 0;

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (disabled || !request.trim()) return;
    if (mode === 'merge') {
      if (!sourceRef.trim() || !confirmed) return;
      onRequest({
        kind: 'merge',
        request: request.trim(),
        sourceRef: sourceRef.trim(),
        initialization,
      });
    } else {
      onRequest({ kind: 'current', request: request.trim(), initialization });
    }
  }

  return (
    <div className="test-idle-layout">
      <section className="test-request-panel" aria-labelledby="test-request-title">
        <div className="test-state-heading">
          <span>空闲</span>
          <div>
            <h2 id="test-request-title">发起测试</h2>
          </div>
        </div>
        <div className="request-mode" role="group" aria-label="测试请求类型">
          <button
            type="button"
            aria-pressed={mode === 'current'}
            onClick={() => setMode('current')}
          >
            测试当前场景分支
          </button>
          <button type="button" aria-pressed={mode === 'merge'} onClick={() => setMode('merge')}>
            纳入来源后测试
          </button>
        </div>
        <form className="form-grid" onSubmit={submit}>
          <Field label="测试要求">
            <textarea
              required
              value={request}
              disabled={disabled}
              onChange={(event) => setRequest(event.target.value)}
            />
          </Field>
          {mode === 'merge' && (
            <>
              <Field label="来源 branch、tag 或 commit">
                <input
                  required
                  value={sourceRef}
                  disabled={disabled}
                  onChange={(event) => setSourceRef(event.target.value)}
                />
              </Field>
              <label className="check-control merge-confirmation">
                <input
                  type="checkbox"
                  checked={confirmed}
                  disabled={disabled}
                  onChange={(event) => setConfirmed(event.target.checked)}
                />
                我确认把该来源纳入当前项目场景测试分支后再测试
              </label>
            </>
          )}
          <label className="check-control">
            <input
              type="checkbox"
              checked={initialization}
              disabled={disabled}
              onChange={(event) => setInitialization(event.target.checked)}
            />
            首次初始化测试
          </label>
          <p>
            首次初始化使用各角色模型支持的最高思考等级：深读项目与业务流程 → 侦察实际环境 →
            建立整体场景基线 → 按审批策略验证并审核归档。准备方案中的
            Mock、身份与外联限制会传递到测试；设计、可执行和已通过分别记录。日常测试不重复初始化。
          </p>
          <button
            className="button"
            type="submit"
            disabled={
              disabled || !request.trim() || (mode === 'merge' && (!sourceRef.trim() || !confirmed))
            }
          >
            检查请求
          </button>
        </form>
      </section>
      <TestContext data={data} blockers={blockers} />
    </div>
  );
}

function QueuedState({
  item,
  position,
  waitingReason,
}: {
  item: OperationsQueueItem;
  position: number | null;
  waitingReason: string;
}) {
  const waiting = item.status === 'waiting_archive' ? '等待当前测试完成归档与索引' : waitingReason;
  return (
    <section className="test-focus-state queued-state" aria-labelledby="queued-title">
      <div className="state-kicker">{item.status === 'running' ? '准备目标' : '等待队列'}</div>
      <div
        className="queue-position"
        aria-label={position ? `项目内第 ${position} 位` : '项目内位置读取中'}
      >
        {position ?? '—'}
      </div>
      <div>
        <h2 id="queued-title">
          {item.status === 'running' ? '正在准备测试目标' : '测试请求正在等待'}
        </h2>
        <p>{item.request}</p>
        <dl className="fact-list">
          <Fact label="请求类型" value={requestKindLabel(item.requestKind)} />
          <Fact label="来源" value={item.sourceRef ?? '当前场景分支 HEAD'} mono />
          <Fact label="创建时间" value={formatDate(item.createdAt)} />
          <Fact label="等待原因" value={waiting} />
        </dl>
      </div>
    </section>
  );
}

function RunningState({
  projectId,
  run,
  workspace,
}: {
  projectId: string;
  run: RunSummary;
  workspace: WorkspaceResponse['activeRuns'][number] | null;
}) {
  const stages = stageState(run);
  const activities = (run.activities ?? []).slice(-6).reverse();
  const progress = workspace?.progress ?? run.scenarioProgress ?? null;
  return (
    <>
      <section className="test-focus-state running-state" aria-labelledby="running-title">
        <div className="state-kicker">执行中</div>
        <div>
          <StatusLabel tone="running">{roleLabel(run.phase)}</StatusLabel>
          <h2 id="running-title">{run.request}</h2>
          <p>{workspace?.currentScenario ?? run.currentScenario ?? '正在准备下一项工作'}</p>
        </div>
        <div className="run-counter">
          <strong>{progress ? `${progress.completed}/${progress.total}` : '—'}</strong>
          <span>场景</span>
        </div>
      </section>
      <ol className="run-stages" aria-label="测试执行阶段，可横向滚动" tabIndex={0}>
        {stages.map((stage) => (
          <li className={`stage-${stage.state}`} key={stage.label}>
            <span aria-hidden="true" />
            <strong>{stage.label}</strong>
            <small>{stageStateLabel(stage.state)}</small>
          </li>
        ))}
      </ol>
      <div className="running-grid">
        <section className="content-block" aria-labelledby="running-facts">
          <div className="content-block-heading">
            <h2 id="running-facts">当前事实</h2>
          </div>
          <dl className="fact-list">
            <Fact label="测试记录" value={run.runId} mono />
            <Fact label="固定提交" value={shortSha(run.targetCommit)} mono />
            <Fact label="开始时间" value={formatDate(run.startedAt)} />
            <Fact label="已持续" value={duration(run.startedAt, null)} />
            <Fact
              label="最后更新"
              value={formatDate(workspace?.updatedAt ?? run.updatedAt ?? run.startedAt)}
            />
          </dl>
          <AppLink
            className="text-link"
            to={{ name: 'project-run', projectId, runId: run.runId, tab: 'summary' }}
          >
            查看完整测试记录
          </AppLink>
        </section>
        <section className="content-block" aria-labelledby="running-activity">
          <div className="content-block-heading">
            <h2 id="running-activity">最近活动</h2>
          </div>
          <ActivityList activities={activities} />
          {(run.blockingReasons ?? []).map((reason) => (
            <p className="notice notice-warning" key={reason}>
              {reason}
            </p>
          ))}
        </section>
      </div>
    </>
  );
}

function CompletedState({
  projectId,
  run,
  onStartAnother,
}: {
  projectId: string;
  run: RunSummary;
  onStartAnother: () => void;
}) {
  const label = run.status === 'interrupted' ? '已中断' : resultLabel(run.result);
  const tone = run.result === 'passed' ? 'success' : run.result === 'failed' ? 'danger' : 'warning';
  return (
    <section className="test-focus-state completed-state" aria-labelledby="completed-title">
      <div className="state-kicker">刚刚完成</div>
      <div>
        <StatusLabel tone={tone}>{label}</StatusLabel>
        <h2 id="completed-title">{run.request}</h2>
        <p>{run.errorMessage || `固定提交 ${shortSha(run.targetCommit)} 的测试已经结束。`}</p>
        <div className="page-actions">
          <AppLink
            className="button inline-button"
            to={{ name: 'project-run', projectId, runId: run.runId, tab: 'summary' }}
          >
            查看测试记录
          </AppLink>
          <button className="button button-secondary" type="button" onClick={onStartAnother}>
            发起新测试
          </button>
        </div>
      </div>
      <dl className="completion-facts">
        <Fact label="结论" value={label} />
        <Fact label="完成时间" value={formatDate(run.finishedAt)} />
        <Fact label="耗时" value={duration(run.startedAt, run.finishedAt)} />
      </dl>
    </section>
  );
}

function TestContext({ data, blockers }: { data: TestPageData; blockers: string[] }) {
  return (
    <aside className="test-context" aria-labelledby="test-context-title">
      <h2 id="test-context-title">本次请求上下文</h2>
      <dl className="fact-list">
        <Fact label="项目" value={data.detail.project.displayName} />
        <Fact label="环境" value={data.detail.configuration.baseUrl || '未配置'} />
        <Fact label="场景分支" value={data.detail.configuration.scenarioBranch} mono />
        <Fact label="运行准备" value={readinessLabel(data.readiness?.status ?? 'not_checked')} />
      </dl>
      {blockers.length > 0 && (
        <div className="readiness-blockers">
          <strong>暂时不能提交</strong>
          <ul>
            {blockers.map((blocker) => (
              <li key={blocker}>{blocker}</li>
            ))}
          </ul>
          <AppLink
            className="text-link"
            to={{ name: 'project-readiness', projectId: data.detail.project.projectId }}
          >
            前往运行准备
          </AppLink>
        </div>
      )}
    </aside>
  );
}

function ActivityList({ activities }: { activities: RunActivity[] }) {
  if (!activities.length) return <p className="empty-line">还没有可展示的活动。</p>;
  return (
    <ol className="run-activity-list">
      {activities.map((activity, index) => (
        <li key={`${activity.at}:${activity.code ?? activity.kind}:${index}`}>
          <time dateTime={activity.at}>{formatDate(activity.at)}</time>
          <span>{activity.message}</span>
        </li>
      ))}
    </ol>
  );
}

function stageState(
  run: RunSummary,
): Array<{ label: string; state: 'pending' | 'running' | 'complete' | 'failed' }> {
  const labels = [
    '排队',
    '准备目标',
    'Main · 规划',
    'Runner',
    'Reviewer',
    'Main · 最终汇总',
    '数据清理',
    '归档与索引',
  ];
  const phaseIndex: Record<RunPhase, number> = {
    preparing: 1,
    'main-a': 2,
    runner: 3,
    reviewer: 4,
    'main-b': 5,
    finalizing: cleanupCompleted(run.activities) ? 7 : 6,
    completed: 7,
    failed: 7,
    interrupted: 7,
  };
  const current = phaseIndex[run.phase];
  return labels.map((label, index) => ({
    label,
    state:
      run.status === 'failed' && index === current
        ? 'failed'
        : index < current || run.status === 'completed'
          ? 'complete'
          : index === current
            ? 'running'
            : 'pending',
  }));
}

function cleanupCompleted(activities: RunActivity[] | undefined): boolean {
  return Boolean(activities?.some((activity) => activity.code === 'test_data_cleanup_completed'));
}

function readinessBlockers(data: TestPageData): string[] {
  const blockers: string[] = [];
  if (data.detail.project.status === 'paused') blockers.push('项目已暂停');
  if (data.readiness?.status !== 'ready') {
    const failed = (data.readiness?.checks ?? [])
      .filter((check) => check.status !== 'ok')
      .map((check) => `${check.label}：${check.message}`);
    blockers.push(
      ...(failed.length ? failed : [readinessLabel(data.readiness?.status ?? 'not_checked')]),
    );
  }
  return blockers;
}

function confirmationMessage(data: TestPageData, request: PendingRequest): string {
  const project = data.detail.project;
  const scope = `${project.displayName} · ${project.repositoryOwner}/${project.repositoryName}`;
  return request.kind === 'merge'
    ? `${scope}。确认把 ${request.sourceRef} 纳入 ${data.detail.configuration.scenarioBranch} 后，以固定提交执行测试。`
    : `${scope}。确认测试当前 ${data.detail.configuration.scenarioBranch}，目标提交将在队列处理时固定。`;
}

function Fact({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd className={mono ? 'mono-value' : undefined}>{value}</dd>
    </div>
  );
}

function requestKindLabel(kind: OperationsQueueItem['requestKind']) {
  return {
    'automatic-head': '自动检测',
    'manual-current-head': '当前场景分支',
    'manual-merge-source': '纳入来源后测试',
  }[kind];
}
function roleLabel(phase: RunPhase) {
  return {
    preparing: '准备目标',
    'main-a': 'Main · 规划',
    runner: 'Runner',
    reviewer: 'Reviewer',
    'main-b': 'Main · 最终汇总',
    finalizing: 'Harness 收尾',
    completed: '已完成',
    failed: '执行失败',
    interrupted: '已中断',
  }[phase];
}
function stageStateLabel(state: 'pending' | 'running' | 'complete' | 'failed') {
  return { pending: '未开始', running: '进行中', complete: '已完成', failed: '失败' }[state];
}
function readinessLabel(status: ConsoleReadinessSnapshot['status']) {
  return {
    ready: '已就绪',
    not_ready: '未就绪',
    stale: '需要重检',
    not_checked: '尚未检查',
    error: '检查异常',
  }[status];
}
function resultLabel(result: RunSummary['result']) {
  return result ? { passed: '通过', failed: '失败', blocked: '阻塞' }[result] : '无结论';
}
function shortSha(value: string | null) {
  return value ? value.slice(0, 12) : '尚未固定';
}
function formatDate(value: string | null | undefined) {
  return value ? new Date(value).toLocaleString('zh-CN') : '尚无';
}
function duration(start: string, end: string | null) {
  const milliseconds = Math.max(
    0,
    new Date(end ?? Date.now()).getTime() - new Date(start).getTime(),
  );
  const seconds = Math.floor(milliseconds / 1000);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return hours
    ? `${hours} 小时 ${minutes} 分`
    : minutes
      ? `${minutes} 分 ${seconds % 60} 秒`
      : `${seconds} 秒`;
}
