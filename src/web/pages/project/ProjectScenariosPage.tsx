import { useCallback, useMemo, useState } from 'react';

import type { OperationsScenario, ScenarioStatus } from '../../../shared/types';
import { requestJson, toUserMessage } from '../../api';
import { AppLink } from '../../app/navigation';
import { useResource } from '../../app/resource';
import { AsyncRegion } from '../../components/AsyncRegion';
import { PageHeading } from '../../components/PageHeading';
import { StatusLabel } from '../../components/StatusLabel';

export function ProjectScenariosPage({ projectId }: { projectId: string }) {
  const load = useCallback(
    (signal: AbortSignal) =>
      requestJson<{ scenarios: OperationsScenario[] }>(`/api/projects/${projectId}/scenarios`, {
        signal,
      }).then((response) => response.scenarios),
    [projectId],
  );
  const resource = useResource(`project-scenarios:${projectId}`, load, (cause) =>
    toUserMessage(cause, '场景目录读取失败'),
  );
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState<'all' | ScenarioStatus>('all');
  const [tag, setTag] = useState('');
  const scenarios = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    const tagNeedle = tag.trim().toLocaleLowerCase();
    return (resource.value ?? []).filter(
      (scenario) =>
        (status === 'all' || scenario.status === status) &&
        (!needle ||
          [scenario.id, scenario.name, scenario.description].some((value) =>
            value.toLocaleLowerCase().includes(needle),
          )) &&
        (!tagNeedle ||
          scenario.tags.some((value) => value.toLocaleLowerCase().includes(tagNeedle))),
    );
  }, [query, resource.value, status, tag]);
  return (
    <section className="page-content scenarios-page">
      <PageHeading title="场景" scope="当前项目" description="Git 场景资产的只读目录。" />
      <div className="page-body">
        <div className="record-filters scenario-filters">
          <label>
            <span>名称或 ID</span>
            <input value={query} onChange={(event) => setQuery(event.target.value)} />
          </label>
          <label>
            <span>状态</span>
            <select
              value={status}
              onChange={(event) => setStatus(event.target.value as typeof status)}
            >
              <option value="all">全部</option>
              <option value="approved">approved</option>
              <option value="draft">draft</option>
              <option value="deprecated">deprecated</option>
            </select>
          </label>
          <label>
            <span>标签</span>
            <input value={tag} onChange={(event) => setTag(event.target.value)} />
          </label>
        </div>
        <AsyncRegion
          loading={resource.loading && !resource.value}
          error={!resource.value ? resource.error : ''}
          onRetry={resource.reload}
          empty={Boolean(resource.value && !resource.value.length)}
        >
          {resource.value && resource.value.length > 0 && (
            <div className="scenario-directory">
              {scenarios.map((scenario) => (
                <ScenarioRow key={scenario.id} projectId={projectId} scenario={scenario} />
              ))}
              {scenarios.length === 0 && <p className="empty-line">没有符合筛选条件的场景。</p>}
            </div>
          )}
        </AsyncRegion>
      </div>
    </section>
  );
}

function ScenarioRow({ projectId, scenario }: { projectId: string; scenario: OperationsScenario }) {
  const recent = scenario.history[0];
  return (
    <article className="scenario-row">
      <div>
        <AppLink
          className="object-link"
          to={{ name: 'project-scenario', projectId, scenarioId: scenario.id }}
        >
          {scenario.id} · {scenario.name}
        </AppLink>
        <p>{scenario.description}</p>
        <small>{scenario.path}</small>
      </div>
      <StatusLabel
        tone={
          scenario.status === 'approved'
            ? 'success'
            : scenario.status === 'deprecated'
              ? 'neutral'
              : 'warning'
        }
      >
        {scenario.status}
      </StatusLabel>
      <div className="tag-list">
        {scenario.tags.map((tag) => (
          <span key={tag}>{tag}</span>
        ))}
      </div>
      <div>
        <strong>{recent ? resultLabel(recent.result) : '尚未执行'}</strong>
        <small>
          {recent ? formatDate(recent.finishedAt) : `索引于 ${formatDate(scenario.indexedAt)}`}
        </small>
      </div>
      <code title={scenario.commitSha}>{scenario.commitSha.slice(0, 12)}</code>
    </article>
  );
}
function resultLabel(result: 'passed' | 'failed' | 'blocked') {
  return { passed: '通过', failed: '失败', blocked: '阻塞' }[result];
}
function formatDate(value: string) {
  return new Date(value).toLocaleString('zh-CN');
}
