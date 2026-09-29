import { useCallback, useMemo, useState } from 'react';

import type { OperationsRunSummary, RunResult, RunTrigger } from '../../../shared/types';
import { requestJson, toUserMessage } from '../../api';
import { AppLink } from '../../app/navigation';
import { useResource } from '../../app/resource';
import { AsyncRegion } from '../../components/AsyncRegion';
import { PageHeading } from '../../components/PageHeading';
import { StatusLabel } from '../../components/StatusLabel';

export function ProjectRunsPage({ projectId }: { projectId: string }) {
  const load = useCallback(
    (signal: AbortSignal) =>
      requestJson<{ runs: OperationsRunSummary[] }>(`/api/projects/${projectId}/runs`, {
        signal,
      }).then((response) => response.runs),
    [projectId],
  );
  const resource = useResource(`project-runs:${projectId}`, load, (cause) =>
    toUserMessage(cause, '测试记录读取失败'),
  );
  const [query, setQuery] = useState('');
  const [result, setResult] = useState<'all' | RunResult | 'interrupted'>('all');
  const [trigger, setTrigger] = useState<'all' | RunTrigger>('all');
  const [date, setDate] = useState('');
  const runs = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return (resource.value ?? []).filter((run) => {
      const matchesQuery =
        !needle ||
        run.runId.toLocaleLowerCase().includes(needle) ||
        run.targetCommit?.toLocaleLowerCase().includes(needle) ||
        run.request.toLocaleLowerCase().includes(needle);
      const matchesResult =
        result === 'all' ||
        (result === 'interrupted' ? run.status === 'interrupted' : run.result === result);
      const matchesTrigger = trigger === 'all' || run.trigger === trigger;
      const matchesDate = !date || run.startedAt.slice(0, 10) === date;
      return matchesQuery && matchesResult && matchesTrigger && matchesDate;
    });
  }, [date, query, resource.value, result, trigger]);

  return (
    <section className="page-content runs-page">
      <PageHeading title="测试记录" scope="当前项目" />
      <div className="page-body">
        <div className="record-filters" aria-label="测试记录筛选">
          <label>
            <span>Run ID、commit 或要求</span>
            <input value={query} onChange={(event) => setQuery(event.target.value)} />
          </label>
          <label>
            <span>结论</span>
            <select
              value={result}
              onChange={(event) => setResult(event.target.value as typeof result)}
            >
              <option value="all">全部</option>
              <option value="passed">通过</option>
              <option value="failed">失败</option>
              <option value="blocked">阻塞</option>
              <option value="interrupted">已中断</option>
            </select>
          </label>
          <label>
            <span>触发方式</span>
            <select
              value={trigger}
              onChange={(event) => setTrigger(event.target.value as typeof trigger)}
            >
              <option value="all">全部</option>
              <option value="manual">手动</option>
              <option value="api">API</option>
              <option value="git">Git</option>
              <option value="schedule">定时</option>
            </select>
          </label>
          <label>
            <span>开始日期</span>
            <input type="date" value={date} onChange={(event) => setDate(event.target.value)} />
          </label>
        </div>
        <AsyncRegion
          loading={resource.loading && !resource.value}
          error={!resource.value ? resource.error : ''}
          onRetry={resource.reload}
          empty={Boolean(resource.value && !resource.value.length)}
        >
          {resource.value && resource.value.length > 0 && (
            <div className="record-table-wrap">
              <table className="record-table">
                <thead>
                  <tr>
                    <th>结论</th>
                    <th>测试记录</th>
                    <th>固定提交</th>
                    <th>触发</th>
                    <th>开始 / 完成</th>
                    <th>场景</th>
                    <th>报告与告警</th>
                  </tr>
                </thead>
                <tbody>
                  {runs.map((run) => (
                    <RunRow key={run.runId} projectId={projectId} run={run} />
                  ))}
                </tbody>
              </table>
              {runs.length === 0 && <p className="empty-line">没有符合筛选条件的测试记录。</p>}
            </div>
          )}
        </AsyncRegion>
      </div>
    </section>
  );
}

function RunRow({ projectId, run }: { projectId: string; run: OperationsRunSummary }) {
  const counts = run.scenarioResults.reduce(
    (result, item) => ({ ...result, [item.result]: result[item.result] + 1 }),
    { passed: 0, failed: 0, blocked: 0 },
  );
  const warnings = [
    run.archive?.archiveError,
    run.archive?.scenarioError,
    ...(run.activities ?? [])
      .filter((activity) => activity.kind === 'warning')
      .map((activity) => activity.message),
  ].filter(Boolean);
  return (
    <tr>
      <td>
        <RunStatus run={run} />
      </td>
      <td>
        <AppLink
          className="object-link"
          to={{ name: 'project-run', projectId, runId: run.runId, tab: 'summary' }}
        >
          {shortId(run.runId)}
        </AppLink>
        <small>{run.request}</small>
      </td>
      <td>
        <code title={run.targetCommit ?? undefined}>{shortSha(run.targetCommit)}</code>
      </td>
      <td>{triggerLabel(run.trigger)}</td>
      <td>
        <span>{formatDate(run.startedAt)}</span>
        <small>
          {run.finishedAt ? formatDate(run.finishedAt) : '尚未完成'} ·{' '}
          {duration(run.startedAt, run.finishedAt)}
        </small>
      </td>
      <td>
        {run.scenarioResults.length
          ? `${counts.passed} 通过 / ${counts.failed} 失败 / ${counts.blocked} 阻塞`
          : '尚无场景结果'}
      </td>
      <td>
        <span>{archiveLabel(run)}</span>
        {warnings.length > 0 && <small className="warning-text">{warnings.length} 项告警</small>}
      </td>
    </tr>
  );
}

function RunStatus({ run }: { run: OperationsRunSummary }) {
  const label =
    run.status === 'interrupted'
      ? '已中断'
      : run.status === 'running'
        ? '执行中'
        : resultLabel(run.result);
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
function archiveLabel(run: OperationsRunSummary) {
  if (!run.archive) return '尚无归档事实';
  return {
    published: '正式报告已发布',
    pending: '报告待发布',
    not_applicable: '无正式报告',
    conflict: '报告冲突',
    failed: '报告发布失败',
  }[run.archive.reportStatus];
}
function resultLabel(result: OperationsRunSummary['result']) {
  return result ? { passed: '通过', failed: '失败', blocked: '阻塞' }[result] : '无结论';
}
function triggerLabel(trigger: RunTrigger) {
  return { manual: '手动', api: 'API', git: 'Git', schedule: '定时' }[trigger];
}
function shortId(value: string) {
  return value.length > 14 ? `${value.slice(0, 10)}…${value.slice(-4)}` : value;
}
function shortSha(value: string | null) {
  return value ? value.slice(0, 12) : '尚未固定';
}
function formatDate(value: string) {
  return new Date(value).toLocaleString('zh-CN');
}
function duration(start: string, end: string | null) {
  const seconds = Math.max(
    0,
    Math.floor((new Date(end ?? Date.now()).getTime() - new Date(start).getTime()) / 1000),
  );
  const minutes = Math.floor(seconds / 60);
  return minutes >= 60
    ? `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分`
    : `${minutes} 分 ${seconds % 60} 秒`;
}
