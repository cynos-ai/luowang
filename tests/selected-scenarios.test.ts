import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import {
  MAX_SELECTED_SCENARIO_BYTES,
  snapshotSelectedScenarios,
} from '../src/server/runs/selected-scenarios.js';

const target = 'a'.repeat(40);
const source = {
  id: 'AUTH-001',
  path: 'docs/scenario-testing/scenarios/AUTH-001.md',
  content: '## 期望\n数据库不保存明文密码。\n',
};
const hash = (value: string) => createHash('sha256').update(value).digest('hex');

describe('selected scenario source view', () => {
  it('preserves complete text and provenance independently of later source mutation', () => {
    const original = { ...source };
    const snapshot = snapshotSelectedScenarios(target, 'validated patch\n', [original], []);
    original.content = 'weaker expectation';
    expect(snapshot.targetCommit).toBe(target);
    expect(snapshot.patchSha256).toBe(hash('validated patch\n'));
    expect(snapshot.scenarios[0]).toEqual({
      ...source,
      sourceSha256: hash(source.content),
      contentSha256: hash(source.content),
      redacted: false,
    });
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.scenarios)).toBe(true);
    expect(Object.isFrozen(snapshot.scenarios[0])).toBe(true);
  });

  it('distinguishes a valid empty selection and no patch from a missing snapshot', () => {
    expect(snapshotSelectedScenarios(target, undefined, [], [])).toEqual({
      targetCommit: target,
      patchSha256: null,
      scenarios: [],
    });
  });

  it('redacts credential representations without claiming unchanged bytes', () => {
    const secret = 'private-fixture/value';
    const content = `## 期望\n${secret}\n${encodeURIComponent(secret)}\npassword: hidden-value\n`;
    const snapshot = snapshotSelectedScenarios(
      target,
      undefined,
      [{ ...source, content }],
      [secret],
    );
    const delivered = snapshot.scenarios[0]!;
    expect(delivered.content).not.toContain(secret);
    expect(delivered.content).not.toContain(encodeURIComponent(secret));
    expect(delivered.content).not.toContain('hidden-value');
    expect(delivered.redacted).toBe(true);
    expect(delivered.sourceSha256).toBe(hash(content));
    expect(delivered.contentSha256).toBe(hash(delivered.content));
    expect(delivered.sourceSha256).not.toBe(delivered.contentSha256);
  });

  it('rejects identity redaction with a fixed diagnostic containing no input', () => {
    expect(() => snapshotSelectedScenarios(target, undefined, [source], ['AUTH-001'])).toThrow(
      '选定场景原文无法完整、安全地提供',
    );
  });

  it.each(['\0', '\uFFFD'])('rejects invalid or undecodable text %j', (character) => {
    expect(() =>
      snapshotSelectedScenarios(target, undefined, [{ ...source, content: character }], []),
    ).toThrow('选定场景原文无法完整、安全地提供');
  });

  it('rejects oversized text and JSON expansion rather than truncating', () => {
    for (const text of ['a', '\t']) {
      expect(() =>
        snapshotSelectedScenarios(
          target,
          undefined,
          [{ ...source, content: text.repeat(MAX_SELECTED_SCENARIO_BYTES) }],
          [],
        ),
      ).toThrow('选定场景原文无法完整、安全地提供');
    }
  });
});
