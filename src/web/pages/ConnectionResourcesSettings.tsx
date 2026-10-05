import { useCallback, useState, type FormEvent, type ReactNode } from 'react';

import { requestJson, toUserMessage } from '../api';
import { useResource } from '../app/resource';
import { AsyncRegion } from '../components/AsyncRegion';
import { useAppDialog } from '../components/AppDialogProvider';
import { useAppMessage } from '../components/AppMessageProvider';
import { Field, NumberInput, SelectBox } from '../components/FormControls';
import type {
  ConnectionResourcesResponse,
  ExecutionServer,
  GithubCredential,
} from '../project-types';

type ServerDraft = {
  name: string;
  host: string;
  port: string;
  username: string;
  authType: 'password' | 'private-key';
  password: string;
  privateKey: string;
  privateKeyPassphrase: string;
  capacity: number;
};

const emptyServer: ServerDraft = {
  name: '',
  host: '',
  port: '22',
  username: '',
  authType: 'private-key',
  password: '',
  privateKey: '',
  privateKeyPassphrase: '',
  capacity: 1,
};

export function ConnectionResourcesSettings({ kind }: { kind: 'github' | 'servers' }) {
  const notify = useAppMessage();
  const { confirm } = useAppDialog();
  const load = useCallback(
    (signal: AbortSignal) =>
      requestJson<ConnectionResourcesResponse>('/api/connection-resources', { signal }),
    [],
  );
  const resource = useResource('connection-resources', load, (cause) =>
    toUserMessage(cause, '连接资源读取失败'),
  );
  const [tokenId, setTokenId] = useState<string | null>(null);
  const [tokenName, setTokenName] = useState('');
  const [tokenValue, setTokenValue] = useState('');
  const [serverId, setServerId] = useState<string | null>(null);
  const [server, setServer] = useState<ServerDraft>(emptyServer);
  const [busy, setBusy] = useState('');

  async function perform(label: string, operation: () => Promise<unknown>, clear: () => void) {
    setBusy(label);
    try {
      await operation();
      clear();
      resource.reload();
      notify.success(`${label}完成`);
    } catch (cause) {
      notify.error(toUserMessage(cause, `${label}失败`));
    } finally {
      setBusy('');
    }
  }

  function editToken(item: GithubCredential) {
    setTokenId(item.id);
    setTokenName(item.name);
    setTokenValue('');
  }

  function editServer(item: ExecutionServer) {
    setServerId(item.id);
    setServer({
      name: item.name,
      host: item.host,
      port: String(item.port),
      username: item.username,
      authType: item.authType,
      password: '',
      privateKey: '',
      privateKeyPassphrase: '',
      capacity: item.capacity,
    });
  }

  return (
    <AsyncRegion
      loading={resource.loading && !resource.value}
      error={!resource.value ? resource.error : ''}
      onRetry={resource.reload}
    >
      <div className="connection-settings-stack">
        {kind === 'github' && (
          <ResourcePanel title="GitHub Token" description="命名保存后，可被多个项目安全复用。">
            <form
              className="form-grid resource-editor"
              onSubmit={(event: FormEvent) => {
                event.preventDefault();
                const editing = Boolean(tokenId);
                void perform(
                  editing ? '更新 Token' : '新增 Token',
                  () =>
                    requestJson(
                      editing
                        ? `/api/connection-resources/github/${encodeURIComponent(tokenId!)}`
                        : '/api/connection-resources/github',
                      {
                        method: editing ? 'PUT' : 'POST',
                        body: JSON.stringify({
                          name: tokenName,
                          ...(!editing || tokenValue ? { token: tokenValue } : {}),
                        }),
                      },
                    ),
                  () => {
                    setTokenId(null);
                    setTokenName('');
                    setTokenValue('');
                  },
                );
              }}
            >
              <Field label="名称">
                <input
                  required
                  maxLength={80}
                  value={tokenName}
                  onChange={(e) => setTokenName(e.target.value)}
                />
              </Field>
              <Field label="Token">
                <input
                  required={!tokenId}
                  type="password"
                  autoComplete="new-password"
                  placeholder={tokenId ? '已配置 · 留空保持原值' : '输入 Token'}
                  value={tokenValue}
                  onChange={(e) => setTokenValue(e.target.value)}
                />
              </Field>
              <EditorActions
                editing={Boolean(tokenId)}
                busy={Boolean(busy)}
                onCancel={() => {
                  setTokenId(null);
                  setTokenName('');
                  setTokenValue('');
                }}
              />
            </form>
            <ResourceList empty="尚未保存 Token">
              {resource.value?.githubCredentials.map((item) => (
                <ResourceRow
                  key={item.id}
                  title={item.name}
                  detail={item.configured ? '已安全保存' : '未配置'}
                >
                  <button
                    className="button button-secondary"
                    type="button"
                    onClick={() => editToken(item)}
                  >
                    编辑
                  </button>
                  <button
                    className="button button-danger"
                    type="button"
                    onClick={() =>
                      void (async () => {
                        if (
                          !(await confirm({
                            title: '删除 Token？',
                            message: `将删除“${item.name}”。已绑定项目会阻止删除。`,
                            confirmLabel: '确认删除',
                            danger: true,
                          }))
                        )
                          return;
                        await perform(
                          '删除 Token',
                          () =>
                            requestJson(
                              `/api/connection-resources/github/${encodeURIComponent(item.id)}`,
                              { method: 'DELETE' },
                            ),
                          () => {},
                        );
                      })()
                    }
                  >
                    删除
                  </button>
                </ResourceRow>
              ))}
            </ResourceList>
          </ResourcePanel>
        )}

        {kind === 'servers' && (
          <ResourcePanel
            title="执行服务器"
            description="确认主机指纹并通过 Docker、Compose 检查后，项目才会在这台服务器执行。"
          >
            <form
              className="form-grid resource-editor"
              onSubmit={(event) => {
                event.preventDefault();
                const editing = Boolean(serverId);
                void perform(
                  editing ? '更新服务器' : '新增服务器',
                  () =>
                    requestJson(
                      editing
                        ? `/api/connection-resources/servers/${encodeURIComponent(serverId!)}`
                        : '/api/connection-resources/servers',
                      {
                        method: editing ? 'PUT' : 'POST',
                        body: JSON.stringify({
                          name: server.name,
                          host: server.host,
                          port: Number(server.port),
                          username: server.username,
                          authType: server.authType,
                          capacity: server.capacity,
                          ...(server.password ? { password: server.password } : {}),
                          ...(server.privateKey ? { privateKey: server.privateKey } : {}),
                          ...(server.privateKeyPassphrase
                            ? { privateKeyPassphrase: server.privateKeyPassphrase }
                            : {}),
                        }),
                      },
                    ),
                  () => {
                    setServerId(null);
                    setServer(emptyServer);
                  },
                );
              }}
            >
              <Field label="名称">
                <input
                  required
                  value={server.name}
                  onChange={(e) => setServer({ ...server, name: e.target.value })}
                />
              </Field>
              <Field label="主机 / IP">
                <input
                  required
                  value={server.host}
                  onChange={(e) => setServer({ ...server, host: e.target.value })}
                />
              </Field>
              <Field label="SSH 端口">
                <NumberInput
                  required
                  ariaLabel="SSH 端口"
                  min={1}
                  max={65535}
                  step={1}
                  value={Number(server.port)}
                  onChange={(value) => setServer({ ...server, port: String(value) })}
                />
              </Field>
              <Field label="用户">
                <input
                  required
                  value={server.username}
                  onChange={(e) => setServer({ ...server, username: e.target.value })}
                />
              </Field>
              <Field label="并发项目数">
                <NumberInput
                  ariaLabel="并发项目数"
                  min={1}
                  max={64}
                  step={1}
                  value={server.capacity}
                  onChange={(capacity) => setServer({ ...server, capacity })}
                />
              </Field>
              <Field label="认证方式">
                <SelectBox
                  ariaLabel="认证方式"
                  value={server.authType}
                  options={[
                    { value: 'private-key', label: 'SSH 私钥' },
                    { value: 'password', label: '密码' },
                  ]}
                  onChange={(value) =>
                    setServer({ ...server, authType: value as ServerDraft['authType'] })
                  }
                />
              </Field>
              {server.authType === 'password' ? (
                <Field label="密码">
                  <input
                    required={!serverId}
                    type="password"
                    autoComplete="new-password"
                    placeholder={serverId ? '已配置 · 留空保持原值' : ''}
                    value={server.password}
                    onChange={(e) => setServer({ ...server, password: e.target.value })}
                  />
                </Field>
              ) : (
                <>
                  <Field label="SSH 私钥">
                    <textarea
                      required={!serverId}
                      placeholder={
                        serverId ? '已配置 · 留空保持原值' : '-----BEGIN OPENSSH PRIVATE KEY-----'
                      }
                      value={server.privateKey}
                      onChange={(e) => setServer({ ...server, privateKey: e.target.value })}
                    />
                  </Field>
                  <Field label="私钥口令（选填）">
                    <input
                      type="password"
                      autoComplete="new-password"
                      value={server.privateKeyPassphrase}
                      onChange={(e) =>
                        setServer({ ...server, privateKeyPassphrase: e.target.value })
                      }
                    />
                  </Field>
                </>
              )}
              <EditorActions
                editing={Boolean(serverId)}
                busy={Boolean(busy)}
                onCancel={() => {
                  setServerId(null);
                  setServer(emptyServer);
                }}
              />
            </form>
            <ResourceList empty="尚未配置执行服务器">
              {resource.value?.executionServers.map((item) => (
                <ResourceRow
                  key={item.id}
                  title={item.name}
                  detail={`${item.username}@${item.host}:${item.port} · 容量 ${item.capacity} · ${item.healthStatus === 'ready' ? '已验证' : item.healthStatus === 'changed' ? '主机指纹已变化' : '待验证'}`}
                >
                  <button
                    className="button button-secondary"
                    type="button"
                    disabled={Boolean(busy)}
                    onClick={() =>
                      void perform(
                        '读取主机指纹',
                        async () => {
                          const result = await requestJson<{
                            fingerprint: string;
                            confirmed: boolean;
                          }>(
                            `/api/connection-resources/servers/${encodeURIComponent(item.id)}/fingerprint`,
                            { method: 'POST' },
                          );
                          if (result.confirmed) {
                            notify.info?.('主机指纹与已确认值一致');
                            return;
                          }
                          if (
                            !(await confirm({
                              title: item.hostFingerprint
                                ? '主机指纹已变化'
                                : '确认 SSH 主机指纹？',
                              message: `${item.name} · ${result.fingerprint}\n请与服务器管理员提供的指纹核对。`,
                              confirmLabel: '指纹一致，确认',
                              danger: Boolean(item.hostFingerprint),
                            }))
                          )
                            return;
                          await requestJson(
                            `/api/connection-resources/servers/${encodeURIComponent(item.id)}/fingerprint`,
                            {
                              method: 'PUT',
                              body: JSON.stringify({ fingerprint: result.fingerprint }),
                            },
                          );
                        },
                        () => {},
                      )
                    }
                  >
                    核对指纹
                  </button>
                  <button
                    className="button button-secondary"
                    type="button"
                    disabled={Boolean(busy) || !item.hostFingerprint}
                    onClick={() =>
                      void perform(
                        '检查执行服务器',
                        () =>
                          requestJson(
                            `/api/connection-resources/servers/${encodeURIComponent(item.id)}/check`,
                            { method: 'POST' },
                          ),
                        () => {},
                      )
                    }
                  >
                    检查
                  </button>
                  <button
                    className="button button-secondary"
                    type="button"
                    onClick={() => editServer(item)}
                  >
                    编辑
                  </button>
                  <button
                    className="button button-danger"
                    type="button"
                    onClick={() =>
                      void (async () => {
                        if (
                          !(await confirm({
                            title: '删除服务器？',
                            message: `将删除“${item.name}”。已绑定项目会阻止删除。`,
                            confirmLabel: '确认删除',
                            danger: true,
                          }))
                        )
                          return;
                        await perform(
                          '删除服务器',
                          () =>
                            requestJson(
                              `/api/connection-resources/servers/${encodeURIComponent(item.id)}`,
                              { method: 'DELETE' },
                            ),
                          () => {},
                        );
                      })()
                    }
                  >
                    删除
                  </button>
                </ResourceRow>
              ))}
            </ResourceList>
          </ResourcePanel>
        )}
      </div>
    </AsyncRegion>
  );
}

function ResourcePanel({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <section className="settings-panel resource-panel">
      <header>
        <h2>{title}</h2>
        <p>{description}</p>
      </header>
      {children}
    </section>
  );
}
function ResourceList({ empty, children }: { empty: string; children: ReactNode }) {
  return <div className="resource-list">{children || <p className="muted-copy">{empty}</p>}</div>;
}
function ResourceRow({
  title,
  detail,
  children,
}: {
  title: string;
  detail: string;
  children: ReactNode;
}) {
  return (
    <article className="resource-row">
      <div>
        <strong>{title}</strong>
        <span>{detail}</span>
      </div>
      <div className="row-actions">{children}</div>
    </article>
  );
}
function EditorActions({
  editing,
  busy,
  onCancel,
}: {
  editing: boolean;
  busy: boolean;
  onCancel: () => void;
}) {
  return (
    <div className="row-actions">
      <button className="button" type="submit" disabled={busy}>
        {editing ? '保存修改' : '新增'}
      </button>
      {editing && (
        <button className="button button-secondary" type="button" onClick={onCancel}>
          取消
        </button>
      )}
    </div>
  );
}
