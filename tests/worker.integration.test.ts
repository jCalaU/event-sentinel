import type { ChildProcess } from 'node:child_process';
import pg from 'pg';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';
import type { WorkerController } from '../src/index.js';
import {
  batchPayload,
  clearDatabase,
  databasePool,
  eventState,
  eventually,
  insertOrder,
  makeSentinel,
  messagePayload,
  prepareDatabase,
  rowCount,
  signedRequest,
} from './helpers.js';
import { startWorkerProcess, stopWorkerProcess } from './process-helpers.js';

describe('PostgreSQL worker transactions', () => {
  const pool = databasePool();
  const workers: WorkerController[] = [];
  const processes: ChildProcess[] = [];
  beforeAll(() => prepareDatabase(pool));
  beforeEach(() => clearDatabase(pool));
  afterEach(async () => {
    await Promise.all(workers.splice(0).map((worker) => worker.stop()));
    await Promise.all(processes.splice(0).map(stopWorkerProcess));
  });
  afterAll(() => pool.end());

  it('commits one order and completion together despite repeated delivery after completion', async () => {
    const sentinel = makeSentinel(pool);
    expect((await sentinel.ingest(signedRequest())).statusCode).toBe(200);
    workers.push(sentinel.startWorker());
    await eventually(
      async () => (await eventState(pool))?.state === 'completed',
      'Order did not complete',
    );
    for (let i = 0; i < 3; i++)
      expect((await sentinel.ingest(signedRequest())).statusCode).toBe(200);
    expect(await rowCount(pool, 'webhook_events')).toBe(1);
    expect(await rowCount(pool, 'orders')).toBe(1);
    expect(await eventState(pool)).toMatchObject({
      state: 'completed',
      attempts: 1,
      lease_token: null,
    });
  });

  it('allows concurrent worker processes to claim separate jobs without repeated orders', async () => {
    const sentinel = makeSentinel(pool);
    const ids = Array.from({ length: 8 }, (_, i) => `wamid.concurrent.${i}`);
    expect(
      (
        await sentinel.ingest(
          signedRequest(batchPayload(ids), { 'x-webhook-batch': 'true' }),
        )
      ).statusCode,
    ).toBe(200);
    const first = startWorkerProcess();
    const second = startWorkerProcess();
    processes.push(first.child, second.child);
    await Promise.all([first.waitFor('ready'), second.waitFor('ready')]);
    await eventually(async () => {
      const result = await pool.query(
        "SELECT count(*) FROM webhook_events WHERE state = 'completed'",
      );
      return Number(result.rows[0].count) === ids.length;
    }, 'Concurrent workers did not finish all events');
    expect(await rowCount(pool, 'orders')).toBe(ids.length);
    const attempts = await pool.query('SELECT attempts FROM webhook_events');
    expect(attempts.rows.every((row) => row.attempts === 1)).toBe(true);
  });

  it('rolls back partial business work before a successful retry', async () => {
    let calls = 0;
    const sentinel = makeSentinel(pool, {
      onMessage: async (event, context) => {
        calls++;
        await insertOrder(event, context);
        if (calls === 1) {
          await context.transaction.query(
            'UPDATE orders SET product = $1 WHERE message_id = $2',
            ['failed-attempt', event.message.id],
          );
          throw new Error('Synthetic failure before commit');
        }
      },
    });
    await sentinel.ingest(signedRequest());
    workers.push(sentinel.startWorker());
    await eventually(
      async () => (await eventState(pool))?.state === 'completed',
      'Failed work did not retry',
    );
    expect(calls).toBe(2);
    expect(await eventState(pool)).toMatchObject({ attempts: 2 });
    expect(await rowCount(pool, 'orders')).toBe(1);
    expect(
      (await pool.query('SELECT product FROM orders')).rows[0].product,
    ).toBe('shirt');
  });

  it('never exposes a business row before its event completes', async () => {
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const sentinel = makeSentinel(pool, {
      onMessage: async (event, context) => {
        await insertOrder(event, context);
        entered();
        await hold;
      },
    });
    await sentinel.ingest(signedRequest());
    workers.push(sentinel.startWorker());
    await started;
    try {
      expect(await rowCount(pool, 'orders')).toBe(0);
      expect((await eventState(pool))?.state).toBe('processing');
    } finally {
      release();
    }
    await eventually(
      async () => (await eventState(pool))?.state === 'completed',
      'Held transaction did not commit',
    );
    expect(await rowCount(pool, 'orders')).toBe(1);
  });

  it('does not claim events for a different configured phone number', async () => {
    const otherPhone = 'phone_test_002';
    await makeSentinel(pool, { phoneNumberId: otherPhone }).ingest(
      signedRequest(messagePayload(undefined, otherPhone)),
    );
    const sentinel = makeSentinel(pool);
    workers.push(sentinel.startWorker());
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect((await eventState(pool))?.state).toBe('pending');
    expect(await rowCount(pool, 'orders')).toBe(0);
  });

  it('stops taking new work and lets the current short transaction finish', async () => {
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const sentinel = makeSentinel(pool, {
      onMessage: async (event, context) => {
        entered();
        await hold;
        await insertOrder(event, context);
      },
    });
    await sentinel.ingest(
      signedRequest(batchPayload(), { 'x-webhook-batch': 'true' }),
    );
    const worker = sentinel.startWorker();
    workers.push(worker);
    await started;
    const stopping = worker.stop();
    release();
    await stopping;
    await worker.done;
    const result = await pool.query(
      'SELECT state FROM webhook_events ORDER BY state',
    );
    expect(result.rows.map((row) => row.state)).toEqual([
      'completed',
      'pending',
    ]);
    expect(await rowCount(pool, 'orders')).toBe(1);
    // A new worker can finish the pending event.
    workers.push(makeSentinel(pool).startWorker());
    await eventually(
      async () => (await rowCount(pool, 'orders')) === 2,
      'Pending work was not recoverable after shutdown',
    );
  });

  it('uses an AbortSignal to stop the worker before it starts more work', async () => {
    const controller = new AbortController();
    controller.abort();
    await makeSentinel(pool).ingest(signedRequest());
    const worker = makeSentinel(pool).startWorker({
      signal: controller.signal,
    });
    workers.push(worker);
    await worker.done;
    expect((await eventState(pool))?.state).toBe('pending');
    expect(await rowCount(pool, 'orders')).toBe(0);
  });

  it('bounds shutdown while a claim waits for a table lock', async () => {
    const sentinel = makeSentinel(pool, { worker: { shutdownTimeoutMs: 100 } });
    await sentinel.ingest(signedRequest());
    const lock = await pool.connect();
    await lock.query('BEGIN');
    await lock.query('LOCK TABLE webhook_events IN ACCESS EXCLUSIVE MODE');
    const worker = sentinel.startWorker();
    workers.push(worker);
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      await eventually(async () => {
        const result = await pool.query<{ blocked: boolean }>(
          `SELECT EXISTS (
             SELECT 1 FROM pg_stat_activity WHERE datname = current_database()
               AND wait_event_type = 'Lock' AND query LIKE '%webhook_events%'
           ) AS blocked`,
        );
        return result.rows[0]?.blocked === true;
      }, 'The worker did not reach the blocked claim');
      const start = performance.now();
      await Promise.race([
        worker.stop(),
        new Promise<never>((_resolve, reject) => {
          deadline = setTimeout(
            () =>
              reject(new Error('Shutdown remained blocked by a database lock')),
            1_500,
          );
        }),
      ]);
      expect(performance.now() - start).toBeLessThan(1_500);
    } finally {
      if (deadline) clearTimeout(deadline);
      await lock.query('ROLLBACK');
      lock.release();
      await worker.stop();
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(await rowCount(pool, 'orders')).toBe(0);
    expect(await rowCount(pool, 'webhook_events')).toBe(1);
  });

  it('bounds shutdown while the database pool has no free connection', async () => {
    const exhausted = new pg.Pool({
      connectionString:
        process.env.TEST_DATABASE_URL ??
        'postgresql://event_sentinel:event_sentinel@127.0.0.1:5432/event_sentinel_test',
      connectionTimeoutMillis: 2_000,
      max: 1,
    });
    const sentinel = makeSentinel(exhausted, {
      worker: { shutdownTimeoutMs: 100 },
    });
    await sentinel.ingest(signedRequest());
    const held = await exhausted.connect();
    const worker = sentinel.startWorker();
    workers.push(worker);
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      await eventually(
        async () => exhausted.waitingCount > 0,
        'The worker did not wait for the exhausted pool',
      );
      const start = performance.now();
      await Promise.race([
        worker.stop(),
        new Promise<never>((_resolve, reject) => {
          deadline = setTimeout(
            () =>
              reject(
                new Error('Shutdown remained blocked by pool acquisition'),
              ),
            1_500,
          );
        }),
      ]);
      expect(performance.now() - start).toBeLessThan(1_500);
    } finally {
      if (deadline) clearTimeout(deadline);
      held.release();
      await worker.stop();
      await exhausted.end();
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(await rowCount(pool, 'orders')).toBe(0);
    expect(await rowCount(pool, 'webhook_events')).toBe(1);
  });
});
