import { useCallback, type ReactNode } from 'react';

import type { IndexedReport, OperationsScenario } from '../../../shared/types';
import { requestJson, toUserMessage } from '../../api';
import { AppLink } from '../../app/navigation';
import { useResource } from '../../app/resource';
import { AsyncRegion } from '../../components/AsyncRegion';
import { MarkdownView } from '../../components/MarkdownView';
import { PageHeading } from '../../components/PageHeading';
import { StatusLabel } from '../../components/StatusLabel';

type ScenarioData = { scenario: OperationsScenario; reports: IndexedReport[] };
export function ProjectScenarioPage({
  projectId,
  scenarioId,
}: {
  projectId: string;
  scenarioId: string;
}) {
  const load = useCallback(
    async (signal: AbortSignal): Promise<ScenarioData> => {
      const [scenario, reports] = await Promise.all([
        requestJson<{ scenario: OperationsScenario }>(
          `/api/projects/${projectId}/scenarios/${encodeURIComponent(scenarioId)}`,
          { signal },
        ),
        requestJson<{ reports: IndexedReport[] }>(`/api/projects/${projectId}/reports`, { signal }),
      ]);
      return {
        scenario: scenario.scenario,
        reports: reports.reports.filter((report) =>
          report.scenarioResults.some((result) => result.id === scenarioId),
        ),
      };
    },
    [projectId, scenarioId],
  );
  const resource = useResource(`project-scenario:${projectId}:${scenarioId}`, load, (cause) =>
    toUserMessage(cause, '场景详情读取失败'),
  );
  const data = resource.value;
  return (
    <section className="page-content scenario-detail-page">
      <PageHeading title={data?.scenario.name ?? scenarioId} scope="当前项目 · 场景" />
      <div className="page-body">
        <AsyncRegion
          loading={resource.loading && !data}
          error={!data ? resource.error : ''}
          onRetry={resource.reload}
        >
          {data && (
            <div className="scenario-detail-layout">
              <aside className="scenario-meta">
                <StatusLabel
                  tone={
                    data.scenario.status === 'approved'
                      ? 'success'
                      : data.scenario.status === 'deprecated'
                        ? 'neutral'
                        : 'warning'
                  }
                >
                  {data.scenario.status}
                </StatusLabel>
                <dl className="fact-list">
                  <Fact label="场景 ID" value={data.scenario.id} mono />
                  <Fact label="来源文件" value={data.scenario.path} mono />
                  <Fact label="同步 commit" value={data.scenario.commitSha} mono />
                  <Fact label="索引时间" value={formatDate(data.scenario.indexedAt)} />
                </dl>
                <div className="tag-list">
                  {data.scenario.tags.map((tag) => (
                    <span key={tag}>{tag}</span>
                  ))}
                </div>
              </aside>
              <section className="detail-panel">
                <header>
                  <h2>场景定义</h2>
                  <p>{data.scenario.description}</p>
                </header>
                <MarkdownView content={data.scenario.content} label={`场景 ${data.scenario.id}`} />
              </section>
              <section className="content-block">
                <div className="content-block-heading">
                  <h2>最近执行</h2>
                </div>
                <ul className="related-list">
                  {data.scenario.history.map((item) => (
                    <li key={item.runId}>
                      <AppLink
                        className="text-link"
                        to={{ name: 'project-run', projectId, runId: item.runId, tab: 'scenarios' }}
                      >
                        {item.runId}
                      </AppLink>
                      <StatusLabel
                        tone={
                          item.result === 'passed'
                            ? 'success'
                            : item.result === 'failed'
                              ? 'danger'
                              : 'warning'
                        }
                      >
                        {resultLabel(item.result)}
                      </StatusLabel>
                      <small>
                        {formatDate(item.finishedAt)} · {item.targetCommit.slice(0, 12)}
                      </small>
                    </li>
                  ))}
                  {data.scenario.history.length === 0 && <li>尚无执行历史。</li>}
                </ul>
              </section>
              <section className="content-block">
                <div className="content-block-heading">
                  <h2>报告与审核</h2>
                </div>
                <ul className="related-list">
                  {data.reports.map((report) => (
                    <li key={report.runId}>
                      <AppLink
                        className="text-link"
                        to={{ name: 'project-run', projectId, runId: report.runId, tab: 'report' }}
                      >
                        正式报告 · {report.runId}
                      </AppLink>
                      <small>{report.commitSha.slice(0, 12)}</small>
                    </li>
                  ))}
                  {data.scenario.pendingPullRequests.map((pullRequest) => (
                    <li key={pullRequest.runId}>
                      <SafeExternalLink href={pullRequest.url}>
                        待审核场景 PR · {pullRequest.runId}
                      </SafeExternalLink>
                    </li>
                  ))}
                  {data.reports.length === 0 && data.scenario.pendingPullRequests.length === 0 && (
                    <li>没有相关报告或待审核 PR。</li>
                  )}
                </ul>
              </section>
            </div>
          )}
        </AsyncRegion>
      </div>
    </section>
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
function SafeExternalLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a className="text-link" href={href} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  );
}
function resultLabel(result: 'passed' | 'failed' | 'blocked') {
  return { passed: '通过', failed: '失败', blocked: '阻塞' }[result];
}
function formatDate(value: string) {
  return new Date(value).toLocaleString('zh-CN');
}
