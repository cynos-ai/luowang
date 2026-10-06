import { useCallback, useEffect, useState } from 'react';

import type {
  EvidenceReference,
  IndexedReport,
  OperationsRunDetail,
  OperationsQueueItem,
} from '../../../shared/types';
import { screenshotInspectionLabel } from '../../../shared/types';
import { requestJson, toUserMessage } from '../../api';
import { AppLink } from '../../app/navigation';
import type { RunDetailTab } from '../../app/route';
import { runDetailTabs } from '../../app/route';
import { useResource } from '../../app/resource';
import { AsyncRegion } from '../../components/AsyncRegion';
import { MarkdownView } from '../../components/MarkdownView';
import { PageHeading } from '../../components/PageHeading';
import { StatusLabel } from '../../components/StatusLabel';
import { StopRequestButton } from '../../components/StopRequestButton';
import { RunFollowupActions } from '../../components/RunFollowupActions';
import { RunTelemetryPanel } from '../../components/RunTelemetryPanel';

const tabLabels: Record<RunDetailTab, string> = {
  summary: '摘要',
  scenarios: '场景结果',
  review: '审核',
  report: '正式报告',
  evidence: '证据',
  technical: '技术信息',
};

type RunPageData = {
  run: OperationsRunDetail;
  report: IndexedReport | null;
  queue: OperationsQueueItem | null;
  source: { runId: string; targetCommit: string | null; configRevision: number | null } | null;
  followups: OperationsQueueItem[];
};

export function ProjectRunPage({
  projectId,
  runId,
  tab,
}: {
  projectId: string;
  runId: string;
  tab: RunDetailTab;
}) {
  const load = useCallback(
    async (signal: AbortSignal): Promise<RunPageData> => {
      const run = await requestJson<{
        run: OperationsRunDetail;
        queue?: OperationsQueueItem | null;
        source?: RunPageData['source'];
        followups?: OperationsQueueItem[];
      }>(`/api/projects/${projectId}/runs/${encodeURIComponent(runId)}`, { signal });
      let report: IndexedReport | null = null;
      try {
        report = (
          await requestJson<{ report: IndexedReport }>(
            `/api/projects/${projectId}/reports/${encodeURIComponent(runId)}`,
            { signal },
          )
        ).report;
      } catch (cause) {
        if (signal.aborted) throw cause;
      }
      return {
        run: run.run,
        report,
        queue: run.queue ?? null,
        source: run.source ?? null,
        followups: run.followups ?? [],
      };
    },
    [projectId, runId],
  );
  const resource = useResource(`project-run:${projectId}:${runId}`, load, (cause) =>
    toUserMessage(cause, '测试记录读取失败'),
  );
  const data = resource.value;
  const active = data?.queue?.status === 'running' || data?.queue?.status === 'queued';
  const refreshing =
    active ||
    data?.queue?.status === 'waiting_archive' ||
    data?.followups.some((item) => ['queued', 'running', 'waiting_archive'].includes(item.status));
  useEffect(() => {
    if (!refreshing) return;
    const timer = setInterval(resource.reload, 3000);
    return () => clearInterval(timer);
  }, [refreshing, resource.reload]);
  return (
    <section className="page-content run-detail-page">
      <PageHeading title={`测试 ${shortId(runId)}`} scope="当前项目 · 测试记录" />
      {data?.queue && active && (
        <StopRequestButton
          projectId={projectId}
          queueId={data.queue.queueId}
          runId={runId}
          queued={data.queue.status === 'queued'}
          requested={data.queue.stopRequestedAt}
          onChanged={resource.reload}
        />
      )}
      {data && resource.error && <p role="alert">刷新失败，以下为上次读取记录：{resource.error}</p>}
      <div className="page-body run-detail-layout">
        <nav className="detail-tabs" aria-label="测试记录详情">
          {runDetailTabs.map((key) => (
            <AppLink
              key={key}
              to={{ name: 'project-run', projectId, runId, tab: key }}
              current={tab === key}
            >
              {tabLabels[key]}
            </AppLink>
          ))}
        </nav>
        <AsyncRegion
          loading={resource.loading && !data}
          error={!data ? resource.error : ''}
          onRetry={resource.reload}
        >
          {data && (
            <>
              {tab === 'summary' && (
                <>
                  <RunTelemetryPanel
                    telemetry={data.run.telemetry}
                    active={data.run.status === 'running' || data.run.status === 'queued'}
                    lastActivityAt={data.run.activities?.at(-1)?.at ?? data.run.updatedAt}
                    fetchedAt={resource.fetchedAt}
                  />
                  <RunFollowupActions
                    projectId={projectId}
                    run={data.run}
                    queue={data.queue}
                    onChanged={resource.reload}
                  />
                  {(data.source || data.followups.length > 0) && (
                    <section className="content-block" aria-label="关联测试">
                      <h2>关联测试</h2>
                      {data.source && (
                        <p>
                          来源{' '}
                          <AppLink
                            to={{
                              name: 'project-run',
                              projectId,
                              runId: data.source.runId,
                              tab: 'summary',
                            }}
                          >
                            {data.source.runId}
                          </AppLink>{' '}
                          · {compareTarget(data.source.targetCommit, data.run.targetCommit)} ·
                          配置：
                          {compareRevision(data.source.configRevision, data.queue?.configRevision)}
                        </p>
                      )}
                      {data.followups.map((item) => (
                        <p key={item.queueId}>
                          请求 #{item.queueId} · {item.status} ·{' '}
                          {item.runId ? (
                            <AppLink
                              to={{
                                name: 'project-run',
                                projectId,
                                runId: item.runId,
                                tab: 'summary',
                              }}
                            >
                              {item.runId}
                            </AppLink>
                          ) : (
                            '尚未创建 Run'
                          )}{' '}
                          · {compareTarget(data.run.targetCommit, item.resolvedTargetCommit)} ·
                          配置：{compareRevision(data.queue?.configRevision, item.configRevision)}
                        </p>
                      ))}
                    </section>
                  )}
                </>
              )}
              <RunTab projectId={projectId} data={data} tab={tab} />
            </>
          )}
        </AsyncRegion>
      </div>
    </section>
  );
}

