import { runInNewContext } from 'node:vm';
import { expect, test } from 'vitest';
import { fixtures } from './acceptance/code-understanding/fixtures.mjs';

test('bug-fix fixture really leaves a reservation before the fix and rolls it back afterward', async () => {
  const input = fixtures.find((fixture) => fixture.id === 'bug-fix');
  for (const [version, remaining] of [
    ['base', 7],
    ['target', 10],
  ] as const) {
    let stock = 10;
    const db = {
      reserve: async (_sku: string, count: number) => {
        stock -= count;
        return true;
      },
      insert: async () => {
        throw new Error('synthetic insert failure');
      },
      transaction: async (operation: (tx: unknown) => Promise<unknown>) => {
        const before = stock;
        try {
          return await operation(db);
        } catch (error) {
          stock = before;
          throw error;
        }
      },
    };
    // Only this test-owned fixture is evaluated; no target repository code is accepted.
    const source = input[version]['src/orders.mjs']
      .replace("import { db } from './store.mjs';", '')
      .replaceAll('export async function', 'async function');
    const { submit } = runInNewContext(`${source}\n({ submit })`, { db });
    await expect(submit({ tenant: 'synthetic-a' }, { sku: 'fixture', count: 3 })).rejects.toThrow(
      'synthetic insert failure',
    );
    expect(stock).toBe(remaining);
  }
});
