import { strict as assert } from 'node:assert';

import { describe, it } from 'vitest';

import {
  deleteProviderApiKey,
  getProviderApiKey,
  providerSecretMetadata,
  setProviderApiKey,
} from '../src/server/security/provider-secrets.js';
import type { SecretKey } from '../src/shared/types.js';

describe('provider source secrets', () => {
  it('migrates the legacy key into an encrypted multi-source envelope without exposing it', () => {
    let stored: string | undefined = 'legacy-key';
    const store = {
      get: (key: SecretKey) => (key === 'providerApiKey' ? stored : undefined),
      set: (_key: SecretKey, value: string) => {
        stored = value;
      },
      delete: () => {
        stored = undefined;
      },
    };

    assert.equal(getProviderApiKey(store, 'default'), 'legacy-key');
    assert.equal(getProviderApiKey(store, 'secondary'), undefined);
    setProviderApiKey(store, 'secondary', 'secondary-key');
    assert.equal(getProviderApiKey(store, 'default'), 'legacy-key');
    assert.equal(getProviderApiKey(store, 'secondary'), 'secondary-key');
    assert.deepEqual(providerSecretMetadata(store, ['default', 'secondary']), {
      default: { configured: true, masked: '••••••••' },
      secondary: { configured: true, masked: '••••••••' },
    });

    deleteProviderApiKey(store, 'default');
    assert.equal(getProviderApiKey(store, 'default'), undefined);
    assert.equal(getProviderApiKey(store, 'secondary'), 'secondary-key');
  });
});
