import { createHmac } from 'node:crypto';
import pg from 'pg';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { buildServer } from '../examples/orders/app.js';
import {
  batchPayload,
  clearDatabase,
  databasePool,
  makeSentinel,
  messagePayload,
  prepareDatabase,
  rowCount,
  secret,
  signedRequest,
} from './helpers.js';

describe('durable webhook ingestion', () => {
  const pool = databasePool();
  beforeAll(() => prepareDatabase(pool));
  beforeEach(() => clearDatabase(pool));
  afterAll(() => pool.end());

  it('stores one logical event for ten concurrent duplicate deliveries, without calling a handler', async () => {
    const handler = vi.fn(async () => {});
    const sentinel = makeSentinel(pool, { onMessage: handler });
    const results = await Promise.all(
      Array.from({ length: 10 }, () => sentinel.ingest(signedRequest())),
    );
    expect(results.every((result) => result.statusCode === 200)).toBe(true);
    expect(await rowCount(pool, 'webhook_events')).toBe(1);
    expect(await rowCount(pool, 'orders')).toBe(0);
    expect(handler).not.toHaveBeenCalled();
    const result = await pool.query(
      'SELECT state, attempts, payload FROM webhook_events',
    );
    expect(result.rows[0]).toMatchObject({
      state: 'pending',
      attempts: 0,
      payload: messagePayload(),
    });
  });

  it('deduplicates batches, repeated items, and retries as single events', async () => {
    const sentinel = makeSentinel(pool);
    const request = signedRequest(
      batchPayload([
        'wamid.synthetic.001',
        'wamid.synthetic.002',
        'wamid.synthetic.001',
      ]),
      { 'x-webhook-batch': 'true' },
    );
    expect((await sentinel.ingest(request)).statusCode).toBe(200);
    expect((await sentinel.ingest(request)).statusCode).toBe(200);
    expect((await sentinel.ingest(signedRequest())).statusCode).toBe(200);
    expect(await rowCount(pool, 'webhook_events')).toBe(2);
  });

  it('keeps the same message ID separate for two configured phone numbers', async () => {
    const first = makeSentinel(pool);
    const secondPhone = 'phone_test_002';
    const second = makeSentinel(pool, { phoneNumberId: secondPhone });
    expect((await first.ingest(signedRequest())).statusCode).toBe(200);
    expect(
      (
        await second.ingest(
          signedRequest(messagePayload(undefined, secondPhone)),
        )
      ).statusCode,
    ).toBe(200);
    expect(await rowCount(pool, 'webhook_events')).toBe(2);
  });

  it.each([
    ['missing', undefined],
    ['malformed', 'not-a-signature'],
    ['wrong', '0'.repeat(64)],
  ])(
    'rejects a %s signature before any database write',
    async (_description, signature) => {
      const handler = vi.fn(async () => {});
      const sentinel = makeSentinel(pool, { onMessage: handler });
      expect(
        (
          await sentinel.ingest(
            signedRequest(messagePayload(), {
              'x-webhook-signature': signature,
            }),
          )
        ).statusCode,
      ).toBe(401);
      expect(await rowCount(pool, 'webhook_events')).toBe(0);
      expect(handler).not.toHaveBeenCalled();
    },
  );

  it('rejects repeated signature headers', async () => {
    const request = signedRequest();
    const result = await makeSentinel(pool).ingest({
      ...request,
      headers: {
        ...request.headers,
        'x-webhook-signature': [request.headers['x-webhook-signature']],
      },
    });
    expect(result.statusCode).toBe(401);
    expect(await rowCount(pool, 'webhook_events')).toBe(0);
  });

  it('authenticates before parsing JSON', async () => {
    const request = signedRequest();
    expect(
      (
        await makeSentinel(pool).ingest({
          ...request,
          rawBody: Buffer.from('not json'),
        })
      ).statusCode,
    ).toBe(401);
    const rawBody = Buffer.from('{ broken JSON');
    expect(
      (
        await makeSentinel(pool).ingest({
          rawBody,
          headers: {
            ...request.headers,
            'x-webhook-signature': createHmac('sha256', secret)
              .update(rawBody)
              .digest('hex'),
          },
        })
      ).statusCode,
    ).toBe(400);
    expect(await rowCount(pool, 'webhook_events')).toBe(0);
  });

  it.each([
    ['wrong phone number', messagePayload(undefined, 'wrong_phone'), {}],
    [
      'missing message ID',
      { ...messagePayload(), message: { type: 'text' } },
      {},
    ],
    [
      'unsupported event',
      messagePayload(),
      { 'x-webhook-event': 'whatsapp.message.sent' },
    ],
    [
      'malformed batch item',
      { ...batchPayload(), data: [messagePayload(), {}] },
      { 'x-webhook-batch': 'true' },
    ],
  ])(
    'rejects %s without acknowledging or storing part of a delivery',
    async (_name, payload, headers) => {
      const result = await makeSentinel(pool).ingest(
        signedRequest(payload, headers),
      );
      expect(result.statusCode).toBe(400);
      expect(await rowCount(pool, 'webhook_events')).toBe(0);
    },
  );

  it.each(['text/plain', undefined])(
    'rejects unsupported Content-Type %s',
    async (contentType) => {
      const result = await makeSentinel(pool).ingest(
        signedRequest(messagePayload(), { 'content-type': contentType }),
      );
      expect(result.statusCode).toBe(415);
      expect(await rowCount(pool, 'webhook_events')).toBe(0);
    },
  );

  it('enforces a configured ingestion body limit before any write', async () => {
    const result = await makeSentinel(pool, { maxBodyBytes: 8 }).ingest(
      signedRequest(),
    );
    expect(result.statusCode).toBe(413);
    expect(await rowCount(pool, 'webhook_events')).toBe(0);
  });

  it('does not return 200 before its database transaction can commit', async () => {
    const lock = await pool.connect();
    await lock.query('BEGIN');
    await lock.query('LOCK TABLE webhook_events IN SHARE MODE');
    let settled = false;
    const ingestion = makeSentinel(pool)
      .ingest(signedRequest())
      .finally(() => {
        settled = true;
      });
    try {
      await new Promise((resolve) => setTimeout(resolve, 80));
      expect(settled).toBe(false);
      expect(await rowCount(pool, 'webhook_events')).toBe(0);
      await lock.query('ROLLBACK');
      expect((await ingestion).statusCode).toBe(200);
      expect(await rowCount(pool, 'webhook_events')).toBe(1);
    } finally {
      await lock.query('ROLLBACK');
      lock.release();
      await ingestion;
    }
  });

  it('rolls back the complete batch if a later insert fails', async () => {
    await pool.query(`
      CREATE FUNCTION eventsentinel_test_reject() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.message_id = 'wamid.reject' THEN RAISE EXCEPTION 'synthetic insert failure'; END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER eventsentinel_test_reject BEFORE INSERT ON webhook_events
      FOR EACH ROW EXECUTE FUNCTION eventsentinel_test_reject();
    `);
    try {
      const result = await makeSentinel(pool).ingest(
        signedRequest(batchPayload(['wamid.accept', 'wamid.reject']), {
          'x-webhook-batch': 'true',
        }),
      );
      expect(result.statusCode).toBe(503);
      expect(await rowCount(pool, 'webhook_events')).toBe(0);
      expect(JSON.stringify(result.body)).not.toContain(
        'synthetic insert failure',
      );
    } finally {
      await pool.query(
        'DROP TRIGGER eventsentinel_test_reject ON webhook_events; DROP FUNCTION eventsentinel_test_reject()',
      );
    }
  });

  it('returns 503 when PostgreSQL cannot accept ingestion', async () => {
    const unavailable = new pg.Pool({
      connectionString: 'postgresql://unused:unused@127.0.0.1:1/unavailable',
      connectionTimeoutMillis: 200,
    });
    try {
      const result = await makeSentinel(unavailable).ingest(signedRequest());
      expect(result.statusCode).toBe(503);
      expect(JSON.stringify(result.body)).not.toMatch(
        /ECONNREFUSED|password|127\.0\.0\.1/,
      );
      expect(await rowCount(pool, 'webhook_events')).toBe(0);
    } finally {
      await unavailable.end();
    }
  });

  it('uses exact request bytes in the runnable Fastify endpoint', async () => {
    const app = buildServer({ sentinel: makeSentinel(pool) });
    const rawBody = Buffer.from(
      ` \n${JSON.stringify(messagePayload(), null, 2)}\n`,
    );
    const headers = {
      ...signedRequest().headers,
      'content-type': 'application/json; charset=utf-8',
      'x-webhook-signature': createHmac('sha256', secret)
        .update(rawBody)
        .digest('hex'),
    };
    try {
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/webhooks/kapso',
            headers,
            payload: rawBody,
          })
        ).statusCode,
      ).toBe(200);
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/webhooks/kapso',
            headers,
            payload: Buffer.from(JSON.stringify(messagePayload())),
          })
        ).statusCode,
      ).toBe(401);
      expect(await rowCount(pool, 'webhook_events')).toBe(1);
    } finally {
      await app.close();
    }
  });

  it('enforces the example HTTP request body limit', async () => {
    const app = buildServer({ sentinel: makeSentinel(pool) });
    try {
      const result = await app.inject({
        method: 'POST',
        url: '/webhooks/kapso',
        headers: { 'content-type': 'application/json' },
        payload: 'x'.repeat(1024 * 1024 + 1),
      });
      expect(result.statusCode).toBe(413);
      expect(await rowCount(pool, 'webhook_events')).toBe(0);
    } finally {
      await app.close();
    }
  });
});
