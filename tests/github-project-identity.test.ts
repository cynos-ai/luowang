import { strict as assert } from 'node:assert';
import { createServer } from 'node:http';

import { describe, it } from 'vitest';

import {
  GitHubApiError,
  GitHubClient,
  describeGitHubRepositoryFailure,
  parseGitHubRepository,
} from '../src/server/repository/github.js';

describe('GitHub project identity verification', () => {
  it('uses the stable repository ID and canonical response name', async () => {
    const requests: string[] = [];
    const server = createServer((request, response) => {
      requests.push(`${request.method} ${request.url}`);
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ id: 13579, full_name: 'Renamed-Org/New-Name' }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address();
      assert.ok(address && typeof address !== 'string');
      const client = new GitHubClient({
        repositoryUrl: 'https://github.com/old-org/old-name.git',
        apiBaseUrl: `http://127.0.0.1:${address.port}`,
      });
      assert.deepEqual(await client.verifyIdentity(), {
        githubRepositoryId: '13579',
        owner: 'Renamed-Org',
        name: 'New-Name',
      });
      assert.deepEqual(requests, ['GET /repos/old-org/old-name']);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('rejects missing IDs and ambiguous input URLs', async () => {
    assert.throws(() => parseGitHubRepository('https://github.com/org/repo?token=hidden'));
    assert.throws(() => parseGitHubRepository('https://github.com/org/repo#other'));
    const server = createServer((_request, response) => {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ full_name: 'org/repo' }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address();
      assert.ok(address && typeof address !== 'string');
      const client = new GitHubClient({
        repositoryUrl: 'https://github.com/org/repo',
        apiBaseUrl: `http://127.0.0.1:${address.port}`,
      });
      await assert.rejects(() => client.verifyIdentity(), /稳定 ID/);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('classifies upstream status without returning response bodies or raw errors', async () => {
    let status = 401;
    const server = createServer((_request, response) => {
      response.statusCode = status;
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ message: 'private-token-canary' }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address();
      assert.ok(address && typeof address !== 'string');
      const client = new GitHubClient({
        repositoryUrl: 'https://github.com/org/repo',
        apiBaseUrl: `http://127.0.0.1:${address.port}`,
      });
      for (const [httpStatus, expected] of [
        [401, /Token 认证失败/],
        [403, /权限或 API 限额/],
        [404, /不存在，或当前 Token 无权读取/],
        [500, /请稍后重试/],
      ] as const) {
        status = httpStatus;
        await assert.rejects(
          () => client.verifyIdentity(),
          (error: unknown) => {
            assert.ok(error instanceof GitHubApiError);
            assert.equal(error.status, httpStatus);
            const message = describeGitHubRepositoryFailure(error);
            assert.match(message, expected);
            assert.doesNotMatch(message, /private-token-canary/);
            return true;
          },
        );
      }
      assert.match(
        describeGitHubRepositoryFailure(new GitHubApiError(0, 'private-token-canary')),
        /网络连接/,
      );
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
