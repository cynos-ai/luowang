import { useCallback, useMemo, useState } from 'react';

import type { ConsoleReadinessCheck, ConsoleReadinessSnapshot } from '../../../shared/types';
import { requestJson, toUserMessage } from '../../api';
import { AppLink } from '../../app/navigation';
import { useResource } from '../../app/resource';
import { AsyncRegion } from '../../components/AsyncRegion';
import { AppMessageFeedback } from '../../components/AppMessageProvider';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { PageHeading } from '../../components/PageHeading';
import { StatusLabel } from '../../components/StatusLabel';
import type { ProjectDetailResponse } from '../../project-types';

type IndexState = {
  commitSha: string | null;
  syncedAt: string | null;
  errors: Array<{ path: string; message: string }>;
};

export function ProjectReadinessPage({ projectId }: { projectId: string }) {
  const loadDetail = useCallback(
    (signal: AbortSignal) =>
      Promise.all([
        requestJson<ProjectDetailResponse>(`/api/projects/${projectId}`, { signal }),
        requestJson<{ index: IndexState }>(`/api/projects/${projectId}/index`, { signal }),
      ]).then(([detail, index]) => ({ detail, index: index.index })),
    [projectId],
  );
  const loadReadiness = useCallback(
    (signal: AbortSignal) =>
      requestJson<{ readiness: ConsoleReadinessSnapshot }>(
        `/api/projects/${projectId}/readiness/status`,
        { signal },
      ).then((response) => response.readiness),
    [projectId],
  );
  const detail = useResource(`project-readiness-detail:${projectId}`, loadDetail, (cause) =>
    toUserMessage(cause, '项目准备信息读取失败'),
  );
  const readiness = useResource(`project-readiness-status:${projectId}`, loadReadiness, (cause) =>
    toUserMessage(cause, '运行准备状态读取失败'),
  );
  const [busy, setBusy] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [confirmImage, setConfirmImage] = useState(false);
  const checks = useMemo(
    () => new Map(readiness.value?.checks.map((check) => [check.id, check]) ?? []),
    [readiness.value],
  );

  async function action(label: string, operation: () => Promise<unknown>, reload: () => void) {
    setBusy(label);
    setMessage('');
    setError('');
    try {
      await operation();
      reload();
      setMessage(`${label}完成；请根据需要重新检查。`);
    } catch (cause) {
      setError(toUserMessage(cause, `${label}失败`));
    } finally {
      setBusy('');
    }
  }

  const project = detail.value?.detail.project;
  return (
    <section className="page-content readiness-page">
      <PageHeading
        title="运行准备"
        scope="当前项目"
        actions={
          <button
            className="button"
            type="button"
            disabled={Boolean(busy)}
            onClick={() =>
              void action(
                '运行准备检查',
                () => requestJson(`/api/projects/${projectId}/readiness/check`, { method: 'POST' }),
                readiness.reload,
              )
            }
          >
            {busy === '运行准备检查' ? '检查中…' : '重新检查'}
          </button>
        }
      />
      <div className="page-body readiness-layout">
        <AppMessageFeedback success={message} error={error} />
        <AsyncRegion
          loading={readiness.loading && !readiness.value}
          error={!readiness.value ? readiness.error : ''}
          onRetry={readiness.reload}
        >
          {readiness.value && <ReadinessVerdict snapshot={readiness.value} />}
        </AsyncRegion>
        <AsyncRegion
          loading={detail.loading && !detail.value}
          error={!detail.value ? detail.error : ''}
          onRetry={detail.reload}
        >
          {detail.value && (
            <>
              <section className="readiness-section" aria-labelledby="readiness-repository">
                <SectionHeading
                  number="01"
                  id="readiness-repository"
                  title="仓库与同步"
                  check={checks.get('repository')}
                />
                <dl className="fact-list">
                  <Fact
                    label="已核验仓库"
                    value={`${project?.repositoryOwner}/${project?.repositoryName}`}
                  />
                  <Fact label="场景分支" value={detail.value.detail.configuration.scenarioBranch} />
                  <Fact label="最近索引提交" value={shortSha(detail.value.index.commitSha)} mono />
                  <Fact label="最近同步" value={formatDate(detail.value.index.syncedAt)} />
                </dl>
                {detail.value.index.errors.length > 0 && (
                  <ul className="error-list">
                    {detail.value.index.errors.map((item) => (
                      <li key={`${item.path}:${item.message}`}>
                        {item.path}：{item.message}
                      </li>
                    ))}
                  </ul>
                )}
                <button
                  className="button button-secondary"
                  type="button"
                  disabled={Boolean(busy)}
                  onClick={() =>
                    void action(
                      '同步场景与报告',
                      () =>
                        requestJson(`/api/projects/${projectId}/repository/sync`, {
                          method: 'POST',
                        }),
                      detail.reload,
                    )
                  }
                >
                  {busy === '同步场景与报告' ? '同步中…' : '同步场景与报告'}
                </button>
              </section>
              <section className="readiness-section" aria-labelledby="readiness-image">
                <SectionHeading
                  number="02"
                  id="readiness-image"
                  title="执行镜像"
                  check={checks.get('image')}
                />
                <dl className="fact-list">
                  <Fact
                    label="Dockerfile"
                    value={
                      detail.value.detail.configuration.executionDockerfile ||
                      '使用罗网内置执行镜像'
                    }
                    mono
                  />
                  <Fact label="固定提交" value={shortSha(detail.value.index.commitSha)} mono />
                  <Fact label="镜像事实" value={checks.get('image')?.message ?? '尚未检查'} />
                </dl>
                <button
                  className="button button-secondary"
                  type="button"
                  disabled={Boolean(busy)}
                  onClick={() => setConfirmImage(true)}
                >
                  准备或重建镜像
                </button>
              </section>
              <section className="readiness-section" aria-labelledby="readiness-environment">
                <SectionHeading
                  number="03"
                  id="readiness-environment"
                  title="测试环境"
                  check={checks.get('environment')}
                />
                <dl className="fact-list">
                  <Fact
                    label="非生产环境"
                    value={detail.value.detail.configuration.baseUrl || '未配置'}
                  />
                  <Fact
                    label="测试账号"
                    value={configured(detail.value.detail.secrets.testUsername.configured)}
                  />
                  <Fact
                    label="测试密码"
                    value={configured(detail.value.detail.secrets.testPassword.configured)}
                  />
                  <Fact
                    label="清理能力"
                    value={
                      detail.value.detail.configuration.testDataCleanupUrl
                        ? configured(detail.value.detail.secrets.testDataCleanupToken.configured)
                        : '未配置'
                    }
                  />
                </dl>
              </section>
              <section className="readiness-section" aria-labelledby="readiness-shared">
                <SectionHeading
                  number="04"
                  id="readiness-shared"
                  title="共享依赖"
                  check={checks.get('deployment')}
                />
                <p>{checks.get('deployment')?.message ?? '尚未检查模型、浏览器和对象存储。'}</p>
                <div className="page-actions">
                  <AppLink className="text-link" to={{ name: 'system' }}>
                    查看系统状态
                  </AppLink>
                  <AppLink
                    className="text-link"
                    to={{ name: 'global-settings', section: 'models' }}
                  >
                    查看全局设置
                  </AppLink>
                </div>
              </section>
            </>
          )}
        </AsyncRegion>
      </div>
      {confirmImage && project && (
        <ConfirmDialog
          open
          title="准备或重建执行镜像"
          message={`${project.displayName} · ${project.repositoryOwner}/${project.repositoryName}。这会读取固定提交并执行受控 Docker 构建。`}
          confirmLabel="确认准备镜像"
          onConfirm={() => {
            setConfirmImage(false);
            void action(
              '准备执行镜像',
              () =>
                requestJson(`/api/projects/${projectId}/image/prepare`, {
                  method: 'POST',
                  body: '{}',
                }),
              () => {
                detail.reload();
                readiness.reload();
              },
            );
          }}
          onClose={() => setConfirmImage(false)}
        />
      )}
    </section>
  );
}

