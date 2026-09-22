import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  openSync,
  closeSync,
  unlinkSync,
  existsSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { caseIds } from './fixtures.mjs';
import {
  freeze,
  verify,
  sha,
  createBudget,
  requireScoredCase,
  stopForDeliveryFailure,
} from './control.mjs';
import { runCase } from './driver.mjs';
import { modelProxy } from './proxy.mjs';

const [mode, frozenArg, caseId, authorization] = process.argv.slice(2);
const root = process.cwd();
if (!frozenArg || !['freeze', 'preflight', 'live'].includes(mode))
  throw new Error(
    'Use: tsx tests/acceptance/record-accuracy/cli.mjs freeze|preflight|live NEW-FROZEN-DIR [CASE --budget-120]',
  );
const frozen = resolve(frozenArg);
if (mode === 'freeze') {
  freeze(root, frozen);
} else {
  const manifest = verify(root, frozen);
  const inputs = JSON.parse(readFileSync(join(frozen, 'inputs.json')));
  if (mode === 'preflight') {
    const out = join(frozen, 'preflight');
    mkdirSync(out);
    for (const input of inputs) await runCase(input, join(out, input.id));
    writeFileSync(
      join(out, 'result.json'),
      JSON.stringify(
        { modelRequests: 0, cases: 6, semanticResult: 'not_evaluated', humanScoring: 'not_run' },
        null,
        2,
      ),
    );
  } else {
    if (authorization !== '--budget-120' || !caseIds.includes(caseId))
      throw new Error('Explicit new budget and known case required');
    if (!existsSync(join(frozen, 'preflight/result.json'))) throw new Error('Preflight required');
    const lock = join(frozen, 'live.lock');
    closeSync(openSync(lock, 'wx'));
    let server;
    try {
      const out = join(frozen, 'live');
      mkdirSync(out, { recursive: true });
      const budgetPath = join(out, 'budget.json');
      const save = (value) => writeFileSync(budgetPath, JSON.stringify(value, null, 2));
      const budget = createBudget(
        save,
        existsSync(budgetPath) ? JSON.parse(readFileSync(budgetPath)) : undefined,
      );
      if (budget.state.stopped) throw new Error('Round stopped');
      for (const previous of caseIds.slice(0, caseIds.indexOf(caseId))) {
        // Human-written, artifact-bound semantic review. It is never added to model context.
        requireScoredCase(join(out, previous), budget);
      }
      const credentials = JSON.parse(readFileSync(0, 'utf8'));
      const endpoint = new URL(
        credentials.DEEPSEEK_BASE_URL.replace(/\/$/, '') + '/chat/completions',
      );
      if (endpoint.protocol !== 'https:' || !credentials.DEEPSEEK_API_KEY)
        throw new Error('Controlled provider credentials required');
      server = modelProxy(budget, endpoint.href, credentials.DEEPSEEK_API_KEY);
      await new Promise((done) => server.listen(0, '127.0.0.1', done));
      save(budget.state);
      const candidatePath = join(out, 'candidate.json');
      const candidate = JSON.stringify({
        manifestSha256: sha(JSON.stringify(manifest)),
        models: ['deepseek-v4-flash', 'deepseek-v4-flash-vision-exp'],
      });
      if (existsSync(candidatePath)) {
        if (readFileSync(candidatePath, 'utf8') !== candidate)
          throw new Error('Live candidate changed');
      } else writeFileSync(candidatePath, candidate, { flag: 'wx' });
      try {
        await runCase(
          inputs.find((item) => item.id === caseId),
          join(out, caseId),
          {
            live: true,
            baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
            apiKey: credentials.DEEPSEEK_API_KEY,
          },
        );
        if (budget.state.stopped) throw new Error('Model transport stopped');
      } catch {
        stopForDeliveryFailure(budget);
        throw new Error('Case failed; round stopped');
      }
    } finally {
      if (server) {
        server.closeAllConnections();
        await new Promise((done) => server.close(done));
      }
      unlinkSync(lock);
    }
  }
}