function compareTarget(before: string | null, after: string | null): string {
  return !before || !after
    ? '新旧 target 尚不能比较'
    : before === after
      ? 'target 与来源相同'
      : `target 已变化：${before.slice(0, 12)} → ${after.slice(0, 12)}`;
}
function compareRevision(before?: number | null, after?: number | null): string {
  return before == null || after == null
    ? '修订记录不足'
    : before === after
      ? `相同（${after}）`
      : `已变化（${before} → ${after}）`;
}

function RunTab({
  projectId,
  data,
  tab,
}: {
  projectId: string;
  data: RunPageData;
  tab: RunDetailTab;
}) {
  switch (tab) {
    case 'summary':
      return <SummaryTab run={data.run} />;
    case 'scenarios':
      return <ScenariosTab projectId={projectId} run={data.run} />;
    case 'review':
      return (
        <ArtifactTab
          title="AI Reviewer 审核"
          content={data.run.artifacts['review.md']}
          empty="没有 Reviewer 审核工件。"
        />
      );
    case 'report':
      return <ReportTab run={data.run} report={data.report} />;
    case 'evidence':
      return <EvidenceTab projectId={projectId} run={data.run} />;
    case 'technical':
      return <TechnicalTab projectId={projectId} run={data.run} />;
  }
}

