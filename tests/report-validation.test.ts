import { strict as assert } from 'node:assert';
import { describe, it } from 'vitest';
import { MarkdownValidationError, parseReportMarkdown } from '../src/server/repository/markdown.js';
import { RepositoryError } from '../src/server/repository/errors.js';

describe('safe Markdown parser diagnostics', () => {
  it.each([
    ['---\nprivate-canary-key: value\n---\n', /未知字段/],
    ['---\ntitle: [private-canary-value\n---\n', /YAML 无效/],
    ['---\nrun_id: private-canary-value\n---\n', /run_id/],
  ])('does not expose input values, unknown keys or paths', (content, expected) => {
    assert.throws(
      () => parseReportMarkdown(content, '/private-canary-path/report.md', 'run-1'),
      (error: unknown) => {
        assert.ok(error instanceof MarkdownValidationError);
        assert.ok(error instanceof RepositoryError);
        assert.equal(error.code, 'INDEX_UNAVAILABLE');
        assert.match(error.safeDiagnostic, expected);
        assert.ok(!error.safeDiagnostic.includes('private-canary'));
        return true;
      },
    );
  });
});
