import type { FormEvent } from 'react';

import { Field } from './FormControls';

export function LoginPanel({
  configured,
  password,
  busy,
  message,
  error,
  onPasswordChange,
  onSubmit,
}: {
  configured: boolean;
  password: string;
  busy: boolean;
  message: string;
  error: string;
  onPasswordChange: (value: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  return (
    <div className="login-layout">
      <section className="panel login-panel" aria-labelledby="login-title">
        <div className="login-heading">
          <p className="eyebrow">SECURE CONSOLE</p>
          <h2 id="login-title">管理员登录</h2>
          <p>登录后配置项目依赖、发起测试并查看实时进展。</p>
        </div>
        {!configured && (
          <p className="notice notice-warning">
            尚未配置管理员初始密码。请通过 LUOWANG_ADMIN_PASSWORD
            设置长随机密码后重启服务；不会提供匿名设密入口。
          </p>
        )}
        {message && <p className="notice notice-success">{message}</p>}
        {error && <p className="notice notice-error">{error}</p>}
        <form className="login-form" onSubmit={onSubmit}>
          <Field label="管理员密码">
            <input
              type="password"
              autoFocus
              autoComplete="current-password"
              value={password}
              onChange={(event) => onPasswordChange(event.target.value)}
              placeholder="输入管理员密码"
            />
          </Field>
          <button
            className="button login-button"
            type="submit"
            aria-label="登录"
            disabled={busy || !configured}
          >
            {busy ? '登录中…' : '登录控制台'}
          </button>
        </form>
      </section>
    </div>
  );
}