function SummaryTab({ run }: { run: OperationsRunDetail }) {
  const cleanupWarnings = (run.activities ?? []).filter(
    (activity) =>
      activity.code === 'test_data_cleanup_failed' ||
      activity.code === 'test_data_cleanup_record_failed',
  );
  return (
    <div className="run-summary-layout">
      <section className="run-verdict" aria-labelledby="run-verdict-title">
        <span className="scope-label">正式结论</span>
        <div>
          <RunStatus run={run} />
          <h2 id="run-verdict-title">{resultLabel(run)}</h2>
        </div>
        <p>{run.errorMessage || run.blockingReasons?.join('；') || '测试已按记录完成。'}</p>
      </section>
      {cleanupWarnings.map((activity) => (
        <p className="notice notice-warning" key={`${activity.at}:${activity.code}`}>
          数据清理告警：{activity.message}。该告警不改写正式测试结论。
        </p>
      ))}
      <div className="overview-grid">
        <section className="content-block">
          <div className="content-block-heading">
            <h2>执行范围</h2>
          </div>
          <dl className="fact-list">
            <Fact label="触发来源" value={triggerLabel(run.trigger)} />
            <Fact label="base commit" value={run.baseCommit ?? '无'} mono />
            <Fact label="target commit" value={run.targetCommit ?? '尚未固定'} mono />
            <Fact
              label="included commits"
              value={run.includedCommits.length ? run.includedCommits.join(', ') : '无'}
              mono
            />
            <Fact
              label="配置修订"
              value={run.execution ? String(run.execution.configRevision) : '历史记录未提供'}
            />
            <Fact
              label="执行位置"
              value={
                run.execution
                  ? `${run.execution.serverName} · 修订 ${run.execution.locationRevision}`
                  : '历史记录未提供'
              }
            />
            <Fact
              label="启动方式"
              value={
                run.execution?.startType === 'compose'
                  ? 'Docker Compose'
                  : run.execution
                    ? '单容器'
                    : '历史记录未提供'
              }
            />
          </dl>
        </section>
        <section className="content-block">
          <div className="content-block-heading">
            <h2>时间</h2>
          </div>
          <dl className="fact-list">
            <Fact label="开始" value={formatDate(run.startedAt)} />
            <Fact label="结束" value={formatDate(run.finishedAt)} />
            <Fact label="耗时" value={duration(run.startedAt, run.finishedAt)} />
            <Fact label="执行镜像" value={run.execution?.imageId ?? '历史记录未提供'} mono />
            <Fact
              label="运行入口"
              value={
                run.execution?.baseUrl
                  ? `${run.execution.baseUrl}${run.execution.cleanupState === 'released' ? '（已失效）' : '（仅 Run 期间有效）'}`
                  : '无应用入口'
              }
            />
            <Fact label="资源状态" value={run.execution?.cleanupState ?? '历史记录未提供'} />
          </dl>
        </section>
        <section className="content-block">
          <div className="content-block-heading">
            <h2>收尾与推进</h2>
          </div>
          <dl className="fact-list">
            <Fact
              label="报告"
              value={run.archive ? reportStatus(run.archive.reportStatus) : '尚无归档事实'}
            />
            <Fact label="归档" value={run.archive?.archiveStatus ?? '尚无归档事实'} />
            <Fact label="场景发布" value={run.archive?.scenarioStatus ?? '尚无归档事实'} />
            <Fact
              label="推进"
              value={run.archive ? (run.archive.progressed ? '已推进' : '未推进') : '尚无事实'}
            />
          </dl>
          {run.archive?.archiveError && (
            <p className="notice notice-warning">{run.archive.archiveError}</p>
          )}
        </section>
        <section className="content-block">
          <div className="content-block-heading">
            <h2>关联动作</h2>
          </div>
          <ul className="related-list">
            {run.issues.map((issue) => (
              <li key={issue.bugKey}>
                <strong>
                  {issue.bugKey} · {issue.title}
                </strong>
                <span>{issue.status}</span>
                {issue.issueUrl && (
                  <SafeExternalLink href={issue.issueUrl}>打开 Issue</SafeExternalLink>
                )}
              </li>
            ))}
            {run.issues.length === 0 && <li>没有关联 Issue。</li>}
            {run.archive?.scenarioPrUrl && (
              <li>
                <strong>场景变更 PR</strong>
                <SafeExternalLink href={run.archive.scenarioPrUrl}>打开 PR</SafeExternalLink>
              </li>
            )}
          </ul>
        </section>
      </div>
    </div>
  );
}

