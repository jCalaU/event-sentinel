import { createHmac } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import pino from 'pino';
import { createEventSentinel, createPostgresStore } from '../src/index.js';

export const secret = 'synthetic-test-secret-not-for-production';
export const phoneNumberId = 'phone_test_001';
export const eventType = 'whatsapp.message.received';

export function messagePayload(
  messageId = 'wamid.synthetic.001',
  phone = phoneNumberId,
) {
  return {
    message: {
      id: messageId,
      timestamp: '1730092800',
      type: 'text',
      text: { body: 'buy 1 shirt' },
      kapso: { direction: 'inbound', status: 'received', origin: 'cloud_api' },
    },
    conversation: { id: 'conv_synthetic_001', phone_number_id: phone },
    phone_number_id: phone,
  };
}

export function batchPayload(
  ids = ['wamid.synthetic.001', 'wamid.synthetic.002'],
) {
  return {
    type: eventType,
    batch: true,
    data: ids.map((id) => messagePayload(id)),
    batch_info: { count: ids.length },
  };
}

export function signedRequest(
  payload: unknown = messagePayload(),
  headers: Record<string, string | undefined> = {},
) {
  const rawBody = Buffer.from(JSON.stringify(payload));
  return {
    rawBody,
    headers: {
      'content-type': 'application/json',
      'x-webhook-event': eventType,
      'x-idempotency-key': 'delivery_synthetic_001',
      'x-webhook-signature': createHmac('sha256', secret)
        .update(rawBody)
        .digest('hex'),
      ...headers,
    },
  };
}

export function databasePool() {
  return new pg.Pool({
    connectionString:
      process.env.TEST_DATABASE_URL ??
      'postgresql://event_sentinel:event_sentinel@127.0.0.1:5432/event_sentinel_test',
    max: 12,
    connectionTimeoutMillis: 2_000,
  });
}

export async function prepareDatabase(pool: pg.Pool) {
  try {
    await pool.query(
      await readFile(
        new URL('../migrations/001_init.sql', import.meta.url),
        'utf8',
      ),
    );
    await pool.query(
      await readFile(
        new URL('../examples/orders/schema.sql', import.meta.url),
        'utf8',
      ),
    );
  } catch (cause) {
    throw new Error(
      'Integration tests need PostgreSQL 16+. Run docker compose up -d and create the ' +
        'event_sentinel_test database, or set TEST_DATABASE_URL to a dedicated test database.',
      { cause },
    );
  }
}

export async function clearDatabase(pool: pg.Pool) {
  await pool.query('TRUNCATE orders, webhook_events');
}

export async function insertOrder(
  event: Parameters<Parameters<typeof createEventSentinel>[0]['onMessage']>[0],
  context: Parameters<
    Parameters<typeof createEventSentinel>[0]['onMessage']
  >[1],
) {
  await context.transaction.query(
    `INSERT INTO orders (message_id, product, quantity)
     VALUES ($1, $2, $3) ON CONFLICT (message_id) DO NOTHING`,
    [event.message.id, 'shirt', 1],
  );
}

export function makeSentinel(
  pool: pg.Pool,
  options: Partial<Parameters<typeof createEventSentinel>[0]> = {},
) {
  return createEventSentinel({
    webhookSecret: secret,
    phoneNumberId,
    store: createPostgresStore(pool),
    logger: pino({ enabled: false }),
    onMessage: insertOrder,
    worker: {
      pollIntervalMs: 10,
      handlerTimeoutMs: 150,
      leaseMs: 500,
      shutdownTimeoutMs: 1_000,
      retryBaseMs: 10,
      maxAttempts: 3,
    },
    ...options,
  });
}

export async function eventually(
  check: () => Promise<boolean>,
  message: string,
  timeoutMs = 5_000,
) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  throw new Error(message);
}

export async function eventState(
  pool: pg.Pool,
  messageId = 'wamid.synthetic.001',
) {
  const result = await pool.query<{
    state: string;
    attempts: number;
    lease_token: string | null;
    last_error: string | null;
  }>(
    'SELECT state, attempts, lease_token, last_error FROM webhook_events WHERE message_id = $1',
    [messageId],
  );
  return result.rows[0];
}

export async function rowCount(
  pool: pg.Pool,
  table: 'orders' | 'webhook_events',
) {
  const result =
    table === 'orders'
      ? await pool.query<{ count: string }>('SELECT count(*) FROM orders')
      : await pool.query<{ count: string }>(
          'SELECT count(*) FROM webhook_events',
        );
  return Number(result.rows[0]?.count);
}
