import { useEffect, useRef, useState } from 'react';
import { requestJson, toUserMessage } from '../api';
import { ConfirmDialog } from './ConfirmDialog';
import { AppMessageFeedback } from './AppMessageProvider';

export function StopRequestButton({
  projectId,
  queueId,
  runId,
  queued,
  requested,
  onChanged,
}: {
  projectId: string;
  queueId: number;
  runId: string | null;
  queued: boolean;
  requested?: string | null;
  onChanged: () => void;
}) {
  const [confirm, setConfirm] = useState(false);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const inFlight = useRef(false);
  const identity = `${projectId}:${queueId}`;
  const current = useRef(identity);
  current.current = identity;
  useEffect(() => {
    current.current = identity;
    setConfirm(false);
    setPending(false);
    setMessage('');
    setError('');
    inFlight.current = false;
    return () => {
      current.current = '';
    };
  }, [identity]);
  async function stop() {
    if (inFlight.current) return;
    inFlight.current = true;
    setPending(true);
    setError('');
    const submitted = identity;
    try {
      const result = await requestJson<{
        queue: { status: string; stopRequestedAt?: string | null };
      }>(`/api/projects/${projectId}/queue/${queueId}/stop`, {
        method: 'POST',
        body: JSON.stringify({ confirmed: true }),
      });
      if (current.current !== submitted) return;
      setConfirm(false);
      setMessage(
        result.queue.stopRequestedAt
          ? '停止请求已记录；实际退出与清理状态会继续更新。'
          : '本次测试已结束执行，保留原结果并继续归档。',
      );
      onChanged();
    } catch (cause) {
      if (current.current === submitted) setError(toUserMessage(cause, '停止请求失败'));
    } finally {
      if (current.current === submitted) {
        setPending(false);
        inFlight.current = false;
      }
    }
  }
  return (
    <div className="stop-request">
      <button
        type="button"
        className="button button-secondary"
        disabled={pending || Boolean(requested)}
        onClick={() => setConfirm(true)}
      >
        {requested ? '正在停止与收尾' : queued ? '取消排队' : '停止本次测试'}
      </button>
      <AppMessageFeedback success={message} error={!confirm ? error : ''} />
      {confirm && (
        <ConfirmDialog
          open
          danger
          error={error}
          title={queued ? '确认取消排队' : '确认停止本次测试'}
          message={`项目 ${projectId}，请求 #${queueId}${runId ? `，Run ${runId}` : '，尚未创建 Run'}。只停止本请求，保留已有操作和证据；本项目后续队列仍可能继续，其他项目不受影响。`}
          confirmLabel={pending ? '正在提交…' : '确认停止'}
          onConfirm={() => void stop()}
          onClose={() => {
            if (!pending) setConfirm(false);
          }}
        />
      )}
    </div>
  );
}
