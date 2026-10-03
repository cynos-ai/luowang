import { useCallback, useEffect } from 'react';

import type { ConsoleTarget, WorkspaceProjectSummary, WorkspaceResponse } from '../../shared/types';
import { requestJson, toUserMessage } from '../api';
import { useResource } from '../app/resource';
import type { NavigableRoute } from '../app/navigation';
import { AppLink } from '../app/navigation';
import { AsyncRegion } from '../components/AsyncRegion';
import { PageHeading } from '../components/PageHeading';
import { StatusLabel } from '../components/StatusLabel';
import { RunTelemetryPanel } from '../components/RunTelemetryPanel';

const workspaceError = (cause: unknown) => toUserMessage(cause, '工作台读取失败');

export function WorkspacePage() {
  const load = useCallback(
    (signal: AbortSignal) => requestJson<WorkspaceResponse>('/api/workspace', { signal }),
    [],
  );
  const resource = useResource('workspace', load, workspaceError);
  useEffect(() => {
    const timer = window.setInterval(resource.reload, 5000);
    return () => window.clearInterval(timer);
  }, [resource.reload]);
  const value = resource.value;
  return (
    <section className="page-content workspace-page">
      <PageHeading title="工作台" scope="全局" />
      <AsyncRegion
        loading={resource.loading && !value}
        error={!value ? resource.error : ''}
        onRetry={resource.reload}
      >
        {value && (
          <div className="workspace-layout">
            {resource.error && <p className="app-banner">刷新失败，保留上次可信数据。</p>}
            <AttentionList workspace={value} />
            <ActiveRun workspace={value} />
            <QueueList workspace={value} />
            <ProjectStatus projects={value.projects} />
            <RecentRuns workspace={value} />
          </div>
        )}
      </AsyncRegion>
    </section>
  );
}

