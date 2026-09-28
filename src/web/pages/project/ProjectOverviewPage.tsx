import { useCallback } from 'react';

import type { ConsoleReadinessSnapshot, IndexedScenario, RunSummary } from '../../../shared/types';
import { requestJson, toUserMessage } from '../../api';
import { AppLink } from '../../app/navigation';
import { useResource } from '../../app/resource';
import { AsyncRegion } from '../../components/AsyncRegion';
import { PageHeading } from '../../components/PageHeading';
import { StatusLabel } from '../../components/StatusLabel';
import type { ProjectDetailResponse } from '../../project-types';

type IndexState = {
  commitSha: string | null;
  syncedAt: string | null;
  errors: Array<{ path: string; message: string }>;
};

type OverviewData = {
  detail: ProjectDetailResponse;
  readiness: ConsoleReadinessSnapshot;
  index: IndexState;
  runs: RunSummary[];
  queue: Array<{ status: string; request: string; createdAt: string; runId: string | null }>;
  scenarios: IndexedScenario[];
};

export function ProjectOverviewPage({ projectId }: { projectId: string }) {
  const load = useCallback(
    async (signal: AbortSignal): Promise<OverviewData> => {
      const [detail, readiness, index, runs, queue, scenarios] = await Promise.all([
        requestJson<ProjectDetailResponse>(`/api/projects/${projectId}`, { signal }),
        requestJson<{ readiness: ConsoleReadinessSnapshot }>(
          `/api/projects/${projectId}/readiness/status`,
          { signal },
        ),
        requestJson<{ index: IndexState }>(`/api/projects/${projectId}/index`, { signal }),
        requestJson<{ runs: RunSummary[] }>(`/api/projects/${projectId}/runs`, { signal }),
        requestJson<{ queue: OverviewData['queue'] }>(`/api/projects/${projectId}/queue`, {
          signal,
        }),
        requestJson<{ scenarios: IndexedScenario[] }>(`/api/projects/${projectId}/scenarios`, {
          signal,
        }),
      ]);
      return {
        detail,
        readiness: readiness.readiness,
        index: index.index,
        runs: runs.runs,
        queue: queue.queue,
        scenarios: scenarios.scenarios,
      };
    },
    [projectId],
  );
  const resource = useResource(`project-overview:${projectId}`, load, (cause) =>
    toUserMessage(cause, '项目概览读取失败'),
  );
  const data = resource.value;

  return (
    <section className="page-content project-overview-page">
      <PageHeading title="项目概览" scope="当前项目" description="当前判断和下一步。" />
      <div className="page-body">
        <AsyncRegion
          loading={resource.loading && !data}
          error={!data ? resource.error : ''}
          onRetry={resource.reload}
        >
          {data && <OverviewContent projectId={projectId} data={data} />}
        </AsyncRegion>
      </div>
    </section>
  );
}

function OverviewContent({ projectId, data }: { projectId: string; data: OverviewData }) {
  const active = data.runs.find((run) => run.status === 'running');
  const pending = data.queue.find((item) =>
    ['queued', 'running', 'waiting_archive'].includes(item.status),
  );
  const latest = data.runs.find((run) => run.status !== 'running') ?? null;
  const action = recommendedAction(projectId, data.readiness, active, latest);

  return (
    <>
      <section className="overview-hero" aria-labelledby="overview-next-action">
        <div>
          <span className="scope-label">下一步</span>
          <h2 id="overview-next-action">{action.title}</h2>
          <p>{action.detail}</p>
        </div>
        <AppLink className="button inline-button" to={action.to}>
          {action.label}
        </AppLink>
      </section>
      <div className="overview-grid">
        <section className="content-block" aria-labelledby="overview-status">
          <div className="content-block-heading">
            <h2 id="overview-status">项目状态</h2>
            <StatusLabel tone={data.detail.project.status === 'active' ? 'success' : 'warning'}>
              {data.detail.project.status === 'active' ? '可运行' : '已暂停'}
            </StatusLabel>
          </div>
          <dl className="fact-list">
            <Fact
              label="仓库"
              value={`${data.detail.project.repositoryOwner}/${data.detail.project.repositoryName}`}
            />
            <Fact label="运行准备" value={readinessLabel(data.readiness.status)} />
            <Fact label="配置修订" value={`#${data.detail.project.configRevision}`} />
            <Fact label="排队请求" value={pending ? pending.request : '无'} />
          </dl>
        </section>
        <section className="content-block" aria-labelledby="overview-run">
          <div className="content-block-heading">
            <h2 id="overview-run">当前或最近测试</h2>
          </div>
          {active || latest ? (
            <RunSummaryView projectId={projectId} run={active ?? latest!} />
          ) : (
            <p className="empty-line">还没有测试记录。</p>
          )}
        </section>
        <section className="content-block" aria-labelledby="overview-assets">
          <div className="content-block-heading">
            <h2 id="overview-assets">场景与同步</h2>
          </div>
          <dl className="fact-list">
            <Fact label="场景" value={`${data.scenarios.length} 个`} />
            <Fact label="固定索引提交" value={shortSha(data.index.commitSha)} mono />
            <Fact label="最近同步" value={formatDate(data.index.syncedAt)} />
            <Fact
              label="索引状态"
              value={data.index.errors.length ? `${data.index.errors.length} 个错误` : '正常'}
            />
          </dl>
        </section>
        <section className="content-block" aria-labelledby="overview-activity">
          <div className="content-block-heading">
            <h2 id="overview-activity">最近活动</h2>
          </div>
          <ul className="activity-list">
            {data.runs.slice(0, 4).map((run) => (
              <li key={run.runId}>
                <AppLink
                  className="text-link"
                  to={{ name: 'project-run', projectId, runId: run.runId, tab: 'summary' }}
                >
                  {run.runId}
                </AppLink>
                <span>{runResultLabel(run)}</span>
                <small>{formatDate(run.finishedAt ?? run.startedAt)}</small>
              </li>
            ))}
            {data.runs.length === 0 && <li>暂无持久活动。</li>}
          </ul>
        </section>
      </div>
    </>
  );
}

