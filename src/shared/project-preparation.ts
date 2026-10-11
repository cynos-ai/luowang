/** Human-readable intentions, never execution evidence or credentials. */
export type PreparationPlan = {
  scope: string;
  data: string;
  account: { mode: 'none' | 'provided' | 'generated'; description: string };
  externalServices: string;
  decisions: string[];
  evidence: string[];
};

export type PreparationInput = {
  item: string;
  reason: string;
  destination?: 'decision' | 'data' | 'files' | 'account';
};

export type PreparationCheck = {
  kind: 'data' | 'account';
  label: string;
  service: string;
  command: string;
  timeoutSeconds: number;
};

/** Frozen, user-approved intentions. No scripts or secrets; never proof of execution. */
export type RunTestPreparation = {
  sourceCommit: string;
  plan: PreparationPlan;
};

/** Relative to the command service's private source root; never a build input. */
export const TEST_ACCOUNT_FILE = '.luowang-runtime/test-account.json';