function ScenariosTab({ projectId, run }: { projectId: string; run: OperationsRunDetail }) {
  return (
    <section className="detail-panel">
      <header>
        <h2>场景结果</h2>
        <p>证据状态与功能结论分别展示。</p>
      </header>
      {run.scenarioResults.length ? (
        <table className="record-table">
          <thead>
            <tr>
              <th>场景</th>
              <th>结论</th>
              <th>证据</th>
            </tr>
          </thead>
          <tbody>
            {run.scenarioResults.map((item) => (
              <tr key={item.id}>
                <td>
                  <AppLink
                    className="text-link"
                    to={{ name: 'project-scenario', projectId, scenarioId: item.id }}
                  >
                    {item.id}
                  </AppLink>
                </td>
                <td>
                  <ResultStatus result={item.result} />
                </td>
                <td>
                  {run.evidence?.length
                    ? `${run.evidence.length} 个 Run 证据对象`
                    : '没有已登记证据'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="empty-line">没有结构化场景结果。</p>
      )}
    </section>
  );
}

function ArtifactTab({
  title,
  content,
  empty,
}: {
  title: string;
  content: string | undefined;
  empty: string;
}) {
  return (
    <section className="detail-panel">
      <header>
        <h2>{title}</h2>
        <p>这是 AI 角色工件，不是人工评分。</p>
      </header>
      {content ? (
        <MarkdownView content={content} label={title} />
      ) : (
        <p className="empty-line">{empty}</p>
      )}
    </section>
  );
}

function ReportTab({ run, report }: { run: OperationsRunDetail; report: IndexedReport | null }) {
  const content = report?.content ?? run.artifacts['report.md'];
  return (
    <section className="detail-panel">
      <header>
        <h2>正式报告</h2>
        <p>
          {report
            ? `Git 来源 ${report.commitSha.slice(0, 12)} · ${report.path}`
            : '尚未从 Git 索引读取正式报告。'}
        </p>
      </header>
      {content ? (
        <>
          <MarkdownView content={content} label="正式报告渲染视图" />
          <details className="markdown-source">
            <summary>查看 Markdown 原文</summary>
            <pre>{content}</pre>
          </details>
        </>
      ) : (
        <p className="empty-line">正式报告尚不可用。</p>
      )}
      <dl className="fact-list">
        <Fact
          label="发布状态"
          value={run.archive ? reportStatus(run.archive.reportStatus) : '尚无归档事实'}
        />
        <Fact
          label="报告 commit"
          value={run.archive?.reportCommitSha ?? report?.commitSha ?? '尚无'}
          mono
        />
      </dl>
    </section>
  );
}

function EvidenceTab({ projectId, run }: { projectId: string; run: OperationsRunDetail }) {
  return (
    <section className="detail-panel">
      <header>
        <h2>证据</h2>
        <p>证据缺失或读取失败影响审核可信度，但不自动改写场景功能结论。</p>
      </header>
      {run.evidence?.length ? (
        <div className="evidence-grid">
          {run.evidence.map((evidence) => (
            <EvidenceItem
              key={evidence.id}
              projectId={projectId}
              runId={run.runId}
              evidence={evidence}
            />
          ))}
        </div>
      ) : (
        <p className="empty-line">没有已登记证据。</p>
      )}
    </section>
  );
}

function EvidenceItem({
  projectId,
  runId,
  evidence,
}: {
  projectId: string;
  runId: string;
  evidence: EvidenceReference;
}) {
  const [failed, setFailed] = useState(false);
  const url = `/api/projects/${encodeURIComponent(projectId)}/runs/${encodeURIComponent(runId)}/evidence/${encodeURIComponent(evidence.id)}`;
  const image = evidence.contentType.startsWith('image/');
  return (
    <article className="evidence-item">
      <div className="evidence-preview">
        {image && !failed ? (
          <img src={url} alt={`证据 ${evidence.filename}`} onError={() => setFailed(true)} />
        ) : (
          <span>{failed ? '证据读取失败' : '非图片证据'}</span>
        )}
      </div>
      <h3>{evidence.filename}</h3>
      <dl className="evidence-meta">
        <Fact label="类型" value={evidence.contentType} />
        <Fact label="大小" value={formatBytes(evidence.sizeBytes)} />
        <Fact label="生成时间" value={formatDate(evidence.uploadedAt)} />
        <Fact label="SHA-256" value={evidence.sha256} mono />
        <Fact label="完整性" value={evidence.sha256 ? '已登记对象哈希' : '缺失'} />
        {evidence.screenshotInspection && (
          <Fact label="截图检测" value={screenshotInspectionLabel(evidence.screenshotInspection)} />
        )}
      </dl>
      <a className="text-link" href={url} target="_blank" rel="noopener noreferrer">
        打开受控对象
      </a>
    </article>
  );
}

function TechnicalTab({ projectId, run }: { projectId: string; run: OperationsRunDetail }) {
  return (
    <section className="detail-panel">
      <header>
        <h2>技术信息</h2>
        <p>只展示安全标识和状态代码。</p>
      </header>
      <details className="technical-record" open>
        <summary>完整标识</summary>
        <dl className="fact-list">
          <Fact label="Run ID" value={run.runId} mono />
          <Fact label="projectId" value={projectId} mono />
          <Fact label="target commit" value={run.targetCommit ?? '无'} mono />
          <Fact label="工件" value={run.artifactNames.join(', ') || '无'} />
          <Fact label="场景 PR" value={run.archive?.scenarioStatus ?? '无'} />
          <Fact label="归档重试" value={run.archive?.archiveStatus ?? '无'} />
        </dl>
      </details>
    </section>
  );
}

function RunStatus({ run }: { run: OperationsRunDetail }) {
  const label = resultLabel(run);
  const tone =
    run.status === 'running'
      ? 'running'
      : run.result === 'passed'
        ? 'success'
        : run.result === 'failed'
          ? 'danger'
          : 'warning';
  return <StatusLabel tone={tone}>{label}</StatusLabel>;
}
function ResultStatus({ result }: { result: 'passed' | 'failed' | 'blocked' }) {
  return (
    <StatusLabel
      tone={result === 'passed' ? 'success' : result === 'failed' ? 'danger' : 'warning'}
    >
      {{ passed: '通过', failed: '失败', blocked: '阻塞' }[result]}
    </StatusLabel>
  );
}
function SafeExternalLink({ href, children }: { href: string; children: string }) {
  return (
    <a className="text-link" href={href} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
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
function resultLabel(run: OperationsRunDetail) {
  if (run.stopRequestedAt && run.status === 'running') return '正在停止与收尾';
  if (run.stopReason === 'user_requested' && run.status === 'interrupted') return '管理员已停止';
  if (run.status === 'running') return '执行中';
  if (run.status === 'interrupted') return '已中断';
  return run.result ? { passed: '通过', failed: '失败', blocked: '阻塞' }[run.result] : '无结论';
}
function reportStatus(
  status: OperationsRunDetail['archive'] extends infer A
    ? A extends { reportStatus: infer S }
      ? S & string
      : never
    : never,
) {
  return (
    (
      {
        published: '已发布',
        pending: '待发布',
        not_applicable: '不适用',
        conflict: '发布冲突',
        failed: '发布失败',
      } as Record<string, string>
    )[status] ?? status
  );
}
function triggerLabel(trigger: OperationsRunDetail['trigger']) {
  return { manual: '手动', api: 'API', git: 'Git', schedule: '定时' }[trigger];
}
function shortId(value: string) {
  return value.length > 14 ? `${value.slice(0, 10)}…${value.slice(-4)}` : value;
}
function formatDate(value: string | null | undefined) {
  return value ? new Date(value).toLocaleString('zh-CN') : '尚无';
}
function duration(start: string, end: string | null) {
  const seconds = Math.max(
    0,
    Math.floor((new Date(end ?? Date.now()).getTime() - new Date(start).getTime()) / 1000),
  );
  return seconds >= 3600
    ? `${Math.floor(seconds / 3600)} 小时 ${Math.floor((seconds % 3600) / 60)} 分`
    : `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
}
function formatBytes(value: number) {
  return value >= 1024 * 1024
    ? `${(value / 1024 / 1024).toFixed(1)} MB`
    : value >= 1024
      ? `${(value / 1024).toFixed(1)} KB`
      : `${value} B`;
}
