import { useCallback, useEffect, useState, type FormEvent } from 'react';

import { requestJson, toUserMessage } from '../api';
import { useResource } from '../app/resource';
import { AsyncRegion } from '../components/AsyncRegion';
import { useAppMessage } from '../components/AppMessageProvider';
import { Field, NumberInput } from '../components/FormControls';
import { AccountSettingsContent } from './AccountSettingsPage';

type SystemSettingsResponse = {
  runtime: { maxConcurrentProjects: number };
  startup: {
    host: string;
    port: number;
    dataDir: string;
    databasePath: string;
    repoDir: string;
    reportDir: string;
    logLevel: string;
  };
};

export function SystemSettingsPage({ onPasswordChanged }: { onPasswordChanged: () => void }) {
  const notify = useAppMessage();
  const load = useCallback(
    (signal: AbortSignal) =>
      requestJson<SystemSettingsResponse>('/api/system-settings', { signal }),
    [],
  );
  const resource = useResource('system-settings', load, (cause) =>
    toUserMessage(cause, '系统设置读取失败'),
  );
  const [limit, setLimit] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const value = limit ?? resource.value?.runtime.maxConcurrentProjects ?? 2;

  useEffect(() => setLimit(null), [resource.value?.runtime.maxConcurrentProjects]);

  async function saveConcurrency(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      const response = await requestJson<{ runtime: { maxConcurrentProjects: number } }>(
        '/api/system-settings',
        {
          method: 'PUT',
          body: JSON.stringify({ maxConcurrentProjects: value }),
        },
      );
      setLimit(null);
      resource.reload();
      notify.success(`最大并发项目数已更新为 ${response.runtime.maxConcurrentProjects}`);
    } catch (cause) {
      notify.error(toUserMessage(cause, '并发设置保存失败'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <AsyncRegion
      loading={resource.loading && !resource.value}
      error={!resource.value ? resource.error : ''}
      onRetry={resource.reload}
    >
      {resource.value && (
        <div className="system-settings-stack">
          <AccountSettingsContent onPasswordChanged={onPasswordChanged} />
          <form className="content-block settings-form" onSubmit={saveConcurrency}>
            <div className="content-block-heading">
              <h2>任务调度</h2>
              <p>限制同时执行测试的不同项目数量；同一个项目始终串行。</p>
            </div>
            <Field label="最大并发项目数">
              <NumberInput
                ariaLabel="最大并发项目数"
                min={1}
                max={8}
                step={1}
                value={value}
                disabled={busy}
                onChange={setLimit}
              />
            </Field>
            <div className="settings-actions">
              <button
                className="button button-primary"
                type="submit"
                disabled={busy || value === resource.value.runtime.maxConcurrentProjects}
              >
                {busy ? '保存中…' : '保存调度设置'}
              </button>
            </div>
          </form>
          <section className="content-block">
            <div className="content-block-heading">
              <h2>启动配置</h2>
              <p>这些项目涉及监听地址和数据目录，需要修改部署环境并重启罗网。</p>
            </div>
            <dl className="fact-list system-startup-facts">
              <Fact
                label="监听地址"
                value={`${resource.value.startup.host}:${resource.value.startup.port}`}
              />
              <Fact label="日志等级" value={resource.value.startup.logLevel} />
              <Fact label="数据目录" value={resource.value.startup.dataDir} />
              <Fact label="数据库" value={resource.value.startup.databasePath} />
              <Fact label="仓库目录" value={resource.value.startup.repoDir} />
              <Fact label="报告目录" value={resource.value.startup.reportDir} />
            </dl>
          </section>
        </div>
      )}
    </AsyncRegion>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd className="mono-value">{value}</dd>
    </div>
  );
}
