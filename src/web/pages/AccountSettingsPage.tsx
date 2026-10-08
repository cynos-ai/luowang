import { useCallback, useState, type FormEvent } from 'react';

import { requestJson, toUserMessage } from '../api';
import { useNavigationBlocker } from '../app/navigation';
import { useResource } from '../app/resource';
import { AsyncRegion } from '../components/AsyncRegion';
import { AppMessageFeedback } from '../components/AppMessageProvider';
import { Field } from '../components/FormControls';
import { PageHeading } from '../components/PageHeading';

export function AccountSettingsPage({ onPasswordChanged }: { onPasswordChanged: () => void }) {
  return (
    <section className="page-content account-settings-page">
      <PageHeading title="账号设置" scope="管理员" />
      <div className="page-body account-settings-layout">
        <AccountSettingsContent onPasswordChanged={onPasswordChanged} />
      </div>
    </section>
  );
}

export function AccountSettingsContent({ onPasswordChanged }: { onPasswordChanged: () => void }) {
  const load = useCallback(
    (signal: AbortSignal) =>
      requestJson<{ profile: { displayName: string } | null }>('/api/account', { signal }),
    [],
  );
  const resource = useResource('account-settings', load, (cause) =>
    toUserMessage(cause, '账号资料读取失败'),
  );
  const [displayName, setDisplayName] = useState<string | null>(null);
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [busy, setBusy] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const name = displayName ?? resource.value?.profile?.displayName ?? '管理员';
  const dirty = hasUnsavedAccountChanges({ displayName, newPassword, confirmation });
  const blocker = useCallback(() => {
    if (busy) return false;
    if (!dirty) return null;
    return {
      title: '放弃未保存修改？',
      message: '当前页面的修改尚未保存。离开后，这些修改将丢失。',
      confirmLabel: '放弃修改',
      cancelLabel: '继续编辑',
      danger: true,
    };
  }, [busy, dirty]);
  useNavigationBlocker(dirty || Boolean(busy) ? blocker : null);

  async function saveProfile(event: FormEvent) {
    event.preventDefault();
    setBusy('profile');
    setMessage('');
    setError('');
    try {
      const response = await requestJson<{ profile: { displayName: string } }>('/api/account', {
        method: 'PUT',
        body: JSON.stringify({ displayName: name }),
      });
      setDisplayName(null);
      resource.reload();
      window.dispatchEvent(new CustomEvent('luowang:profile-changed'));
      setMessage(`显示名称已更新为“${response.profile.displayName}”。`);
    } catch (cause) {
      setError(toUserMessage(cause, '显示名称更新失败'));
    } finally {
      setBusy('');
    }
  }

  async function changePassword(event: FormEvent) {
    event.preventDefault();
    setMessage('');
    setError('');
    if (newPassword !== confirmation) {
      setError('两次输入的新密码不一致');
      return;
    }
    if (newPassword.length < 6 || newPassword.length > 128) {
      setError('新密码长度必须在 6 到 128 个字符之间');
      return;
    }
    setBusy('password');
    try {
      await requestJson('/api/auth/password', {
        method: 'POST',
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      setCurrentPassword('');
      setNewPassword('');
      setConfirmation('');
      onPasswordChanged();
    } catch (cause) {
      setError(toUserMessage(cause, '密码更新失败'));
    } finally {
      setBusy('');
    }
  }

  return (
    <>
      <AppMessageFeedback success={message} error={error} />
      <AsyncRegion
        loading={resource.loading && !resource.value}
        error={!resource.value ? resource.error : ''}
        onRetry={resource.reload}
      >
        {resource.value && (
          <>
            <form className="content-block settings-form" onSubmit={saveProfile}>
              <div className="content-block-heading">
                <h2>显示名称</h2>
              </div>
              <Field label="管理员显示名称">
                <input
                  required
                  maxLength={64}
                  disabled={Boolean(busy)}
                  value={name}
                  onChange={(event) => setDisplayName(event.target.value)}
                />
              </Field>
              <div className="settings-actions">
                <button
                  className="button button-primary"
                  type="submit"
                  disabled={Boolean(busy) || displayName === null}
                >
                  {busy === 'profile' ? '保存中…' : '保存显示名称'}
                </button>
              </div>
            </form>
            <form className="content-block settings-form" onSubmit={changePassword}>
              <div className="content-block-heading">
                <h2>更换密码</h2>
              </div>
              <Field label="当前密码">
                <input
                  required
                  type="password"
                  autoComplete="current-password"
                  disabled={Boolean(busy)}
                  value={currentPassword}
                  onChange={(event) => setCurrentPassword(event.target.value)}
                />
              </Field>
              <Field label="新密码">
                <input
                  required
                  type="password"
                  minLength={12}
                  maxLength={128}
                  placeholder="6–128 个字符"
                  autoComplete="new-password"
                  disabled={Boolean(busy)}
                  value={newPassword}
                  onChange={(event) => setNewPassword(event.target.value)}
                />
              </Field>
              <Field label="确认新密码">
                <input
                  required
                  type="password"
                  minLength={12}
                  maxLength={128}
                  autoComplete="new-password"
                  disabled={Boolean(busy)}
                  value={confirmation}
                  onChange={(event) => setConfirmation(event.target.value)}
                />
              </Field>
              <div className="settings-actions">
                <button className="button button-danger" type="submit" disabled={Boolean(busy)}>
                  {busy === 'password' ? '更新并退出中…' : '更新密码并退出'}
                </button>
              </div>
            </form>
          </>
        )}
      </AsyncRegion>
    </>
  );
}

export function hasUnsavedAccountChanges(input: {
  displayName: string | null;
  newPassword: string;
  confirmation: string;
}): boolean {
  return input.displayName !== null || Boolean(input.newPassword || input.confirmation);
}
