import { useEffect, useState } from 'react';
import { BusyOverlay, Button, Field, StatusLabel, useAppMessage } from '../../components/ui';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { AppLink, useNavigationBlocker } from '../../app/navigation';
import { ApiError, requestJson, toUserMessage } from '../../api';
import type { ProjectConfiguration } from '../../project-types';
import {
  ENVIRONMENT_STAGES,
  type EnvironmentValidationTask,
} from '../../../shared/environment-preparation';
import type { PreparationInput } from '../../../shared/project-preparation';

type Draft = {
  generatedDefinition: NonNullable<ProjectConfiguration['generatedDefinition']>;
  runtime: ProjectConfiguration['runtime'];
};
type Task = {
  id: string;
  status: 'running' | 'completed' | 'needs_input' | 'failed' | 'cancelled';
  draft: Draft | null;
  error: string | null;
  targetCommit: string | null;
  filesRead?: number;
  startedAt?: string;
  lastActivityAt?: string;
  activity?: string;
  model?: string;
  thinking?: string;
  definitionAttempts?: number;
  lastToolError?: string | null;
  missingInputs?: PreparationInput[];
  reviewState?: 'pending' | 'applied' | 'discarded';
  stale?: boolean;
};

export function ProjectEnvironmentEditor({
  projectId,
  configuration,
  disabled,
  onSave,
  recommendation,
  hasUnsavedConfiguration = false,
  managedFiles = [],
}: {
  projectId: string;
  configuration: ProjectConfiguration;
  disabled: boolean;
  onSave: (patch: Partial<ProjectConfiguration>, taskId?: string) => Promise<boolean>;
  recommendation?: { reason: string; targetCommit: string } | null;
  hasUnsavedConfiguration?: boolean;
  managedFiles?: Array<{ path: string; serviceName: string | null; purpose?: string }>;
}) {
  const notify = useAppMessage();
  const [task, setTask] = useState<Task | null>(null);
  const [validation, setValidation] = useState<EnvironmentValidationTask | null>(null);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const [requirements, setRequirements] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [starting, setStarting] = useState<'generation' | 'validation' | null>(null);
  const [stopping, setStopping] = useState(false);
  const [confirmRegenerate, setConfirmRegenerate] = useState<boolean | null>(null);
  const saved = configuration.generatedDefinition;
  const current = saved ? { generatedDefinition: saved, runtime: configuration.runtime } : null;
  const working = task?.status === 'running' || validation?.status === 'running';
  const locked = disabled || busy || working || hasUnsavedConfiguration || loading;
  useEffect(() => {
    if (!working) setStopping(false);
  }, [working]);
  const pendingDraft =
    task?.status === 'completed' && (!task.reviewState || task.reviewState === 'pending');
  let draft: Draft | null = current;
  let invalidJson = false;
  if (editing !== null) {
    try {
      const value = JSON.parse(editing) as Draft;
      if (
        !value.generatedDefinition ||
        typeof value.generatedDefinition.sourceCommit !== 'string' ||
        typeof value.generatedDefinition.summary !== 'string' ||
        !Array.isArray(value.generatedDefinition.files) ||
        !value.generatedDefinition.files.every(
          (file) => file && typeof file.path === 'string' && typeof file.content === 'string',
        ) ||
        !Array.isArray(value.runtime?.composeServices) ||
        !value.runtime.composeServices.every((service) => typeof service === 'string') ||
        !Array.isArray(value.runtime?.initializationSteps ?? []) ||
        !(value.runtime.initializationSteps ?? []).every(
          (step) => step && typeof step.service === 'string' && typeof step.command === 'string',
        )
      )
        throw new Error();
      const plan = value.generatedDefinition.preparation;
      if (
        !plan ||
        !['scope', 'data', 'externalServices'].every(
          (key) => typeof plan[key as 'scope'] === 'string',
        ) ||
        !plan.account ||
        !['none', 'provided', 'generated'].includes(plan.account.mode) ||
        typeof plan.account.description !== 'string' ||
        !Array.isArray(plan.decisions) ||
        !plan.decisions.every((item) => typeof item === 'string') ||
        !Array.isArray(plan.evidence) ||
        !plan.evidence.every((item) => typeof item === 'string')
      )
        throw new Error();
      if (
        value.runtime.preparationChecks !== undefined &&
        (!Array.isArray(value.runtime.preparationChecks) ||
          !value.runtime.preparationChecks.every(
            (check) =>
              check && typeof check.label === 'string' && typeof check.command === 'string',
          ))
      )
        throw new Error();
      draft = value;
    } catch {
      invalidJson = true;
      draft = null;
    }
  }
  const plan = draft?.generatedDefinition.preparation;
  const needsRefresh = pendingDraft && task.stale;
  const changes = current && draft && editing !== null ? describeChanges(current, draft) : [];
  const validationCurrent = validation && !validation.stale && editing === null;
  const passed = validationCurrent && validation.status === 'passed';

  useEffect(() => {
    let cancelled = false;
    setTask(null);
    setValidation(null);
    setEditing(null);
    setError('');
    setRequirements('');
    setLoading(true);
    void Promise.all([
      requestJson<{ task: Task | null }>(`/api/projects/${projectId}/environment-generation`),
      requestJson<{ task: EnvironmentValidationTask | null }>(
        `/api/projects/${projectId}/environment-validation`,
      ),
    ])
      .then(([generation, check]) => {
        if (cancelled) return;
        const value = generation.task;
        setTask(value);
        setValidation(check.task);
        if (
          value?.status === 'completed' &&
          value.draft &&
          (!value.reviewState || value.reviewState === 'pending')
        )
          setEditing(JSON.stringify(value.draft, null, 2));
      })
      .catch((cause) => {
        if (!cancelled) setError(toUserMessage(cause, '无法读取准备状态，请刷新重试'));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  useNavigationBlocker(
    editing !== null
      ? () => ({
          title: '离开方案编辑？',
          message: '未保存的编辑将丢失，AI 原始草案仍可再次查看。',
          confirmLabel: '离开',
          cancelLabel: '继续编辑',
          danger: true,
        })
      : null,
  );

  useEffect(() => {
    if (!working) return;
    let cancelled = false;
    let fetching = false;
    const timer = setInterval(() => {
      if (fetching) return;
      fetching = true;
      void (async () => {
        try {
          if (task?.status === 'running') {
            const { task: next } = await requestJson<{ task: Task }>(
              `/api/projects/${projectId}/environment-generation/${task.id}`,
            );
            if (cancelled) return;
            setTask(next);
            if (next.status === 'completed' && next.draft) {
              setEditing(JSON.stringify(next.draft, null, 2));
              notify.success('准备方案已生成，请确认测试范围和业务选择');
            } else if (next.status === 'needs_input') notify.info('有信息需要你补充');
            else if (next.status === 'failed') notify.error(next.error ?? '分析失败');
            else if (next.status === 'cancelled') notify.info('分析已停止');
          }
          if (validation?.status === 'running') {
            const { task: next } = await requestJson<{ task: EnvironmentValidationTask | null }>(
              `/api/projects/${projectId}/environment-validation`,
            );
            if (cancelled) return;
            setValidation(next);
            if (next?.status === 'passed') notify.success('已完成配置中的准备核验，临时资源已清理');
            else if (next && next.status !== 'running')
              notify.error(next.failure?.message ?? '准备验证未通过');
          }
        } catch (cause) {
          if (!cancelled) {
            setError(toUserMessage(cause, '无法读取准备进度'));
            if (cause instanceof ApiError && cause.status === 404) {
              setTask(null);
              setValidation(null);
            }
          }
        } finally {
          fetching = false;
        }
      })();
    }, 1500);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [projectId, task?.id, task?.status, validation?.status, working, notify]);

  useEffect(() => {
    if (busy || working) return;
    let cancelled = false;
    void requestJson<{ task: EnvironmentValidationTask | null }>(
      `/api/projects/${projectId}/environment-validation`,
    )
      .then(({ task: next }) => {
        if (!cancelled) setValidation(next);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [projectId, configuration, busy, working]);

  async function operate(operation: () => Promise<void>) {
    setBusy(true);
    setError('');
    try {
      await operation();
    } catch (cause) {
      const message = toUserMessage(cause, '操作失败');
      setError(message);
      notify.error(message);
    } finally {
      setBusy(false);
    }
  }
  function generate(useValidationFailure = false) {
    setStarting('generation');
    void operate(async () => {
      try {
        const result = await requestJson<{ task: Task }>(
          `/api/projects/${projectId}/environment-generation`,
          {
            method: 'POST',
            body: JSON.stringify({ requirements, useValidationFailure }),
          },
        );
        setTask(result.task);
        setEditing(null);
        notify.success('开始分析项目；已保存的方案保持不变');
      } finally {
        setStarting(null);
      }
    });
  }
  function requestGeneration(useValidationFailure = false) {
    if (editing !== null) setConfirmRegenerate(useValidationFailure);
    else generate(useValidationFailure);
  }
  async function validate() {
    setStarting('validation');
    try {
      const result = await requestJson<{ task: EnvironmentValidationTask }>(
        `/api/projects/${projectId}/environment-validation`,
        { method: 'POST', body: '{}' },
      );
      setValidation(result.task);
      notify.success('准备验证已开始：会实际启动项目，结束后清理临时环境');
    } finally {
      setStarting(null);
    }
  }
  function stopPreparation() {
    setStopping(true);
    void operate(async () => {
      try {
        if (task?.status === 'running')
          await requestJson(`/api/projects/${projectId}/environment-generation/${task.id}`, {
            method: 'DELETE',
          });
        else if (validation?.status === 'running')
          await requestJson(`/api/projects/${projectId}/environment-validation/${validation.id}`, {
            method: 'DELETE',
          });
        notify.success('停止请求已提交，等待任务结束和资源清理');
      } catch (cause) {
        setStopping(false);
        throw cause;
      }
    });
  }
  function save(andValidate: boolean) {
    void operate(async () => {
      const value = JSON.parse(editing!) as Draft;
      const applied = await onSave(
        {
          runtimeMode: 'managed',
          startType: 'compose',
          executionDockerfile: '',
          generatedDefinition: value.generatedDefinition,
          runtime: value.runtime,
        },
        pendingDraft ? task.id : undefined,
      );
      if (!applied) return;
      setEditing(null);
      if (task) setTask({ ...task, reviewState: 'applied' });
      setValidation((previous) => (previous ? { ...previous, stale: true } : null));
      if (andValidate) {
        try {
          await validate();
        } catch (cause) {
          throw new Error(`方案已保存，但未能开始验证：${toUserMessage(cause, '请稍后重试')}`);
        }
      }
    });
  }
  const activeStep =
    task?.status === 'running'
      ? 0
      : editing !== null || task?.status === 'needs_input'
        ? 1
        : passed
          ? 3
          : saved
            ? 2
            : 0;
  const status = loading
    ? '正在读取准备状态'
    : task?.status === 'running'
      ? 'AI 正在分析项目'
      : validation?.status === 'running'
        ? '正在实际验证'
        : editing !== null
          ? '方案待确认 · 尚未验证'
          : task?.status === 'needs_input'
            ? '需要补充信息'
            : passed
              ? '已完成所配置的准备核验'
              : validation?.stale
                ? '准备条件已变化 · 需要重新验证'
                : validation?.status === 'failed'
                  ? '准备验证未通过'
                  : saved
                    ? '方案已保存 · 尚未验证当前准备条件'
                    : '从了解项目开始';

  return (
    <section className="settings-group environment-editor">
      {(working || starting) && (
        <BusyOverlay
          title={
            task?.status === 'running' || starting === 'generation'
              ? 'AI 正在准备测试方案'
              : '正在实际验证准备条件'
          }
          startedAt={task?.status === 'running' ? task.startedAt : validation?.startedAt}
          stopping={stopping}
          stopDisabled={Boolean(starting)}
          onStop={stopPreparation}
          stopLabel={
            task?.status === 'running' || starting === 'generation' ? '停止分析' : '停止验证'
          }
        >
          {task?.status === 'running' || starting === 'generation' ? (
            <>
              <p>
                Main · 独立准备会话{task?.model ? ` · ${task.model}` : ''} · 最高可用思考等级
                {task?.thinking ? `（${task.thinking}）` : '（正在核对模型能力）'}
              </p>
              <p>
                {task?.status === 'running'
                  ? task.activity || `已读取 ${task.filesRead ?? 0} 个文件，等待模型提交方案`
                  : '正在创建分析任务…'}
              </p>
              {task?.status === 'running' && (
                <p>
                  已读取 {task.filesRead ?? 0} 个文件 · 已尝试提交 {task.definitionAttempts ?? 0} 次
                </p>
              )}
              {task?.lastToolError && <p>上次提交未通过：{task.lastToolError}</p>}
              <p>总时限 30 分钟。只分析和生成方案，不会启动应用或修改已保存配置。</p>
            </>
          ) : (
            <p>
              {validation?.steps.at(-1)
                ? ENVIRONMENT_STAGES[validation.steps.at(-1)!.stage]
                : '正在创建验证任务…'}
              ；结束后会清理临时环境。
            </p>
          )}
          {error && <p role="alert">{error}</p>}
        </BusyOverlay>
      )}
      <header className="preparation-heading">
        <div>
          <h3>项目测试准备</h3>
          <p>罗网负责读代码、准备环境与数据；你只需确认测试范围，补充无法从代码得知的信息。</p>
        </div>
        <StatusLabel
          tone={
            passed
              ? 'success'
              : editing !== null || task?.status === 'needs_input'
                ? 'warning'
                : 'neutral'
          }
        >
          {status}
        </StatusLabel>
      </header>
      <ol className="preparation-flow" aria-label="准备流程">
        <li aria-current={activeStep === 0 ? 'step' : undefined}>
          <span>01</span> 分析项目
        </li>
        <li aria-current={activeStep === 1 ? 'step' : undefined}>
          <span>02</span> 确认方案
        </li>
        <li aria-current={activeStep === 2 ? 'step' : undefined}>
          <span>03</span> 实际验证
        </li>
        <li aria-current={activeStep === 3 ? 'step' : undefined}>
          <span>04</span> 开始测试
        </li>
      </ol>
      <div className="preparation-next" aria-live="polite">
        <h4>
          {needsRefresh
            ? '下一步：重新分析，核对准备方案'
            : editing !== null
              ? '下一步：确认下面的业务方案'
              : passed
                ? '下一步：查看核验范围，然后开始测试'
                : task?.status === 'needs_input'
                  ? '下一步：完成下面的待办'
                  : saved
                    ? '下一步：实际验证准备条件'
                    : '下一步：让 AI 先了解这个项目'}
        </h4>
        <p>
          {editing !== null
            ? '确认后将保存方案，并实际构建、准备数据和启动项目。验证结束会清理临时环境；这不是一次正式测试。'
            : passed
              ? '通过只代表下方实际执行的核验成功。未配置的账号、数据核验不会自动视为通过，产品功能仍需正式测试。'
              : saved
                ? '保存不等于可用。罗网将按保存的方案实际启动项目，检查配置中的准备条件并清理。'
                : '默认使用独立环境和合成数据。AI 会识别前后端、数据及登录需求，不需要你填写启动命令。'}{' '}
        </p>
        <div className="form-actions">
          {editing !== null ? (
            <>
              <Button
                type="button"
                variant={needsRefresh ? 'default' : 'secondary'}
                disabled={locked}
                onClick={() => requestGeneration()}
              >
                重新分析项目
              </Button>
              <Button
                type="button"
                disabled={locked || invalidJson || (pendingDraft && task.stale)}
                onClick={() => save(true)}
              >
                确认方案，保存并验证
              </Button>
              <Button
                type="button"
                variant="secondary"
                disabled={locked || invalidJson || (pendingDraft && task.stale)}
                onClick={() => save(false)}
              >
                仅保存方案
              </Button>
              <Button
                type="button"
                variant="secondary"
                disabled={locked}
                onClick={() =>
                  void operate(async () => {
                    if (pendingDraft) {
                      await requestJson(
                        `/api/projects/${projectId}/environment-generation/${task.id}/discard`,
                        { method: 'POST', body: '{}' },
                      );
                      setTask({ ...task, reviewState: 'discarded' });
                    }
                    setEditing(null);
                    notify.success('草案已放弃，保留已保存方案');
                  })
                }
              >
                放弃草案
              </Button>
            </>
          ) : (
            <>
              {!saved && (
                <Button type="button" disabled={locked} onClick={() => requestGeneration()}>
                  分析项目并准备方案
                </Button>
              )}
              {saved && !passed && (
                <Button type="button" disabled={locked} onClick={() => void operate(validate)}>
                  验证已保存方案
                </Button>
              )}
              {passed && (
                <AppLink className="button" to={{ name: 'project-test', projectId }}>
                  开始测试
                </AppLink>
              )}
              {saved && (
                <Button
                  type="button"
                  variant="secondary"
                  disabled={locked}
                  onClick={() => requestGeneration()}
                >
                  重新分析项目
                </Button>
              )}
              {passed && (
                <Button
                  type="button"
                  variant="secondary"
                  disabled={locked}
                  onClick={() => void operate(validate)}
                >
                  重新验证
                </Button>
              )}
            </>
          )}
          {working && (
            <Button
              type="button"
              variant="secondary"
              disabled={busy}
              onClick={() =>
                void operate(async () => {
                  if (task?.status === 'running')
                    await requestJson(
                      `/api/projects/${projectId}/environment-generation/${task.id}`,
                      { method: 'DELETE' },
                    );
                  else if (validation?.status === 'running')
                    await requestJson(
                      `/api/projects/${projectId}/environment-validation/${validation.id}`,
                      { method: 'DELETE' },
                    );
                  notify.success('停止请求已提交；已启动的临时资源会按流程清理');
                })
              }
            >
              停止{task?.status === 'running' ? '分析' : '验证'}
            </Button>
          )}
        </div>
        {passed && !editing && (
          <p>
            环境验证通过不等于业务测试通过。首次接入请进入测试页，选择“首次初始化测试”：深入理解项目、建立整体业务场景基线、按审核策略执行并形成报告。后续按变化增量维护；不会自动发起测试。
          </p>
        )}
        {hasUnsavedConfiguration && <p role="status">请先保存上方运行方式和运行参数。</p>}
        {task?.status === 'running' && (
          <p role="status">
            正在读取固定源码{task.targetCommit ? ` ${task.targetCommit.slice(0, 8)}` : ''}
            {task.filesRead ? ` · 已读取 ${task.filesRead} 个文件` : ''}；尚未启动应用。
          </p>
        )}
      </div>
      {(task?.error || error) && (
        <p className="notice notice-error" role="alert">
          {error || task?.error}
        </p>
      )}
      {pendingDraft && task.stale && (
        <p className="notice notice-warning">
          草案生成后准备条件已变化，不能保存。请重新分析项目。
        </p>
      )}
      {recommendation && (
        <p className="notice notice-warning">
          建议重新分析：{recommendation.reason} ·{' '}
          <code>{recommendation.targetCommit.slice(0, 8)}</code>
        </p>
      )}

      {task?.status === 'needs_input' && (
        <section className="preparation-todos">
          <h4>需要你补充 · {task.missingInputs?.length ?? 0} 项</h4>
          <ul>
            {task.missingInputs?.map((item, index) => (
              <li key={index}>
                <div>
                  <strong>{item.item}</strong>
                  <p>{item.reason}</p>
                </div>
                {item.destination && item.destination !== 'decision' ? (
                  <AppLink
                    className="button button-secondary"
                    to={{
                      name: 'project-settings',
                      projectId,
                      section: item.destination === 'files' ? 'files' : 'credentials',
                    }}
                  >
                    {item.destination === 'account'
                      ? '安全填写测试账号'
                      : item.destination === 'data'
                        ? '上传测试数据'
                        : '上传配置文件'}
                  </AppLink>
                ) : (
                  <a className="text-link" href="#preparation-feedback">
                    补充业务判断
                  </a>
                )}
              </li>
            ))}
          </ul>
          <p>补齐后回到这里重新分析。密码、Token 只在凭据或受控文件入口保存，不要写进下方说明。</p>
        </section>
      )}
      {draft && plan && (
        <section className="preparation-plan">
          <header className="settings-group-heading">
            <h4>罗网将这样准备</h4>
            <StatusLabel tone="neutral">
              {editing !== null ? 'AI 方案 · 未执行' : '已保存的计划'}
            </StatusLabel>
          </header>
          <>
            <dl className="preparation-facts">
              <div>
                <dt>测试范围</dt>
                <dd>{plan.scope}</dd>
              </div>
              <div>
                <dt>测试环境</dt>
                <dd>
                  在所选服务器复用符合条件的镜像和构建缓存，创建本次测试的独立环境。结束后回收临时容器和数据卷，不保留上轮测试数据；配置、凭据和上传原件保留。首次构建通常较慢，实际耗时见下方验证记录。
                </dd>
              </div>
              <div>
                <dt>初始数据</dt>
                <dd>{plan.data}</dd>
              </div>
              <div>
                <dt>测试身份</dt>
                <dd>
                  {plan.account.description}
                  <small>
                    {
                      {
                        none: '方案不要求主测试账号',
                        generated: '罗网保存受控凭据，由初始化脚本在隔离环境建立账号',
                        provided: '使用已保存的测试账号，不回显密码',
                      }[plan.account.mode]
                    }
                  </small>
                </dd>
              </div>
              <div>
                <dt>外部服务</dt>
                <dd>{plan.externalServices}</dd>
              </div>
            </dl>
            {plan.decisions.length > 0 && (
              <div className="preparation-decisions">
                <h4>请确认这些业务选择</h4>
                <ul>
                  {plan.decisions.map((decision, index) => (
                    <li key={index}>{decision}</li>
                  ))}
                </ul>
                <p>符合预期即可确认方案；有不同意见，在下方告诉 AI。</p>
              </div>
            )}
            <details className="settings-details">
              <summary>AI 的分析依据</summary>
              <ul>
                {plan.evidence.map((item, index) => (
                  <li key={index}>{item}</li>
                ))}
              </ul>
              <p>
                依据源码 <code>{draft.generatedDefinition.sourceCommit.slice(0, 8)}</code>
                ；读取代码不代表已经验证。
              </p>
            </details>
          </>
          {changes.length > 0 && (
            <div>
              <h4>与已保存方案相比</h4>
              <ul>
                {changes.map((change) => (
                  <li key={change}>{change}</li>
                ))}
              </ul>
            </div>
          )}
        </section>
      )}

      <section className="preparation-feedback" id="preparation-feedback">
        <Field
          label="告诉 AI 要调整什么（可选）"
          hint="只需描述业务期望，不用提供命令、SQL 或端口。不要填写密码或 Token。"
        >
          <textarea
            rows={3}
            maxLength={4096}
            value={requirements}
            disabled={locked}
            onChange={(event) => setRequirements(event.target.value)}
            placeholder="例如：需要测试完整网页；准备一个管理员身份；不要发送真实短信。"
          />
        </Field>
        <div className="form-actions">
          <Button
            type="button"
            variant="secondary"
            disabled={locked || !requirements.trim()}
            onClick={() => requestGeneration()}
          >
            按我的要求调整方案
          </Button>
        </div>
      </section>

      <section className="preparation-validation">
        <header className="settings-group-heading">
          <h4>实际验证结果</h4>
          <StatusLabel tone={passed ? 'success' : 'neutral'}>
            {validation
              ? validation.stale || editing !== null
                ? '历史结果 · 不代表当前草案'
                : {
                    running: '验证中',
                    passed: '已完成配置中的核验',
                    failed: '未通过',
                    cancelled: '已停止',
                  }[validation.status]
              : '尚未执行'}
          </StatusLabel>
        </header>
        {!validation && (
          <p>生成方案、上传文件或保存账号，都不代表环境已经可用。确认保存后才会实际验证。</p>
        )}
        {validation && (
          <>
            {validation.targetCommit && (
              <p>
                验证源码 <code>{validation.targetCommit.slice(0, 8)}</code>
                {validation.finishedAt
                  ? ` · ${new Date(validation.finishedAt).toLocaleString('zh-CN')}`
                  : ''}
              </p>
            )}
            <p>
              镜像与构建缓存按现有规则复用；容器和数据卷仍按本次测试隔离回收。阶段耗时包含实际操作等待，不是预计时间；数据库就绪等待可能发生在初始化脚本内。
            </p>
            <ol className="environment-validation-steps">
              {validation.steps.map((step, index) => (
                <li key={index}>
                  <span>
                    {ENVIRONMENT_STAGES[step.stage]} ·{' '}
                    {step.durationMs == null
                      ? step.status === 'running'
                        ? '计时中'
                        : '耗时未记录'
                      : step.durationMs < 1000
                        ? '不到 1 秒'
                        : `${(step.durationMs / 1000).toFixed(1)} 秒`}
                  </span>
                  <StatusLabel
                    tone={
                      step.status === 'passed'
                        ? 'success'
                        : step.status === 'failed'
                          ? 'danger'
                          : 'neutral'
                    }
                  >
                    {{ running: '进行中', passed: '通过', failed: '未通过' }[step.status]}
                  </StatusLabel>
                  {step.message && <p>{step.message}</p>}
                </li>
              ))}
            </ol>
            {(['data', 'account'] as const)
              .filter((kind) => !validation.steps.some((step) => step.stage === kind))
              .map((kind) => (
                <p key={kind}>
                  {kind === 'data' ? '必要测试数据' : '测试账号登录与身份'}：未验证。
                  {configuration.runtime.preparationChecks?.some((check) => check.kind === kind)
                    ? '尚未执行到该核验。'
                    : '当前方案未配置专门核验，可让 AI 补充。'}
                </p>
              ))}
            {validation.failure && <p role="alert">{validation.failure.message}</p>}
            {validation.status !== 'running' && (
              <p>
                {validation.cleanupConfirmed
                  ? '临时资源已清理；正式测试时会重新准备环境。'
                  : '资源清理尚未确认，恢复流程会继续核对。'}
              </p>
            )}
            {validation.failure && (
              <Button
                type="button"
                variant="secondary"
                disabled={locked}
                onClick={() => requestGeneration(true)}
              >
                让 AI 分析失败并提出修正
              </Button>
            )}
          </>
        )}
      </section>

      {(draft || editing !== null) && (
        <details className="settings-details preparation-technical">
          <summary>技术详情与高级编辑（通常无需修改）</summary>
          {draft && (
            <>
              <dl className="environment-summary">
                <div>
                  <dt>应用服务</dt>
                  <dd>{draft.runtime.applicationService}</dd>
                </div>
                <div>
                  <dt>依赖与工具</dt>
                  <dd>
                    {draft.runtime.composeServices
                      .filter((value) => value !== draft.runtime.applicationService)
                      .join('、') || '无额外服务'}
                  </dd>
                </div>
                <div>
                  <dt>测试命令位置</dt>
                  <dd>
                    {draft.runtime.commandService} · {draft.runtime.workingDirectory}
                  </dd>
                </div>
                <div>
                  <dt>端口 / 健康检查</dt>
                  <dd>
                    {draft.runtime.servicePort} · {draft.runtime.healthPath}
                  </dd>
                </div>
              </dl>
              <h4>初始化步骤</h4>
              <ol>
                {(draft.runtime.initializationSteps ?? []).map((step, index) => (
                  <li key={index}>
                    <details>
                      <summary>
                        {step.service} · 最长 {step.timeoutSeconds} 秒 · 查看命令
                      </summary>
                      <pre>{step.command}</pre>
                    </details>
                  </li>
                ))}
              </ol>
              {(draft.runtime.preparationChecks ?? []).map((check, index) => (
                <details key={index}>
                  <summary>{check.label} · 核验命令</summary>
                  <pre>{check.command}</pre>
                </details>
              ))}
              {managedFiles.length > 0 && (
                <>
                  <h4>已提供的文件</h4>
                  <ul>
                    {managedFiles.map((file) => (
                      <li key={file.path}>
                        <code>{file.path}</code> →{' '}
                        {file.serviceName ??
                          (file.purpose === 'data'
                            ? draft.runtime.commandService
                            : draft.runtime.applicationService)}
                      </li>
                    ))}
                  </ul>
                  <p>已上传不等于已使用，实际使用由初始化与配置引用决定。</p>
                </>
              )}
              <details>
                <summary>查看生成的配置文件（{draft.generatedDefinition.files.length}）</summary>
                {draft.generatedDefinition.files.map((file) => (
                  <details key={file.path}>
                    <summary>{file.path}</summary>
                    <pre>{file.content}</pre>
                  </details>
                ))}
              </details>
            </>
          )}
          <details>
            <summary>高级：查看 / 编辑原始 JSON</summary>
            {editing !== null && current && (
              <details>
                <summary>上次保存的配置</summary>
                <pre>{JSON.stringify(current, null, 2)}</pre>
              </details>
            )}
            <Field label="配置内容（JSON）">
              <textarea
                rows={18}
                disabled={locked}
                value={editing ?? JSON.stringify(current, null, 2)}
                onChange={(event) => setEditing(event.target.value)}
              />
            </Field>
          </details>
          {invalidJson && <p role="alert">JSON 格式或必要字段不完整，请修正后保存。</p>}
        </details>
      )}
      {confirmRegenerate !== null && (
        <ConfirmDialog
          open
          title="按反馈重新生成方案？"
          message="将参考 AI 原始草案和你的要求生成新方案；当前未保存的手动 JSON 编辑不会保留。已保存方案不变。"
          confirmLabel="重新生成"
          onClose={() => setConfirmRegenerate(null)}
          onConfirm={() => {
            const withFailure = confirmRegenerate;
            setConfirmRegenerate(null);
            generate(withFailure);
          }}
        />
      )}
    </section>
  );
}

function describeChanges(before: Draft, after: Draft): string[] {
  const labels: Record<string, string> = {
    workingDirectory: '工作目录',
    prepareCommand: '准备命令',
    startCommand: '启动命令',
    servicePort: '应用端口',
    healthPath: '健康检查路径',
    healthTimeoutSeconds: '健康检查等待时间',
    composeFile: 'Compose 文件',
    composeServices: '服务列表',
    applicationService: '应用服务',
    commandService: '测试工具服务',
    initializationSteps: '初始化步骤',
    preparationChecks: '数据与账号核验',
  };
  const changes = Object.entries(labels)
    .filter(
      ([key]) =>
        JSON.stringify(before.runtime[key as keyof Draft['runtime']]) !==
        JSON.stringify(after.runtime[key as keyof Draft['runtime']]),
    )
    .map(([, label]) => `调整${label}`);
  if (
    JSON.stringify(before.generatedDefinition.preparation) !==
    JSON.stringify(after.generatedDefinition.preparation)
  )
    changes.unshift('更新测试范围、数据或身份准备说明');
  for (const file of after.generatedDefinition.files) {
    const previous = before.generatedDefinition.files.find((entry) => entry.path === file.path);
    if (!previous) changes.push(`新增文件 ${file.path}`);
    else if (previous.content !== file.content) changes.push(`修改文件 ${file.path}`);
  }
  for (const file of before.generatedDefinition.files)
    if (!after.generatedDefinition.files.some((entry) => entry.path === file.path))
      changes.push(`移除文件 ${file.path}`);
  return changes;
}
