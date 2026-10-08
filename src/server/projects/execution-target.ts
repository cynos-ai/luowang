import type Database from 'better-sqlite3';
import type { ScopedSecretStore } from '../security/scoped-secret-store.js';
import {
  createLocalExecutionAdapter,
  createSshExecutionAdapter,
  type ExecutionAdapter,
} from './execution-adapter.js';

export async function createProjectExecutionAdapter(input: {
  database: Database.Database;
  secrets: ScopedSecretStore;
  locationId: string;
  revision: number;
}): Promise<ExecutionAdapter> {
  if (input.locationId.startsWith('local:')) return createLocalExecutionAdapter(input.locationId);
  const serverId = input.locationId.slice('server:'.length);
  const row = input.database
    .prepare('SELECT * FROM execution_servers WHERE server_id = ?')
    .get(serverId) as
    | {
        revision: number;
        host: string;
        port: number;
        username: string;
        host_fingerprint: string | null;
        health_status: string;
        auth_type: 'password' | 'private-key';
      }
    | undefined;
  if (
    !row ||
    row.revision !== input.revision ||
    row.health_status !== 'ready' ||
    !row.host_fingerprint
  )
    throw new Error('指定执行服务器未验证或修订已变化；禁止回退本机');
  const store = input.secrets.resource('execution-server', serverId);
  return createSshExecutionAdapter({
    locationId: input.locationId,
    host: row.host,
    port: row.port,
    username: row.username,
    pinnedFingerprint: row.host_fingerprint,
    password: row.auth_type === 'password' ? store.get('password') : undefined,
    privateKey: row.auth_type === 'private-key' ? store.get('privateKey') : undefined,
    passphrase: store.get('privateKeyPassphrase'),
  });
}