function AttentionList({ workspace }: { workspace: WorkspaceResponse }) {
  return (
    <section className="content-block attention-block" aria-labelledby="attention-title">
      <div className="content-block-heading">
        <h2 id="attention-title">需要处理</h2>
        <strong>{workspace.attention.length}</strong>
      </div>
      {workspace.attention.length === 0 ? (
        <p className="empty-line">当前没有需要人工处理的事项。</p>
      ) : (
        <ul className="action-list">
          {workspace.attention.map((item) => (
            <li key={item.id}>
              <StatusLabel tone={item.severity === 'error' ? 'danger' : 'warning'}>
                {item.severity === 'error' ? '错误' : '注意'}
              </StatusLabel>
              <div>
                <strong>{item.title}</strong>
                <p>{item.detail}</p>
                {item.diagnostic && (
                  <p>
                    来源：
                    {
                      {
                        harness: '系统记录',
                        reviewer: 'Reviewer 审核',
                        administrator: '管理员操作',
                        'historical-unknown': '历史记录，具体分类未知',
                      }[item.diagnostic.source]
                    }
                    {' · '}首次：{item.diagnostic.firstObservedAt ?? '未知'}
                    {' · '}最近：{item.diagnostic.lastObservedAt ?? '未知'}
                  </p>
                )}
              </div>
              <AppLink className="text-link" to={targetRoute(item.target)}>
                查看
              </AppLink>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function ActiveRun({ workspace }: { workspace: WorkspaceResponse }) {
  return (
    <section className="content-block active-run-block" aria-labelledby="active-run-title">
      <div className="content-block-heading">
        <h2 id="active-run-title">当前执行</h2>
        <StatusLabel tone={workspace.capacity.occupied ? 'running' : 'neutral'}>
          {workspace.capacity.occupied}/{workspace.capacity.limit} 个项目正在处理
        </StatusLabel>
      </div>
      {workspace.activeRuns.length === 0 ? (
        <p className="empty-line">当前没有正在执行的测试。</p>
      ) : (
        workspace.activeRuns.map((active) => (
          <div className="run-focus" key={active.queueId}>
            <div>
              <AppLink
                className="object-link"
                to={
                  active.runId
                    ? {
                        name: 'project-run',
                        projectId: active.project.projectId,
                        runId: active.runId,
                        tab: 'summary',
                      }
                    : { name: 'project-test', projectId: active.project.projectId }
                }
              >
                {active.project.displayName} · {active.runId ?? '准备目标'}
              </AppLink>
              <p>{active.stage}</p>
              <RunTelemetryPanel
                compact
                telemetry={active.telemetry}
                active={true}
                stageStartedAt={active.stageStartedAt}
                lastActivityAt={active.lastActivityAt}
                fetchedAt={workspace.fetchedAt}
              />
            </div>
            <strong>
              {active.progress ? `${active.progress.completed}/${active.progress.total}` : '—'}
            </strong>
            <small>{formatDate(active.updatedAt)}</small>
          </div>
        ))
      )}
    </section>
  );
}

function QueueList({ workspace }: { workspace: WorkspaceResponse }) {
  return (
    <section className="content-block" aria-labelledby="queue-title">
      <div className="content-block-heading">
        <h2 id="queue-title">队列</h2>
        <span>项目内顺序执行</span>
      </div>
      {workspace.queue.length === 0 ? (
        <p className="empty-line">队列为空。</p>
      ) : (
        <ol className="queue-list">
          {workspace.queue.map((item) => (
            <li key={item.requestId}>
              <strong>项目内 {item.projectPosition}</strong>
              <AppLink
                className="text-link"
                to={{ name: 'project-test', projectId: item.project.projectId }}
              >
                {item.project.displayName}
              </AppLink>
              <span>
                {item.request}
                <small>{item.waitingReason}</small>
              </span>
              <small>{formatDate(item.createdAt)}</small>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function ProjectStatus({ projects }: { projects: WorkspaceProjectSummary[] }) {
  return (
    <section className="content-block project-status-block" aria-labelledby="project-status-title">
      <div className="content-block-heading">
        <h2 id="project-status-title">项目状态</h2>
        <AppLink className="text-link" to={{ name: 'projects' }}>
          全部项目
        </AppLink>
      </div>
      {projects.length === 0 ? (
        <div className="empty-callout">
          <strong>还没有项目</strong>
          <ol>
            <li>连接 GitHub 仓库</li>
            <li>配置非生产测试环境</li>
            <li>检查并明确启用项目</li>
          </ol>
          <AppLink className="button inline-button" to={{ name: 'project-new' }}>
            接入项目
          </AppLink>
        </div>
      ) : (
        <ul className="project-summary-list">
          {projects.map((summary) => (
            <li key={summary.project.projectId}>
              <div>
                <AppLink
                  className="object-link"
                  to={{ name: 'project-overview', projectId: summary.project.projectId }}
                >
                  {summary.project.displayName}
                </AppLink>
                <small>
                  {summary.project.repositoryOwner}/{summary.project.repositoryName}
                </small>
              </div>
              <StatusLabel tone={activityTone(summary.activity)}>
                {activityLabel(summary.activity)}
              </StatusLabel>
              <span>{readinessLabel(summary.readiness.status)}</span>
              <strong>
                {summary.attentionCount > 0 ? `${summary.attentionCount} 项待处理` : '无待处理'}
              </strong>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function RecentRuns({ workspace }: { workspace: WorkspaceResponse }) {
  return (
    <section className="content-block" aria-labelledby="recent-title">
      <div className="content-block-heading">
        <h2 id="recent-title">最近完成</h2>
      </div>
      {workspace.recentRuns.length === 0 ? (
        <p className="empty-line">还没有完成的测试。</p>
      ) : (
        <ul className="recent-list">
          {workspace.recentRuns.map((run) => (
            <li key={`${run.project.projectId}:${run.runId}`}>
              <AppLink
                className="object-link"
                to={{
                  name: 'project-run',
                  projectId: run.project.projectId,
                  runId: run.runId,
                  tab: 'summary',
                }}
              >
                {run.project.displayName} · {run.runId}
              </AppLink>
              <StatusLabel tone={resultTone(run.result)}>{run.result ?? run.status}</StatusLabel>
              <small>{formatDate(run.finishedAt ?? run.startedAt)}</small>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function targetRoute(target: ConsoleTarget): NavigableRoute {
  switch (target.kind) {
    case 'project-overview':
      return { name: 'project-overview', projectId: target.projectId };
    case 'project-readiness':
      return { name: 'project-readiness', projectId: target.projectId };
    case 'run':
      return {
        name: 'project-run',
        projectId: target.projectId,
        runId: target.runId,
        tab: 'summary',
      };
    case 'scenario':
      return {
        name: 'project-scenario',
        projectId: target.projectId,
        scenarioId: target.scenarioId,
      };
    case 'system':
      return { name: 'system' };
  }
}

function activityTone(activity: WorkspaceProjectSummary['activity']) {
  if (activity === 'running') return 'running' as const;
  if (activity === 'paused') return 'warning' as const;
  return 'neutral' as const;
}

function activityLabel(activity: WorkspaceProjectSummary['activity']): string {
  return { running: '运行中', queued: '排队中', idle: '空闲', paused: '已暂停' }[activity];
}

function readinessLabel(status: WorkspaceProjectSummary['readiness']['status']): string {
  return {
    ready: '准备完成',
    not_ready: '尚未就绪',
    stale: '需要重检',
    not_checked: '尚未检查',
    error: '检查异常',
  }[status];
}

function resultTone(result: string | null) {
  if (result === 'passed') return 'success' as const;
  if (result === 'failed' || result === 'blocked') return 'danger' as const;
  if (result === 'interrupted') return 'warning' as const;
  return 'neutral' as const;
}

function formatDate(value: string): string {
  return new Date(value).toLocaleString('zh-CN');
}
