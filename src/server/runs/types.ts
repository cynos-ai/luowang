import type {
  AgentConfig,
  EvidenceReference,
  RepositoryIssue,
  RunPhase,
  RunSummary,
  RunTrigger,
  ScenarioMode,
} from '../../shared/types.js';
import type { InlineExtension, ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { ScenarioPatchValidation } from '../repository/scenario-patch.js';

export type AgentRole = 'main-a' | 'runner' | 'reviewer' | 'main-b';

export const RUN_ARTIFACT_NAMES = [
  'plan.md',
  'execution.md',
  'draft-report.md',
  'review.md',
  'report.md',
] as const;

export const SCENARIO_PATCH_ARTIFACT_NAME = 'scenario-changes.patch' as const;

export type RunArtifactName =
  (typeof RUN_ARTIFACT_NAMES)[number] | typeof SCENARIO_PATCH_ARTIFACT_NAME;

export interface RunInput {
  request: string;
  trigger: RunTrigger;
  targetCommit?: string;
  initialization?: boolean;
}

export interface RunContext {
  runId: string;
  request: string;
  trigger: RunTrigger;
  baseCommit: string | null;
  targetCommit: string;
  includedCommits: string[];
  repositoryDirectory: string;
  runDirectory: string;
  historyIssues: RepositoryIssue[];
  historyIssuesAvailable: boolean;
  evidence: EvidenceReference[];
  blockingReasons: string[];
  browserRequired: boolean;
  scenarioMode: ScenarioMode;
  initialization: boolean;
  scenarioChanges?: ScenarioPatchValidation;
}

export interface AgentSessionInput {
  role: AgentRole;
  config: AgentConfig;
  cwd: string;
  toolNames: string[];
  customTools: ToolDefinition[];
  systemPrompt: string;
  extensionFactories?: InlineExtension[];
}

export interface AgentSession {
  prompt(message: string): Promise<void>;
  dispose(): void | Promise<void>;
}

export interface AgentSessionFactory {
  create(input: AgentSessionInput): Promise<AgentSession>;
}

export interface RunSnapshot extends RunSummary {
  completedDirectory: string | null;
  runningDirectory: string | null;
}

export interface RunDetailSnapshot extends RunSnapshot {
  artifacts: Record<string, string>;
}

export interface RunState extends RunSnapshot {
  completion?: Promise<void>;
}

export type RunProgressListener = (run: RunSnapshot) => void;

export type RunPhaseValue = RunPhase;
