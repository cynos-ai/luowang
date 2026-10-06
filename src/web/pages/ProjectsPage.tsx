import { useCallback, useMemo, useState } from 'react';

import type { WorkspaceProjectSummary, WorkspaceResponse } from '../../shared/types';
import { requestJson, toUserMessage } from '../api';
import { AppLink } from '../app/navigation';
import { useResource } from '../app/resource';
import { AsyncRegion } from '../components/AsyncRegion';
import { AppMessageFeedback } from '../components/AppMessageProvider';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { PageHeading } from '../components/PageHeading';
import { StatusLabel } from '../components/StatusLabel';

const projectsError = (cause: unknown) => toUserMessage(cause, '项目列表读取失败');

export function ProjectsPage({ onProjectsChanged }: { onProjectsChanged: () => Promise<void> }) {
  const load = useCallback(
    (signal: AbortSignal) => requestJson<WorkspaceResponse>('/api/workspace', { signal }),
    [],
  );
  const resource = useResource('projects', load, projectsError);
  const [filter, setFilter] = useState<'all' | 'attention' | 'active' | 'paused'>('all');
  const [confirmation, setConfirmation] = useState<WorkspaceProjectSummary | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState('');
  const [actionMessage, setActionMessage] = useState('');
  const projects = useMemo(() => {
    const values = [...(resource.value?.projects ?? [])].sort(
      (left, right) =>
        Number(right.activity === 'running') - Number(left.activity === 'running') ||
        right.attentionCount - left.attentionCount ||
        left.project.displayName.localeCompare(right.project.displayName, 'zh-CN'),
    );
    return values.filter((summary) => {
      if (filter === 'attention') return summary.attentionCount > 0;
      if (filter === 'active') return summary.project.status === 'active';
      if (filter === 'paused') return summary.project.status === 'paused';
      return true;
    });
  }, [filter, resource.value]);

  async function changeStatus() {
    if (!confirmation) return;
    setBusy(true);
    setActionError('');
    setActionMessage('');
    try {
      const operation = confirmation.project.status === 'active' ? 'pause' : 'resume';
      await requestJson(`/api/projects/${confirmation.project.projectId}/${operation}`, {
        method: 'POST',
      });
      setConfirmation(null);
      await Promise.all([onProjectsChanged(), Promise.resolve(resource.reload())]);
      setActionMessage(confirmation.project.status === 'active' ? '项目已暂停' : '项目已启用');
    } catch (cause) {
      setActionError(toUserMessage(cause, '项目状态更新失败'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="page-content projects-page">
      <PageHeading
        title="项目"
        scope="全局"
        actions={
          <AppLink className="button inline-button" to={{ name: 'project-new' }}>
            接入项目
          </AppLink>
        }
      />
      <div className="page-body">
        <div className="filter-bar" role="group" aria-label="筛选项目">
          {(
            [
              ['all', '全部'],
              ['attention', '需要处理'],
              ['active', '已启用'],
              ['paused', '已暂停'],
            ] as const
          ).map(([value, label]) => (
            <button
              type="button"
              key={value}
              className="filter-button"
              aria-pressed={filter === value}
              onClick={() => setFilter(value)}
            >
              {label}
            </button>
          ))}
        </div>
        <AppMessageFeedback success={actionMessage} error={actionError} />
        <AsyncRegion
          loading={resource.loading && !resource.value}
          error={!resource.value ? resource.error : ''}
          onRetry={resource.reload}
        >
          {resource.value?.projects.length === 0 && (
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
          )}
          {resource.value && resource.value.projects.length > 0 && (
            <ul className="project-directory">
              {projects.map((summary) => (
                <li key={summary.project.projectId}>
                  <div className="project-directory-main">
                    <AppLink
                      className="object-link"
                      to={{ name: 'project-overview', projectId: summary.project.projectId }}
                    >
                      {summary.project.displayName}
                    </AppLink>
                    <code>
                      {summary.project.repositoryOwner}/{summary.project.repositoryName}
                    </code>
                  </div>
                  <StatusLabel tone={summary.project.status === 'active' ? 'success' : 'warning'}>
                    {summary.project.status === 'active' ? '已启用' : '已暂停'}
                  </StatusLabel>
                  <span>{readinessLabel(summary.readiness.status)}</span>
                  <span>{summary.attentionCount} 项待处理</span>
                  <div className="project-actions">
                    <AppLink
                      className="project-action project-action-primary"
                      to={{ name: 'project-overview', projectId: summary.project.projectId }}
                    >
                      打开
                    </AppLink>
                    <AppLink
                      className="project-action"
                      to={{
                        name: 'project-settings',
                        projectId: summary.project.projectId,
                        section: 'general',
                      }}
                    >
                      重新配置
                    </AppLink>
                    <button
                      className="project-action project-action-state"
                      type="button"
                      onClick={() => setConfirmation(summary)}
                    >
                      {summary.project.status === 'active' ? '暂停' : '启用'}
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </AsyncRegion>
      </div>
      <ConfirmDialog
        open={Boolean(confirmation)}
        title={confirmation?.project.status === 'active' ? '暂停新测试' : '启用项目'}
        message={
          confirmation?.project.status === 'active'
            ? '暂停只阻止新测试；已经运行和等待归档的工作会继续。'
            : '罗网会重新检查运行条件；未就绪时不会启用。'
        }
        confirmLabel={
          busy ? '处理中…' : confirmation?.project.status === 'active' ? '确认暂停' : '检查并启用'
        }
        danger={confirmation?.project.status === 'active'}
        onClose={() => !busy && setConfirmation(null)}
        onConfirm={() => void changeStatus()}
      />
    </section>
  );
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
