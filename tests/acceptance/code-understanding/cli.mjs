import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  readdirSync,
  existsSync,
  unlinkSync,
  openSync,
  closeSync,
} from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fixtures, protocol } from './fixtures.mjs';
import { runCase } from './driver.mjs';
import { sha } from '../record-accuracy/control.mjs';
import { modelProxy } from '../record-accuracy/proxy.mjs';

const [mode, outArg, baselineArg] = process.argv.slice(2);
if (!['freeze', 'preflight', 'pilot', 'formal'].includes(mode) || !outArg || !baselineArg)
  throw new Error('Use freeze|preflight|pilot|formal OUTPUT BASELINE_ROOT');
const root = process.cwd(),
  out = resolve(outArg),
  baseline = resolve(baselineArg);
const json = (path) => JSON.parse(readFileSync(path, 'utf8'));
const save = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2));
const files = (directory, relative) =>
  readdirSync(join(directory, relative), { withFileTypes: true }).flatMap((entry) => {
    if (entry.isSymbolicLink()) throw new Error('Symlink refused');
    const name = `${relative}/${entry.name}`;
    return entry.isDirectory() ? files(directory, name) : [name];
  });
const snapshot = (directory, evaluator) =>
  Object.fromEntries(
    [
      ...files(directory, 'src'),
      ...files(directory, 'resources'),
      ...(evaluator
        ? [
            ...files(directory, 'tests/acceptance/code-understanding'),
            'tests/acceptance/record-accuracy/control.mjs',
            'tests/acceptance/record-accuracy/proxy.mjs',
          ]
        : []),
      'package.json',
      'package-lock.json',
    ]
      .sort()
      .map((name) => [name, sha(readFileSync(join(directory, name)))]),
  );
