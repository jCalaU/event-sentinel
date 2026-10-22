import type { ChildProcess } from 'node:child_process';
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
  clearDatabase,
  databasePool,
  eventState,
  eventually,
  insertOrder,
  makeSentinel,
  prepareDatabase,
  rowCount,
  signedRequest,
} from './helpers.js';
import {
  killWorkerProcess,
  startWorkerProcess,
  stopWorkerProcess,
} from './process-helpers.js';

describe('worker failure recovery and ownership', () => {
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

  it('recovers work stored before the worker starts', async () => {
    await makeSentinel(pool).ingest(signedRequest());
    expect((await eventState(pool))?.state).toBe('pending');
    workers.push(makeSentinel(pool).startWorker());
    await eventually(
      async () => (await eventState(pool))?.state === 'completed',
      'Durable pending work was lost',
    );
    expect(await rowCount(pool, 'orders')).toBe(1);
  });

  it('recovers an expired lease after a process dies with uncommitted business work', async () => {
    await makeSentinel(pool).ingest(signedRequest());
    const crashed = startWorkerProcess('hang');
    processes.push(crashed.child);
    await crashed.waitFor('handling');
    expect(await rowCount(pool, 'orders')).toBe(0);
    expect((await eventState(pool))?.state).toBe('processing');
    await killWorkerProcess(crashed.child);
    workers.push(makeSentinel(pool).startWorker());
    await eventually(
      async () => (await eventState(pool))?.state === 'completed',
      'Expired lease was not recovered after SIGKILL',
    );
    expect(await eventState(pool)).toMatchObject({ attempts: 2 });
    expect(await rowCount(pool, 'orders')).toBe(1);
  });

  it('prevents a late handler from using its transaction after timeout', async () => {
    let calls = 0;
    let lateQueryRejected = false;
    let observedAbort = false;
    const sentinel = makeSentinel(pool, {
      onMessage: async (event, context) => {
        calls++;
        await insertOrder(event, context);
        if (calls === 1) {
          context.signal.addEventListener('abort', () => {
            observedAbort = true;
          });
          await new Promise((resolve) => setTimeout(resolve, 650));
          try {
            await context.transaction.query(
              'INSERT INTO orders (message_id, product, quantity) VALUES ($1, $2, $3)',
              ['wamid.stale-effect', 'shirt', 1],
            );
          } catch {
            lateQueryRejected = true;
          }
        }
      },
    });
    await sentinel.ingest(signedRequest());
    workers.push(sentinel.startWorker());
    await eventually(
      async () => (await eventState(pool))?.state === 'completed',
      'Timed-out work did not retry',
    );
    await eventually(
      async () => lateQueryRejected,
      'Stale transaction accepted a late query',
    );
    expect(observedAbort).toBe(true);
    expect(await eventState(pool)).toMatchObject({ attempts: 2 });
    expect(await rowCount(pool, 'orders')).toBe(1);
  });

  it('fences a worker process whose event loop stalls beyond its lease', async () => {
    await makeSentinel(pool).ingest(signedRequest());
    const stale = startWorkerProcess('block');
    processes.push(stale.child);
    await stale.waitFor('handling');
    const successor = startWorkerProcess();
    processes.push(successor.child);
    await successor.waitFor('ready');
    await eventually(
      async () => (await eventState(pool))?.state === 'completed',
      'The successor could not recover work while the old process stayed blocked',
      1_500,
    );
    expect(stale.hasMessage('late-return')).toBe(false);
    expect((await eventState(pool))?.attempts).toBeGreaterThanOrEqual(2);
    expect(await rowCount(pool, 'orders')).toBe(1);
    expect(
      (await pool.query('SELECT product FROM orders')).rows[0].product,
    ).toBe('shirt');
    await stale.waitFor('late-return');
    await stopWorkerProcess(stale.child);
    expect(
      (await pool.query('SELECT product FROM orders')).rows[0].product,
    ).toBe('shirt');
  });

  it('checks the database lease deadline again before committing business work', async () => {
    let calls = 0;
    const sentinel = makeSentinel(pool, {
      onMessage: async (event, context) => {
        calls++;
        await insertOrder(event, context);
        if (calls === 1) {
          await context.transaction.query(
            'UPDATE orders SET product = $1 WHERE message_id = $2',
            ['expired-owner', event.message.id],
          );
          await context.transaction.query(
            `UPDATE webhook_events SET lease_until = clock_timestamp() - interval '1 second'
             WHERE id = $1`,
            [context.eventId],
          );
        }
      },
    });
    await sentinel.ingest(signedRequest());
    workers.push(sentinel.startWorker());
    await eventually(
      async () => (await eventState(pool))?.state === 'completed',
      'Expired ownership did not retry',
    );
    expect(calls).toBe(2);
    expect(await eventState(pool)).toMatchObject({ attempts: 2 });
    expect(await rowCount(pool, 'orders')).toBe(1);
    expect(
      (await pool.query('SELECT product FROM orders')).rows[0].product,
    ).toBe('shirt');
  });

  it('marks work dead after bounded failures and keeps private error text out of storage', async () => {
    const privateText =
      'message body: buy a private item; phone: +15555550123; token: secret-token';
    const sentinel = makeSentinel(pool, {
      onMessage: async (event, context) => {
        await insertOrder(event, context);
        throw new Error(privateText.repeat(100));
      },
    });
    await sentinel.ingest(signedRequest());
    workers.push(sentinel.startWorker());
    await eventually(
      async () => (await eventState(pool))?.state === 'dead',
      'Failed work was not marked dead',
    );
    const state = await eventState(pool);
    expect(state?.attempts).toBe(3);
    expect(state?.last_error).toBeTruthy();
    expect(state?.last_error?.length).toBeLessThanOrEqual(1_000);
    expect(state?.last_error).not.toContain('private item');
    expect(state?.last_error).not.toContain('+15555550123');
    expect(state?.last_error).not.toContain('secret-token');
    expect(await rowCount(pool, 'orders')).toBe(0);
  });

  it('counts a crashed final attempt toward the limit instead of retrying forever', async () => {
    await makeSentinel(pool).ingest(signedRequest());
    await pool.query(`UPDATE webhook_events SET state = 'processing', attempts = 3,
      lease_token = gen_random_uuid(), lease_until = clock_timestamp() - interval '1 second'`);
    workers.push(makeSentinel(pool).startWorker());
    await eventually(
      async () => (await eventState(pool))?.state === 'dead',
      'Expired final attempt did not become dead',
    );
    expect((await eventState(pool))?.attempts).toBe(3);
    expect(await rowCount(pool, 'orders')).toBe(0);
  });

  it.each(['COMMIT', 'SELECT 1; COMMIT'])(
    'rejects transaction escape through %s',
    async (statement) => {
      const sentinel = makeSentinel(pool, {
        onMessage: async (event, context) => {
          await insertOrder(event, context);
          await context.transaction.query(statement);
        },
      });
      await sentinel.ingest(signedRequest());
      workers.push(sentinel.startWorker());
      await eventually(
        async () => (await eventState(pool))?.state === 'dead',
        'Invalid transaction commands did not fail the handler',
      );
      expect(await rowCount(pool, 'orders')).toBe(0);
    },
  );
});
