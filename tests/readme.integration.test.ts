import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  clearDatabase,
  databasePool,
  messagePayload,
  phoneNumberId,
  prepareDatabase,
  secret,
} from './helpers.js';

const execute = promisify(execFile);

describe('README TypeScript integration example', () => {
  const pool = databasePool();
  beforeAll(() => prepareDatabase(pool));
  beforeEach(() => clearDatabase(pool));
  afterAll(() => pool.end());

  it('compiles and receives real signed bytes with the documented code', async () => {
    const readme = await readFile(
      new URL('../README.md', import.meta.url),
      'utf8',
    );
    const snippet = /```ts\n([\s\S]*?)\n```/.exec(readme)?.[1];
    expect(
      snippet,
      'README must include a tested TypeScript usage example',
    ).toBeTruthy();
    const source = snippet!
      .replaceAll("'@your-scope/event-sentinel'", "'../src/index.js'")
      .replace(
        "await app.listen({ port: 3000, host: '127.0.0.1' });",
        'await app.ready();',
      );
    const script = new URL(`.readme-${randomUUID()}.ts`, import.meta.url);
    const rawBody = ` \n${JSON.stringify(messagePayload(), null, 2)}\n`;
    const verification = `
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
try {
  const rawBody = Buffer.from(${JSON.stringify(rawBody)});
  const headers = {
    'content-type': 'application/json',
    'x-webhook-event': 'whatsapp.message.received',
    'x-webhook-signature': createHmac('sha256', process.env.KAPSO_WEBHOOK_SECRET!).update(rawBody).digest('hex'),
  };
  const accepted = await app.inject({method: 'POST', url: '/webhooks/kapso', headers, payload: rawBody});
  assert.equal(accepted.statusCode, 200);
  const duplicate = await app.inject({method: 'POST', url: '/webhooks/kapso', headers, payload: rawBody});
  assert.equal(duplicate.statusCode, 200);
  const altered = await app.inject({method: 'POST', url: '/webhooks/kapso', headers, payload: Buffer.concat([rawBody, Buffer.from(' ')])});
  assert.equal(altered.statusCode, 401);
  let completed = false;
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const state = await pool.query('SELECT state FROM webhook_events');
    if (state.rows[0]?.state === 'completed') { completed = true; break; }
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  assert.equal(completed, true);
  assert.equal(Number((await pool.query('SELECT count(*) FROM orders')).rows[0].count), 1);
  console.log('README_SNIPPET_OK');
} finally {
  await app.close();
  await worker.stop();
  await pool.end();
}
`;
    try {
      await writeFile(script, `${source}\n${verification}`);
      await execute(
        process.execPath,
        [
          fileURLToPath(
            new URL('../node_modules/typescript/bin/tsc', import.meta.url),
          ),
          '--noEmit',
          '--target',
          'ES2023',
          '--module',
          'NodeNext',
          '--strict',
          '--esModuleInterop',
          '--skipLibCheck',
          '--noUncheckedIndexedAccess',
          '--exactOptionalPropertyTypes',
          fileURLToPath(script),
        ],
        { timeout: 10_000 },
      );
      const result = await execute(
        process.execPath,
        ['--import', 'tsx', fileURLToPath(script)],
        {
          timeout: 10_000,
          env: {
            ...process.env,
            DATABASE_URL:
              process.env.TEST_DATABASE_URL ??
              'postgresql://event_sentinel:event_sentinel@127.0.0.1:5432/event_sentinel_test',
            KAPSO_WEBHOOK_SECRET: secret,
            KAPSO_PHONE_NUMBER_ID: phoneNumberId,
          },
        },
      );
      expect(result.stdout).toContain('README_SNIPPET_OK');
    } finally {
      await rm(script, { force: true });
    }
  });
});