if (mode === 'freeze') {
  mkdirSync(out);
  save(join(out, 'inputs.json'), fixtures);
  save(join(out, 'protocol.json'), { ...protocol, maxOutputTokens: 6000 });
  for (const input of fixtures) {
    const repository = join(out, 'repositories', input.id);
    mkdirSync(repository, { recursive: true });
    const git = (...args) =>
      execFileSync(
        'git',
        [
          '-C',
          repository,
          '-c',
          'core.autocrlf=false',
          '-c',
          'user.name=Fixture',
          '-c',
          'user.email=fixture@example.invalid',
          ...args,
        ],
        {
          stdio: 'pipe',
          env: {
            ...process.env,
            GIT_AUTHOR_DATE: '2026-09-23T00:00:00Z',
            GIT_COMMITTER_DATE: '2026-09-23T00:00:00Z',
          },
        },
      );
    git('init', '--quiet');
    for (const [index, tree] of (input.base
      ? [input.base, input.target]
      : [input.target]
    ).entries()) {
      for (const path of Object.keys(input.base ?? {}))
        if (!Object.hasOwn(tree, path) && existsSync(join(repository, path)))
          unlinkSync(join(repository, path));
      for (const [path, content] of Object.entries(tree)) {
        mkdirSync(dirname(join(repository, path)), { recursive: true });
        writeFileSync(join(repository, path), content);
      }
      git('add', '.');
      git('commit', '--quiet', '--allow-empty', '-m', `fixture-${index}`);
    }
  }
  save(join(out, 'manifest.json'), {
    baseline: snapshot(baseline, false),
    candidate: snapshot(root, true),
    inputs: sha(readFileSync(join(out, 'inputs.json'))),
    protocol: sha(readFileSync(join(out, 'protocol.json'))),
    targets: Object.fromEntries(
      fixtures.map((input) => [
        input.id,
        execFileSync('git', ['-C', join(out, 'repositories', input.id), 'rev-parse', 'HEAD'], {
          encoding: 'utf8',
        }).trim(),
      ]),
    ),
  });
  console.log('Frozen 8 fixtures, rubric and both revisions; 0 model requests.');
} else {
  const manifest = json(join(out, 'manifest.json'));
  for (const [kind, directory] of [
    ['baseline', baseline],
    ['candidate', root],
  ]) {
    if (
      JSON.stringify(snapshot(directory, kind === 'candidate')) !== JSON.stringify(manifest[kind])
    )
      throw new Error('Frozen revision changed');
  }
  for (const [name, key] of [
    ['inputs.json', 'inputs'],
    ['protocol.json', 'protocol'],
  ])
    if (sha(readFileSync(join(out, name))) !== manifest[key])
      throw new Error('Frozen input changed');
  const inputs = json(join(out, 'inputs.json'));
  for (const input of inputs) {
    const repository = join(out, 'repositories', input.id);
    const target = execFileSync('git', ['-C', repository, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
    }).trim();
    if (target !== manifest.targets[input.id]) throw new Error('Fixture target changed');
  }
  const batch = join(out, mode);
  mkdirSync(batch);
  if (mode === 'preflight') {
    for (const input of inputs)
      for (const candidate of [false, true]) {
        const result = await runCase(
          candidate ? root : baseline,
          input,
          join(out, 'repositories', input.id),
          join(batch, `${input.id}-${candidate ? 'candidate' : 'baseline'}`),
          { candidate },
        );
        if (result.status !== 'preflight_passed') throw new Error('Preflight failed');
      }
    save(join(batch, 'result.json'), { cases: 16, requests: 0, status: 'passed' });
  } else {
    if (json(join(out, 'preflight/result.json')).status !== 'passed')
      throw new Error('Preflight required');
    if (mode === 'formal' && json(join(out, 'pilot/result.json')).status !== 'completed')
      throw new Error('Completed protocol pilot required');
    const ledgerPath = process.env.CU_LEDGER;
    if (!ledgerPath) throw new Error('Shared authorization ledger required');
    const lock = join(out, 'live.lock');
    closeSync(openSync(lock, 'wx'));
    let server;
    const ledger = json(ledgerPath);
    if (
      !Number.isSafeInteger(ledger.authorizedCalls) ||
      ledger.authorizedCalls <= 0 ||
      !Number.isInteger(ledger.usedCalls) ||
      ledger.usedCalls < 0 ||
      ledger.usedCalls > ledger.authorizedCalls
    )
      throw new Error('Invalid authorization ledger');
    const credentials = json(0);
    const endpoint = new URL(
      credentials.DEEPSEEK_BASE_URL.replace(/\/$/, '') + '/chat/completions',
    );
    if (endpoint.protocol !== 'https:' || !credentials.DEEPSEEK_API_KEY)
      throw new Error('Controlled credentials required');
    const state = {
      mode,
      manifest: sha(readFileSync(join(out, 'manifest.json'))),
      requests: 0,
      attempts: [],
      cases: [],
      status: 'started',
    };
    const persist = () => {
      save(join(batch, 'budget.json'), state);
      save(ledgerPath, ledger);
    };
    const record = { mode, manifest: state.manifest, usedCalls: 0 };
    ledger.batches.push(record);
    let current,
      globallyStopped = false,
      caseStopped = false;
    const budget = {
      stop(reason) {
        if (!caseStopped) {
          globallyStopped = true;
          state.stopReason = reason;
        }
        persist();
      },
      async request(label, action) {
        if (globallyStopped || ledger.usedCalls >= ledger.authorizedCalls)
          throw new Error('Global budget stopped');
        if (current.requests >= protocol.maxRequestsPerCase) {
          caseStopped = true;
          throw new Error('Case budget exhausted');
        }
        const receipt = {
          number: ++ledger.usedCalls,
          case: current.name,
          label,
          status: 'started',
          startedAt: new Date().toISOString(),
        };
        current.requests++;
        record.usedCalls++;
        state.requests++;
        state.attempts.push(receipt);
        persist();
        const started = Date.now();
        try {
          await action(receipt);
          receipt.status = 'completed';
        } catch {
          receipt.status = 'failed';
          globallyStopped = true;
          throw new Error('Counted upstream attempt failed');
        } finally {
          receipt.elapsedMs = Date.now() - started;
          persist();
        }
      },
    };
    try {
      server = modelProxy(
        budget,
        endpoint.href,
        credentials.DEEPSEEK_API_KEY,
        async (url, init) => {
          const body = JSON.parse(init.body);
          body.max_tokens = 6000;
          body.stream_options = { include_usage: true };
          const response = await fetch(url, { ...init, body: JSON.stringify(body) });
          const text = await response.text();
          const safeText = text.split(credentials.DEEPSEEK_API_KEY).join('[REDACTED]');
          writeFileSync(join(batch, `${current.name}-response-${current.requests}.txt`), safeText);
          for (const line of text.split('\n')) {
            try {
              const value = JSON.parse(line.replace(/^data: /, ''));
              if (value.usage) state.attempts.at(-1).usage = value.usage;
            } catch {
              /* SSE framing */
            }
          }
          return new Response(text, { status: response.status, headers: response.headers });
        },
      );
      await new Promise((done) => server.listen(0, '127.0.0.1', done));
      const schedule =
        mode === 'pilot'
          ? protocol.pilotCases.map((id) => ({
              input: inputs.find((input) => input.id === id),
              candidate: true,
              repeat: 0,
            }))
          : Array.from({ length: 3 }, (_, repeat) =>
              inputs.flatMap((input) =>
                (repeat % 2 ? [true, false] : [false, true]).map((candidate) => ({
                  input,
                  candidate,
                  repeat,
                })),
              ),
            ).flat();
      for (const { input, candidate, repeat } of schedule) {
        if (globallyStopped) break;
        current = {
          name: `${input.id}-${repeat}-${candidate ? 'candidate' : 'baseline'}`,
          requests: 0,
        };
        caseStopped = false;
        const started = Date.now();
        const result = await runCase(
          candidate ? root : baseline,
          input,
          join(out, 'repositories', input.id),
          join(batch, current.name),
          {
            candidate,
            live: true,
            baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
            apiKey: credentials.DEEPSEEK_API_KEY,
          },
        );
        current.status = result.status;
        current.elapsedMs = Date.now() - started;
        current.budgetLimited = caseStopped;
        state.cases.push(current);
        persist();
        console.log(JSON.stringify(current));
      }
      state.status =
        !globallyStopped &&
        state.cases.length === schedule.length &&
        state.cases.every((item) => item.status === 'awaiting_ai_audit')
          ? 'completed'
          : 'incomplete';
      save(join(batch, 'result.json'), {
        status: state.status,
        cases: state.cases,
        requests: state.requests,
        humanScoring: 'not_run',
      });
    } finally {
      persist();
      if (server) {
        server.closeAllConnections();
        await new Promise((done) => server.close(done));
      }
      unlinkSync(lock);
    }
  }
}
