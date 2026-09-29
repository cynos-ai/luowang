import { useCallback, useState } from 'react';

import type {
  SystemDependencyStatus,
  SystemResourcesResponse,
  SystemStatusResponse,
} from '../../shared/types';
import { requestJson, toUserMessage } from '../api';
import { AppLink } from '../app/navigation';
import { useResource } from '../app/resource';
import { AsyncRegion } from '../components/AsyncRegion';
import { PageHeading } from '../components/PageHeading';
import { StatusLabel } from '../components/StatusLabel';

export function SystemStatusPage() {
  const loadStatus = useCallback(
    (signal: AbortSignal) => requestJson<SystemStatusResponse>('/api/system/status', { signal }),
    [],
  );
  const loadResources = useCallback(
    (signal: AbortSignal) =>
      requestJson<SystemResourcesResponse>('/api/system/resources', { signal }),
    [],
  );
  const status = useResource('system-status', loadStatus, (cause) =>
    toUserMessage(cause, '系统状态读取失败'),
  );
  const resources = useResource('system-resources', loadResources, (cause) =>
    toUserMessage(cause, '执行资源盘点失败'),
  );
  const [checking, setChecking] = useState('');
  const [checkError, setCheckError] = useState('');

  async function runCheck(id: SystemDependencyStatus['id']) {
    setChecking(id);
    setCheckError('');
    try {
      await requestJson(`/api/system/checks/${id}`, { method: 'POST' });
      status.reload();
    } catch (cause) {
      setCheckError(toUserMessage(cause, '共享依赖检查失败'));
    } finally {
      setChecking('');
    }
  }

  return (
    <section className="page-content system-status-page">
      <PageHeading title="系统状态" scope="全局 · 只读诊断" />
      <div className="page-body system-status-layout">
        {checkError && (
          <p className="notice notice-error" role="alert">
            {checkError}
          </p>
        )}
        <AsyncRegion
          loading={status.loading && !status.value}
          error={!status.value ? status.error : ''}
          onRetry={status.reload}
        >
          {status.value && (
            <>
              <section className="system-service-strip" aria-label="核心服务">
                <SystemFact
                  label="版本"
                  value={`${status.value.service.version}${status.value.service.build ? ` · ${status.value.service.build}` : ''}`}
                  ok
                />
                <SystemFact
                  label="数据库"
                  value={status.value.database === 'ok' ? '正常' : '异常'}
                  ok={status.value.database === 'ok'}
                />
                <SystemFact
                  label="Secret Store"
                  value={status.value.secretStore === 'available' ? '可用' : '不可用'}
                  ok={status.value.secretStore === 'available'}
                />
                <SystemFact
                  label="调度器"
                  value={status.value.scheduler.running ? '运行中' : '未运行'}
                  ok={status.value.scheduler.running}
                />
              </section>
              <section className="content-block">
                <div className="content-block-heading">
                  <h2>共享依赖</h2>
                  <p>状态来自最近快照；只有点击检查才会执行外部连接。</p>
                </div>
                <div className="dependency-list">
                  {status.value.dependencies.map((dependency) => (
                    <article key={dependency.id} className="dependency-row">
                      <div>
                        <h3>{dependency.label}</h3>
                        <p>{dependency.message}</p>
                        <small>
                          检查：{formatDate(dependency.checkedAt)} · 最近成功：
                          {formatDate(dependency.lastSucceededAt)}
                        </small>
                      </div>
                      <StatusLabel tone={dependencyTone(dependency.status)}>
                        {dependencyLabel(dependency.status)}
                      </StatusLabel>
                      <div className="inline-actions">
                        <AppLink
                          className="text-link"
                          to={{ name: 'global-settings', section: dependency.settingsSection }}
                        >
                          设置
                        </AppLink>
                        <button
                          className="button button-small"
                          type="button"
                          disabled={Boolean(checking)}
                          onClick={() => void runCheck(dependency.id)}
                        >
                          {checking === dependency.id ? '检查中…' : '立即检查'}
                        </button>
                      </div>
                    </article>
                  ))}
                </div>
              </section>
              <section className="content-block">
                <div className="content-block-heading">
                  <h2>恢复信息</h2>
                </div>
                <p>
                  {status.value.recovery.available
                    ? '恢复说明可用：multi-project-recovery。'
                    : '当前没有恢复说明。'}
                </p>
                <p className="muted-copy">系统未持久化恢复演练历史，因此不展示“最近演练”。</p>
              </section>
            </>
          )}
        </AsyncRegion>
        <section className="content-block">
          <div className="content-block-heading">
            <h2>执行资源盘点</h2>
            <p>只读盘点，不提供删除操作；候选体积不等于 Docker 实际可回收空间。</p>
          </div>
          <AsyncRegion
            loading={resources.loading && !resources.value}
            error={!resources.value ? resources.error : ''}
            onRetry={resources.reload}
          >
            {resources.value && (
              <div className="resource-inventory">
                <dl className="fact-list">
                  <Fact label="实例" value={resources.value.instanceId} />
                  <Fact label="已确认项目" value={String(resources.value.projects.length)} />
                  <Fact label="项目容器" value={String(resources.value.containers.length)} />
                  <Fact
                    label="候选镜像体积"
                    value={formatBytes(resources.value.candidateImageBytes)}
                  />
                </dl>
                <div className="record-table-wrap">
                  <table className="record-table">
                    <thead>
                      <tr>
                        <th>镜像</th>
                        <th>项目</th>
                        <th>大小</th>
                        <th>盘点结论</th>
                      </tr>
                    </thead>
                    <tbody>
                      {resources.value.images.map((image) => (
                        <tr key={image.imageId}>
                          <td>
                            <code>{image.imageId}</code>
                          </td>
                          <td>
                            <code>{image.projectId}</code>
                          </td>
                          <td>
                            {image.sizeBytes === null ? '未知' : formatBytes(image.sizeBytes)}
                          </td>
                          <td>{dispositionLabel(image.disposition)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {resources.value.images.length === 0 && (
                    <p className="empty-line">没有可确认归属的项目镜像。</p>
                  )}
                </div>
              </div>
            )}
          </AsyncRegion>
        </section>
      </div>
    </section>
  );
}

function SystemFact({ label, value, ok }: { label: string; value: string; ok: boolean }) {
  return (
    <div>
      <span>{label}</span>
      <strong>{value}</strong>
      <StatusLabel tone={ok ? 'success' : 'danger'}>{ok ? '正常' : '需处理'}</StatusLabel>
    </div>
  );
}
function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}
function dependencyTone(status: SystemDependencyStatus['status']) {
  return status === 'ok' ? 'success' : status === 'unavailable' ? 'danger' : 'warning';
}
function dependencyLabel(status: SystemDependencyStatus['status']) {
  return {
    ok: '正常',
    degraded: '异常',
    unavailable: '不可用',
    not_configured: '未配置',
    unknown: '未知',
    not_checked: '未检查',
  }[status];
}
function dispositionLabel(value: SystemResourcesResponse['images'][number]['disposition']) {
  return {
    referenced: '正在引用',
    'restart-candidate': '重启后候选',
    'manual-review': '需要人工复核',
  }[value];
}
function formatDate(value: string | null) {
  return value ? new Date(value).toLocaleString('zh-CN') : '无真实记录';
}
function formatBytes(value: number) {
  if (value < 1024) return `${value} B`;
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KiB`;
  return `${(value / 1024 ** 2).toFixed(1)} MiB`;
}
