import { createHmac, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { envSchema } from './env.js';

const env = envSchema.parse(process.env);
const mode = process.argv[2];
const batched = mode === 'batch' || mode === 'batch-item';
const fixture: unknown = JSON.parse(
  await readFile(
    new URL(
      `../../fixtures/message-${batched ? 'batch' : 'single'}.json`,
      import.meta.url,
    ),
    'utf8',
  ),
);
// Keep these IDs stable so repeated commands demonstrate deduplication.
const payload =
  mode === 'batch-item' ? (fixture as { data: unknown[] }).data[0] : fixture;
const body = JSON.stringify(payload);
const signature = createHmac('sha256', env.KAPSO_WEBHOOK_SECRET)
  .update(body)
  .digest('hex');
const count = mode === 'duplicates' ? 10 : 1;
const results = await Promise.all(
  Array.from({ length: count }, async () => {
    const response = await fetch(
      `http://127.0.0.1:${env.PORT}/webhooks/kapso`,
      {
        method: 'POST',
        body,
        headers: {
          'content-type': 'application/json',
          'x-webhook-signature': signature,
          'x-webhook-event': 'whatsapp.message.received',
          'x-idempotency-key': randomUUID(),
          ...(mode === 'batch' ? { 'x-webhook-batch': 'true' } : {}),
        },
        signal: AbortSignal.timeout(10000),
      },
    );
    const result: unknown = await response.json();
    console.log(response.status, result);
    return response.status === 200;
  }),
);
if (results.some((ok) => !ok)) process.exitCode = 1;
