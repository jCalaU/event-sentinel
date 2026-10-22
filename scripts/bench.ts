import { createHmac, randomUUID } from 'node:crypto';
import { cpus, totalmem, platform, arch } from 'node:os';
import pg from 'pg';
import { envSchema } from '../examples/orders/env.js';

const env = envSchema.parse(process.env);
const pool = new pg.Pool({
  connectionString: env.DATABASE_URL,
  connectionTimeoutMillis: 2000,
});
const runId = randomUUID();
const uniqueCount = 50;
const requests = uniqueCount * 2;
const concurrency = 10;
const latencies: number[] = [];
let success = 0;
let errors = 0;
let inserted = 0;
let duplicates = 0;
let next = 0;
const eventSizes = new Set<number>();
try {
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (next < requests) {
        const index = next++;
        const body = JSON.stringify({
          message: {
            id: `bench.${runId}.${index % uniqueCount}`,
            timestamp: '1730092800',
            type: 'text',
            text: { body: 'buy 1 shirt' },
          },
          conversation: {
            id: `bench.${runId}`,
            phone_number_id: env.KAPSO_PHONE_NUMBER_ID,
          },
          phone_number_id: env.KAPSO_PHONE_NUMBER_ID,
        });
        eventSizes.add(Buffer.byteLength(body));
        const start = performance.now();
        try {
          const response = await fetch(
            `http://127.0.0.1:${env.PORT}/webhooks/kapso`,
            {
              method: 'POST',
              body,
              headers: {
                'content-type': 'application/json',
                'x-webhook-event': 'whatsapp.message.received',
                'x-idempotency-key': randomUUID(),
                'x-webhook-signature': createHmac(
                  'sha256',
                  env.KAPSO_WEBHOOK_SECRET,
                )
                  .update(body)
                  .digest('hex'),
              },
              signal: AbortSignal.timeout(10000),
            },
          );
          const result = (await response.json()) as {
            inserted?: number;
            duplicates?: number;
          };
          if (response.status === 200) {
            success++;
            inserted += result.inserted ?? 0;
            duplicates += result.duplicates ?? 0;
          } else errors++;
        } catch {
          errors++;
        }
        latencies.push(performance.now() - start);
      }
    }),
  );
  latencies.sort((a, b) => a - b);
  const percentile = (fraction: number) =>
    Number(latencies[Math.ceil(latencies.length * fraction) - 1]?.toFixed(2));
  const count = await pool.query<{ count: string }>(
    'SELECT count(*) FROM webhook_events WHERE message_id LIKE $1',
    [`bench.${runId}.%`],
  );
  const version = await pool.query<{ server_version: string }>(
    'SHOW server_version',
  );
  console.log(
    JSON.stringify(
      {
        requests,
        success,
        errors,
        inserted,
        duplicates,
        durableEvents: Number(count.rows[0]?.count),
        p50Ms: percentile(0.5),
        p95Ms: percentile(0.95),
        eventBytes: {
          min: Math.min(...eventSizes),
          max: Math.max(...eventSizes),
        },
        batchSize: 1,
        concurrency,
        workers: env.RUN_WORKER === 'true' ? 1 : 0,
        workerCountSource:
          'RUN_WORKER in this command; match it to the server setup',
        node: process.version,
        hardware: {
          platform: platform(),
          arch: arch(),
          cpu: cpus()[0]?.model,
          cores: cpus().length,
          memoryGiB: Number((totalmem() / 1024 ** 3).toFixed(1)),
        },
        database: {
          version: version.rows[0]?.server_version,
          host: new URL(env.DATABASE_URL).hostname,
          port: new URL(env.DATABASE_URL).port || '5432',
          setup:
            'Direct PostgreSQL connection; record storage setup when sharing',
        },
      },
      null,
      2,
    ),
  );
  if (
    success !== requests ||
    inserted !== uniqueCount ||
    duplicates !== uniqueCount ||
    Number(count.rows[0]?.count) !== uniqueCount
  )
    process.exitCode = 1;
} finally {
  await pool.end();
}
