import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { loadConfig } from '../../../src/server/config.ts';
import { initializeDatabase } from '../../../src/server/db/migrate.ts';
import { createConfigurationStore } from '../../../src/server/configuration.ts';
import { createSecretStore } from '../../../src/server/security/secret-store.ts';
import { createProviderAdapter } from '../../../src/server/runs/provider.ts';
import { createPiAgentSessionFactory } from '../../../src/server/runs/agent-session.ts';
import { createRunOrchestrator } from '../../../src/server/runs/orchestrator.ts';
import { RunWorkspace, createRunId } from '../../../src/server/runs/workspace.ts';
import { createRunEvidenceStore } from '../../../src/server/runs/evidence.ts';
import { snapshotSelectedScenarios } from '../../../src/server/runs/selected-scenarios.ts';
import {
  parseExecutionScenarioPlan,
  validateExecutionScenarioPlan,
} from '../../../src/server/runs/execution-plan.ts';
import {
  parseScenarioMarkdown,
  parseReportMarkdown,
} from '../../../src/server/repository/markdown.ts';
import { localEvidenceTransport } from '../local-evidence.ts';
import { sha } from './control.mjs';

// Deliberately calls the production stage entry points without starting the queue or archiver.
// No target repository, browser, Issue writer, or remote OSS adapter is installed.
export async function runCase(input, out, { live = false, baseUrl, apiKey } = {}) {
  mkdirSync(out);
  writeFileSync(join(out, 'started.json'), JSON.stringify({ case: input.id, live }), {
    flag: 'wx',
  });
  const save = (name, value) =>
    writeFileSync(join(out, `${name}.json`), JSON.stringify(value, null, 2));
  const config = loadConfig({
    LUOWANG_DATA_DIR: join(out, 'state'),
    LUOWANG_MASTER_KEY: randomUUID(),
    LUOWANG_LOG_LEVEL: 'silent',
  });
  const db = initializeDatabase(config);
  const configuration = createConfigurationStore(db.sqlite, config);
  const secrets = createSecretStore(db.sqlite, config.masterKey);
  if (live) secrets.set('providerApiKey', apiKey);
  configuration.updateHarness({
    language: 'zh-CN',
    provider: 'deepseek',
    providerBaseUrl: baseUrl ?? 'http://127.0.0.1:1/v1',
    agents: {
      main: { model: 'deepseek-v4-flash', thinking: 'low' },
      runner: { model: 'deepseek-v4-flash', thinking: 'off' },
      reviewer: { model: 'deepseek-v4-flash-vision-exp', thinking: 'low' },
    },
    mcp: { enabled: false, browser: 'chromium', headless: true, timeoutMs: 15000 },
  });
  const sessions = [];
  const result = {
    case: input.id,
    mode: live ? 'live' : 'scripted-preflight',
    status: 'started',
    humanScoring: 'not_run',
    semanticResult: 'not_evaluated',
  };
  try {
    const runId = createRunId();
    const workspace = new RunWorkspace(runId, join(out, 'evaluation'));
    await workspace.create();
    const target = 'a'.repeat(40); // Explicit synthetic identifier, never a website commit.
    const sources = [
      {
        id: input.scenarioId,
        path: `docs/scenario-testing/scenarios/${input.scenarioId}.md`,
        content: input.scenario,
      },
    ];
    validateExecutionScenarioPlan(
      parseExecutionScenarioPlan(input.plan),
      sources.map((s) => parseScenarioMarkdown(s.content, s.path)),
    );
    await workspace.writer('main-a').writePlan(input.plan);
    await workspace.writer('runner').writeExecution(input.execution);
    const transport = localEvidenceTransport();
    const store = createRunEvidenceStore(workspace, transport.oss, {
      reviewSecrets: () => (live ? [apiKey] : []),
    });
    if (input.snapshot) {
      const filename = 'page-2026-09-21T00-03-00-000Z.yml';
      writeFileSync(join(workspace.evidenceDirectory, filename), input.snapshot, { flag: 'wx' });
      await store.captureBrowserSnapshot(filename);
      await store.upload(filename);
      store.allowBrowserRecords();
    }
    if (input.observation) await store.captureObservation(target, input.observation);
    const context = {
      runId,
      request: '审核这些隔离合成材料，保留依据和限制；不执行外部操作。',
      trigger: 'manual',
      baseCommit: null,
      targetCommit: target,
      includedCommits: [],
      startedAt: '2026-09-21T00:05:00.000Z',
      reportFinishedAt: null,
      repositoryDirectory: out,
      runDirectory: workspace.runningDirectory,
      historyIssues: [],
      historyIssuesAvailable: false,
      evidence: [],
      blockingReasons: [],
      browserRequired: false,
      scenarioMode: 'review-all',
      initialization: false,
      selectedScenarioSnapshot: snapshotSelectedScenarios(target, undefined, sources, []),
    };
    const state = {
      ...context,
      status: 'running',
      phase: 'reviewer',
      activities: [],
      artifactNames: [],
    };
    const provider = live
      ? createProviderAdapter(configuration, secrets)
      : { resolveModel: async () => ({ input: ['text', 'image'] }) };
    const native = live ? createPiAgentSessionFactory({ provider }) : null;
    const factory = {
      create: async (sessionInput) => {
        const record = {
          id: randomUUID(),
          role: sessionInput.role,
          versions: sessionInput.roleInstructionVersions,
          disposed: false,
          tools: [],
          allowedTools: sessionInput.customTools.map((t) => t.name),
        };
        sessions.push(record);
        const customTools = sessionInput.customTools.map((tool) => ({
          ...tool,
          execute: async (...args) => {
            const event = { name: tool.name, input: args[1], status: 'started' };
            record.tools.push(event);
            save('sessions', sessions); // Capture writer input before production validation/transformation.
            try {
              const value = await tool.execute(...args);
              event.output = value;
              event.status = value?.details?.error || value?.isError ? 'rejected' : 'returned';
              return value;
            } catch (error) {
              event.status = 'threw';
              throw new Error('Production tool failed', { cause: live ? undefined : error });
            } finally {
              save('sessions', sessions);
            }
          },
        }));
        if (live) {
          const session = await native.create({ ...sessionInput, customTools });
          record.id = session.sessionId;
          return {
            sessionId: session.sessionId,
            prompt: (text) => session.prompt(text),
            dispose: async () => {
              await session.dispose();
              record.disposed = true;
              save('sessions', sessions);
            },
          };
        }
        const invoke = async (name, args) => {
          const value = await customTools
            .find((t) => t.name === name)
            .execute('preflight', args, undefined, undefined, {});
          if (value?.details?.error || value?.isError)
            throw new Error(`Preflight tool rejected: ${JSON.stringify(value)}`);
          return value.content
            .filter((c) => c.type === 'text')
            .map((c) => c.text)
            .join('\n');
        };
        return {
          sessionId: record.id,
          prompt: async () => {
            await invoke('read_run_artifact', { name: 'plan.md' });
            if (sessionInput.role === 'reviewer') {
              const files = JSON.parse(await invoke('list_evidence_files', {}));
              if (!files.length) throw new Error('Missing fixture evidence');
              for (const file of files) await invoke(file.readTool, { filename: file.name });
              await invoke('read_run_artifact', { name: 'execution.md' });
              await invoke('write_review', {
                content:
                  '# Scripted preflight\n\nOnly tool wiring exercised; semantic judgment not evaluated.',
              });
            } else {
              await invoke('read_run_artifact', { name: 'review.md' });
              await invoke('write_report', {
                content: `---\nrun_id: ${runId}\ntrigger: manual\nbase_commit: null\ntarget_commit: ${target}\nincluded_commits: []\nresult: blocked\nstarted_at: ${context.startedAt}\nfinished_at: ${context.reportFinishedAt}\nscenario_results:\n  - id: ${input.scenarioId}\n    result: blocked\nconfirmed_bugs: []\n---\n\n# Scripted preflight\n\nModel behavior not evaluated.\n`,
              });
            }
          },
          dispose: async () => {
            record.disposed = true;
            save('sessions', sessions);
          },
        };
      },
    };
    const orchestrator = createRunOrchestrator({
      configuration,
      repository: {},
      reportDir: join(out, 'evaluation'),
      secretStore: secrets,
      provider,
      sessions: factory,
      oss: transport.oss,
    });
    await orchestrator.runReviewer(state, workspace, context, store);
    if (store.readFailureCount() || context.blockingReasons.length)
      throw new Error('Reviewer evidence delivery failed');
    await orchestrator.runMainB(state, workspace, context);
    const report = await workspace.read('report.md');
    parseReportMarkdown(report, 'report.md', runId);
    result.artifacts = Object.fromEntries(
      await Promise.all(
        ['plan.md', 'execution.md', 'review.md', 'report.md'].map(async (name) => [
          name,
          sha(await workspace.read(name)),
        ]),
      ),
    );
    result.runId = runId;
    result.sessionsSha256 = sha(JSON.stringify(sessions, null, 2));
    result.reads = transport.reads;
    result.status = live ? 'awaiting_scoring' : 'preflight_passed';
    return { result, sessions };
  } catch (error) {
    result.status = 'failed';
    if (!live) result.preflightError = String(error);
    throw new Error(`Case ${input.id} failed; inspect local artifacts`, {
      cause: live ? undefined : error,
    });
  } finally {
    save('result', result);
    save('sessions', sessions);
    db.close();
  }
}