function recommendedAction(
  projectId: string,
  readiness: ConsoleReadinessSnapshot,
  active: RunSummary | undefined,
  latest: RunSummary | null,
) {
  if (active) {
    return {
      title: '测试正在执行',
      detail: `当前阶段：${phaseLabel(active.phase)}。`,
      label: '查看当前执行',
      to: { name: 'project-test' as const, projectId },
    };
  }
  if (latest?.result === 'blocked') {
    return {
      title: '处理最近一次阻塞',
      detail: latest.errorMessage || '最近测试未能形成可接受结论。',
      label: '处理问题',
      to: { name: 'project-run' as const, projectId, runId: latest.runId, tab: 'summary' as const },
    };
  }
  if (readiness.status !== 'ready') {
    return {
      title: '完成运行准备',
      detail: readiness.staleReason || '项目尚未通过完整运行准备检查。',
      label: '完成运行准备',
      to: { name: 'project-readiness' as const, projectId },
    };
  }
  return {
    title: '项目可以测试',
    detail: '进入测试页确认请求内容后发起测试。',
    label: '发起测试',
    to: { name: 'project-test' as const, projectId },
  };
}

function RunSummaryView({ projectId, run }: { projectId: string; run: RunSummary }) {
  return (
    <div className="overview-run-summary">
      <StatusLabel
        tone={
          run.status === 'running' ? 'running' : run.result === 'passed' ? 'success' : 'warning'
        }
      >
        {runResultLabel(run)}
      </StatusLabel>
      <strong>{run.runId}</strong>
      <p>{run.request}</p>
      <small>
        {shortSha(run.targetCommit)} · {formatDate(run.finishedAt ?? run.startedAt)}
      </small>
      <AppLink
        className="text-link"
        to={{ name: 'project-run', projectId, runId: run.runId, tab: 'summary' }}
      >
        查看测试记录
      </AppLink>
    </div>
  );
}

function Fact({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd className={mono ? 'mono-value' : undefined}>{value}</dd>
    </div>
  );
}

function readinessLabel(status: ConsoleReadinessSnapshot['status']): string {
  return {
    ready: '已就绪',
    not_ready: '未就绪',
    stale: '需要重检',
    not_checked: '尚未检查',
    error: '检查异常',
  }[status];
}

function runResultLabel(run: RunSummary): string {
  if (run.status === 'running') return '执行中';
  if (run.status === 'interrupted') return '已中断';
  return { passed: '通过', failed: '失败', blocked: '阻塞' }[run.result ?? 'blocked'];
}

function phaseLabel(phase: RunSummary['phase']): string {
  return {
    preparing: '准备目标',
    'main-a': 'Main · 规划',
    runner: 'Runner',
    reviewer: 'Reviewer',
    'main-b': 'Main · 最终汇总',
    finalizing: '归档与索引',
    completed: '已完成',
    failed: '失败',
    interrupted: '已中断',
  }[phase];
}

function shortSha(value: string | null): string {
  return value ? value.slice(0, 12) : '尚无';
}

function formatDate(value: string | null): string {
  return value ? new Date(value).toLocaleString('zh-CN') : '尚无';
}
