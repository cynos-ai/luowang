import { useEffect, useRef, useState } from 'react';
import type { OperationsQueueItem, OperationsRunDetail } from '../../shared/types';
import { diagnoseRun } from '../../shared/run-diagnostics';
import { requestJson, toUserMessage } from '../api';
import { AppLink } from '../app/navigation';
import { AppMessageFeedback } from './AppMessageProvider';
import { ConfirmDialog } from './ConfirmDialog';

export function RunFollowupActions({
  projectId,
  run,
  queue,
  onChanged,
}: {
  projectId: string;
  run: OperationsRunDetail;
  queue: OperationsQueueItem | null;
  onChanged: () => void;
}) {
  const identity = `${projectId}:${run.runId}`;
  const current = useRef(identity);
  current.current = identity;
  const epoch = useRef(0);
  const inFlight = useRef(false);
  const token = useRef<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    epoch.current++;
    current.current = identity;
    inFlight.current = false;
    token.current = null;
    setConfirm(false);
    setPending(false);
    setMessage('');
    setError('');
    return () => {
      epoch.current++;
      current.current = '';
    };
  }, [identity]);
  const problems = diagnoseRun(run, queue);
  const terminal = ['completed', 'failed', 'interrupted'].includes(run.status);
  const retryable =
    queue?.status === 'completed' && ['failed', 'partial'].includes(queue.archiveStatus ?? '');
  async function perform(action: 'retest' | 'archive/retry' | 'recheck') {
    if (inFlight.current) return;
    inFlight.current = true;
    setPending(true);
    setError('');
    const submitted = identity;
    const generation = epoch.current;
    const valid = () => current.current === submitted && epoch.current === generation;
    try {
      if (action === 'retest' && !token.current) token.current = crypto.randomUUID();
      const result = await requestJson<{ queue?: OperationsQueueItem }>(
        action === 'recheck'
          ? `/api/projects/${projectId}/readiness/check`
          : `/api/projects/${projectId}/runs/${run.runId}/${action}`,
        {
          method: 'POST',
          body: JSON.stringify(
            action === 'retest' ? { confirmed: true, idempotencyKey: token.current } : {},
          ),
        },
      );
      if (!valid()) return;
      setConfirm(false);
      setMessage(
        action === 'retest'
          ? `已创建关联请求 #${result.queue?.queueId}，认领时固定当前场景分支提交。`
          : action === 'archive/retry'
            ? `归档重试已结束：${result.queue?.archiveStatus ?? '请刷新查看'}；原测试结论保持。`
            : '依赖检查已完成，请查看项目检查结果；本 Run 的历史结论保持。',
      );
      if (action === 'retest') token.current = null;
      onChanged();
    } catch (cause) {
      if (valid()) setError(toUserMessage(cause, '操作失败，请核对当前状态后重试'));
    } finally {
      if (valid()) {
        inFlight.current = false;
        setPending(false);
      }
    }
  }
  return (
    <section className="content-block" aria-label="问题与后续处理">
      <h2>问题与后续处理</h2>
      {problems.map((problem, index) => (
        <div key={`${problem.kind}:${index}`} className="notice notice-warning">
          <p>{problem.message}</p>
          <p>
            来源：
            {
              {
                harness: '系统记录',
                reviewer: 'Reviewer 审核',
                administrator: '管理员操作',
                'historical-unknown': '记录未提供机器原因',
              }[problem.source]
            }{' '}
            · 首次观察：{problem.firstObservedAt ?? '未知'} · 最近观察：
            {problem.lastObservedAt ?? '未知'}
          </p>
        </div>
      ))}
      {!problems.length && <p>当前没有已记录的问题。运行、正式结论与归档分别以下方事实为准。</p>}
      <div className="form-actions">
        {terminal && (
          <button
            className="button button-primary"
            type="button"
            disabled={pending}
            onClick={() => {
              setError('');
              setConfirm(true);
            }}
          >
            重新测试当前版本
          </button>
        )}
        {retryable && (
          <button
            className="button button-secondary"
            type="button"
            disabled={pending}
            onClick={() => void perform('archive/retry')}
          >
            重试归档
          </button>
        )}
        {terminal && problems.length > 0 && (
          <button
            className="button button-secondary"
            type="button"
            disabled={pending}
            onClick={() => void perform('recheck')}
          >
            重新检查条件
          </button>
        )}
        <AppLink to={{ name: 'project-readiness', projectId }}>查看项目检查</AppLink>
        <AppLink to={{ name: 'project-settings', projectId, section: 'environment' }}>
          项目环境配置
        </AppLink>
      </div>
      <AppMessageFeedback success={message} error={!confirm ? error : ''} />
      {confirm && (
        <ConfirmDialog
          open
          title="确认重新测试当前版本"
          error={error}
          message={`项目 ${projectId}，来源 Run ${run.runId}，原 target ${run.targetCommit ?? '未知'}。创建新请求并在认领时固定当前场景分支提交，版本或配置可能已变化；不会覆盖原报告，也不会重复原来源分支合并。`}
          confirmLabel={pending ? '正在提交…' : '创建新测试'}
          onConfirm={() => void perform('retest')}
          onClose={() => {
            if (!pending) setConfirm(false);
          }}
        />
      )}
    </section>
  );
}