function ReadinessVerdict({ snapshot }: { snapshot: ConsoleReadinessSnapshot }) {
  return (
    <section
      className={`readiness-verdict verdict-${snapshot.status}`}
      aria-labelledby="readiness-verdict"
    >
      <div>
        <span className="scope-label">总体结论</span>
        <h2 id="readiness-verdict">{readinessLabel(snapshot.status)}</h2>
        <p>
          {snapshot.staleReason ||
            snapshot.checks
              .filter((check) => check.status !== 'ok')
              .map((check) => check.message)
              .join('；') ||
            '全部固定检查已通过。'}
        </p>
      </div>
      <small>{snapshot.checkedAt ? `检查于 ${formatDate(snapshot.checkedAt)}` : '尚未检查'}</small>
    </section>
  );
}

function SectionHeading({
  number,
  id,
  title,
  check,
}: {
  number: string;
  id: string;
  title: string;
  check?: ConsoleReadinessCheck;
}) {
  return (
    <div className="readiness-section-heading">
      <span>{number}</span>
      <div>
        <h2 id={id}>{title}</h2>
        {check && <p>{check.message}</p>}
      </div>
      <StatusLabel tone={check?.status === 'ok' ? 'success' : check ? 'warning' : 'neutral'}>
        {checkStatus(check?.status)}
      </StatusLabel>
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

function readinessLabel(status: ConsoleReadinessSnapshot['status']) {
  return {
    ready: '已就绪',
    not_ready: '未就绪',
    stale: '需要重新检查',
    not_checked: '尚未检查',
    error: '检查异常',
  }[status];
}

function checkStatus(status: ConsoleReadinessCheck['status'] | undefined) {
  return status
    ? {
        ok: '通过',
        degraded: '降级',
        unavailable: '不可用',
        not_configured: '未配置',
        unknown: '无法确认',
        not_checked: '待检查',
      }[status]
    : '待检查';
}

function configured(value: boolean) {
  return value ? '已配置（不回显）' : '未配置';
}
function shortSha(value: string | null) {
  return value ? value.slice(0, 12) : '尚无';
}
function formatDate(value: string | null) {
  return value ? new Date(value).toLocaleString('zh-CN') : '尚无';
}
