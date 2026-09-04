import { strict as assert } from 'node:assert';
import { createServer } from 'node:http';

import { afterEach, describe, it } from 'vitest';

import { GITHUB_CHECK_IDS, GitHubClient } from '../src/server/repository/github.js';

const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanup.length > 0) await cleanup.pop()?.();
});

describe('GitHub non-destructive connectivity checks', () => {
  it('uses explicit classic PAT scope and repository permissions without write probes', async () => {
    const requests: Array<{ method: string; url: string }> = [];
    const apiBaseUrl = await startGitHubFixture('repo', requests);
    const client = new GitHubClient({
      repositoryUrl: 'https://github.com/example/project',
      tokenProvider: () => 'synthetic-classic-pat',
      apiBaseUrl,
    });

    for (const checkId of GITHUB_CHECK_IDS) {
      const result = await client.check(checkId, 'scenario-testing');
      assert.equal(result.status, 'ok', `${checkId}: ${result.message}`);
    }
    assert.ok(requests.length > 0);
    assert.ok(requests.every((request) => request.method === 'GET'));
  });

  it('keeps PR and Issue capability unknown when GitHub exposes no verifiable write scope', async () => {
    const requests: Array<{ method: string; url: string }> = [];
    const apiBaseUrl = await startGitHubFixture('', requests);
    const client = new GitHubClient({
      repositoryUrl: 'https://github.com/example/project',
      tokenProvider: () => 'synthetic-fine-grained-token',
      apiBaseUrl,
    });

    assert.equal((await client.check('github-repository-read', 'scenario-testing')).status, 'ok');
    assert.equal(
      (await client.check('github-scenario-branch-write', 'scenario-testing')).status,
      'ok',
    );
    assert.equal((await client.check('github-pull-request', 'scenario-testing')).status, 'unknown');
    assert.equal((await client.check('github-issue', 'scenario-testing')).status, 'unknown');
    assert.ok(requests.every((request) => request.method === 'GET'));
  });
});

async function startGitHubFixture(
  oauthScopes: string,
  requests: Array<{ method: string; url: string }>,
): Promise<string> {
  const server = createServer((request, response) => {
    requests.push({ method: request.method ?? '', url: request.url ?? '' });
    response.setHeader('content-type', 'application/json');
    if (oauthScopes !== '') response.setHeader('x-oauth-scopes', oauthScopes);
    if (request.url === '/repos/example/project') {
      response.statusCode = 200;
      response.end(
        JSON.stringify({
          full_name: 'example/project',
          default_branch: 'main',
          private: true,
          has_issues: true,
          permissions: { admin: false, push: true, pull: true },
        }),
      );
      return;
    }
    if (
      request.url === '/repos/example/project/branches/scenario-testing' ||
      request.url === '/repos/example/project/pulls?state=open&per_page=1' ||
      request.url === '/repos/example/project/issues?state=open&per_page=1'
    ) {
      response.statusCode = 200;
      response.end(request.url.includes('/branches/') ? '{}' : '[]');
      return;
    }
    response.statusCode = 404;
    response.end('{}');
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  cleanup.push(
    async () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  );
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return `http://127.0.0.1:${address.port}`;
}
