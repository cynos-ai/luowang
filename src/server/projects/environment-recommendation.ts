import type Database from 'better-sqlite3';
import { createProjectAutomationStateStore } from '../automation/state.js';
import { generatedDefinitionHash, type GeneratedDefinition } from './generated-definition.js';

const KEY = 'environment.update-recommendation';
export type EnvironmentRecommendation = {
  runId: string;
  targetCommit: string;
  reason: string;
  definitionHash: string;
};

export function recordEnvironmentRecommendation(
  database: Database.Database,
  projectId: string,
  definition: GeneratedDefinition,
  value: Omit<EnvironmentRecommendation, 'definitionHash'>,
) {
  createProjectAutomationStateStore(database, projectId).set(
    KEY,
    JSON.stringify({
      ...value,
      definitionHash: `${generatedDefinitionHash(definition)}:${definition.sourceCommit}`,
    }),
  );
}

export function readEnvironmentRecommendation(
  database: Database.Database,
  projectId: string,
  definition: GeneratedDefinition | null | undefined,
): EnvironmentRecommendation | null {
  if (!definition) return null;
  const raw = createProjectAutomationStateStore(database, projectId).get(KEY);
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as EnvironmentRecommendation;
    return value.definitionHash ===
      `${generatedDefinitionHash(definition)}:${definition.sourceCommit}`
      ? value
      : null;
  } catch {
    return null;
  }
}
