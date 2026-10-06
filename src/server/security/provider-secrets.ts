import type { SecretKey } from '../../shared/types.js';

interface ProviderSecretAccess {
  get(key: SecretKey): string | undefined;
  set?(key: SecretKey, value: string): void;
  delete?(key: SecretKey): void;
}

interface ProviderSecretEnvelope {
  version: 1;
  keys: Record<string, string>;
}

const SOURCE_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;

export function getProviderApiKey(
  store: ProviderSecretAccess,
  sourceId: string,
): string | undefined {
  const raw = store.get('providerApiKey');
  if (!raw) return undefined;
  const envelope = parseEnvelope(raw);
  if (envelope) return envelope.keys[sourceId];
  return sourceId === 'default' ? raw : undefined;
}

export function providerSecretMetadata(
  store: ProviderSecretAccess,
  sourceIds: string[],
): Record<string, { configured: boolean; masked: string | null }> {
  return Object.fromEntries(
    sourceIds.map((sourceId) => {
      const configured = Boolean(getProviderApiKey(store, sourceId));
      return [sourceId, { configured, masked: configured ? '••••••••' : null }];
    }),
  );
}

export function setProviderApiKey(
  store: ProviderSecretAccess,
  sourceId: string,
  value: string,
): void {
  assertMutable(store, sourceId);
  if (!value) return;
  const keys = readKeys(store);
  keys[sourceId] = value;
  store.set(
    'providerApiKey',
    JSON.stringify({ version: 1, keys } satisfies ProviderSecretEnvelope),
  );
}

export function deleteProviderApiKey(store: ProviderSecretAccess, sourceId: string): void {
  assertMutable(store, sourceId);
  const keys = readKeys(store);
  delete keys[sourceId];
  if (Object.keys(keys).length === 0) store.delete('providerApiKey');
  else
    store.set(
      'providerApiKey',
      JSON.stringify({ version: 1, keys } satisfies ProviderSecretEnvelope),
    );
}

function readKeys(store: ProviderSecretAccess): Record<string, string> {
  const raw = store.get('providerApiKey');
  if (!raw) return {};
  const envelope = parseEnvelope(raw);
  return envelope ? { ...envelope.keys } : { default: raw };
}

function parseEnvelope(raw: string): ProviderSecretEnvelope | undefined {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
    const record = parsed as Record<string, unknown>;
    if (record.version !== 1 || !record.keys || typeof record.keys !== 'object') return undefined;
    const keys = Object.fromEntries(
      Object.entries(record.keys as Record<string, unknown>).filter(
        (entry): entry is [string, string] =>
          SOURCE_ID.test(entry[0]) && typeof entry[1] === 'string',
      ),
    );
    return { version: 1, keys };
  } catch {
    return undefined;
  }
}

function assertMutable(
  store: ProviderSecretAccess,
  sourceId: string,
): asserts store is Required<ProviderSecretAccess> {
  if (!SOURCE_ID.test(sourceId)) throw new TypeError('模型来源 ID 无效');
  if (!store.set || !store.delete) throw new TypeError('Provider Secret Store 只读');
}
