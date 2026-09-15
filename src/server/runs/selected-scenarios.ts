import { createHash } from 'node:crypto';

import { redactCommandText } from './evidence.js';

export interface SelectedScenarioSource {
  readonly id: string;
  readonly path: string;
  readonly content: string;
}

export interface SelectedScenarioSnapshot {
  readonly targetCommit: string;
  readonly patchSha256: string | null;
  readonly scenarios: readonly (SelectedScenarioSource & {
    readonly sourceSha256: string;
    readonly contentSha256: string;
    readonly redacted: boolean;
  })[];
}

// A bounded, ephemeral view of Git + the validated patch, not another artifact owner.
export const MAX_SELECTED_SCENARIO_BYTES = 256 * 1024;

export function snapshotSelectedScenarios(
  targetCommit: string,
  patch: string | undefined,
  sources: readonly SelectedScenarioSource[],
  secrets: readonly string[],
): SelectedScenarioSnapshot {
  const hash = (text: string) => createHash('sha256').update(text).digest('hex');
  const invalid = () => new Error('选定场景原文无法完整、安全地提供');
  if (Buffer.byteLength(JSON.stringify(sources)) > MAX_SELECTED_SCENARIO_BYTES) throw invalid();
  const scenarios = sources.map((source) => {
    if (source.content.includes('\0') || source.content.includes('\uFFFD')) throw invalid();
    const clean = (text: string) => redactCommandText(text, secrets, Number.MAX_SAFE_INTEGER);
    // Identity cannot silently change during redaction.
    if (clean(source.id) !== source.id || clean(source.path) !== source.path) throw invalid();
    const content = clean(source.content);
    return Object.freeze({
      id: source.id,
      path: source.path,
      content,
      sourceSha256: hash(source.content),
      contentSha256: hash(content),
      redacted: content !== source.content,
    });
  });
  const snapshot = Object.freeze({
    targetCommit,
    patchSha256: patch === undefined ? null : hash(patch),
    scenarios: Object.freeze(scenarios),
  });
  if (Buffer.byteLength(JSON.stringify(snapshot)) > MAX_SELECTED_SCENARIO_BYTES) throw invalid();
  return snapshot;
}
