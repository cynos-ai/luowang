import { strict as assert } from 'node:assert';

import { it } from 'vitest';

import { hasUnsavedAccountChanges } from '../src/web/pages/AccountSettingsPage.js';

it('does not mark browser-filled current password as an unsaved account change', () => {
  assert.equal(
    hasUnsavedAccountChanges({ displayName: null, newPassword: '', confirmation: '' }),
    false,
  );
  assert.equal(
    hasUnsavedAccountChanges({ displayName: '管理员', newPassword: '', confirmation: '' }),
    true,
  );
  assert.equal(
    hasUnsavedAccountChanges({ displayName: null, newPassword: 'new-password', confirmation: '' }),
    true,
  );
});
