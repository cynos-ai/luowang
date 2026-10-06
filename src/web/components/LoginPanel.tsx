import type { FormEvent } from 'react';

import { Field } from './FormControls';
import { BrandLogo } from './ui';

export function LoginPanel({
  configured,
  password,
  busy,
  message,
  error,
  onPasswordChange,
  onSubmit,
  titleAsHeading1 = false,
}: {
  configured: boolean;
  password: string;
  busy: boolean;
  message: string;
  error: string;
  onPasswordChange: (value: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  titleAsHeading1?: boolean;
}) {
  const Title = titleAsHeading1 ? 'h1' : 'h2';
  return (
    <div className="login-layout">
      <section className="panel login-panel" aria-labelledby="login-title">
        <Title id="login-title" className="visually-hidden">
          管理员登录
        </Title>
        <div className="login-panel-brand">
          <BrandLogo tone="color" size="hero" />
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
