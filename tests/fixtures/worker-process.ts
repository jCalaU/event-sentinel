import pino from 'pino';
import { createEventSentinel, createPostgresStore } from '../../src/index.js';
import {
  databasePool,
  insertOrder,
  phoneNumberId,
  secret,
} from '../helpers.js';

const pool = databasePool();
const mode = process.env.TEST_WORKER_MODE ?? 'normal';
const sentinel = createEventSentinel({
  webhookSecret: secret,
  phoneNumberId,
  store: createPostgresStore(pool),
  logger: pino({ enabled: false }),
  worker: {
    pollIntervalMs: 10,
    handlerTimeoutMs: 150,
    leaseMs: 500,
    shutdownTimeoutMs: 1_000,
    retryBaseMs: 10,
    maxAttempts: 5,
  },
  onMessage: async (event, context) => {
    await insertOrder(event, context);
    if (mode === 'block') {
      await context.transaction.query(
        'UPDATE orders SET product = $1 WHERE message_id = $2',
        ['stale-owner', event.message.id],
      );
    }
    process.send?.({ type: 'handling', messageId: event.message.id });
    if (mode === 'hang') await new Promise(() => {});
    if (mode === 'block') {
      // Stall this process so its timeout cannot run before the lease expires.
      const until = Date.now() + 2_000;
      while (Date.now() < until) {
        // The successor runs in another process and remains able to poll.
      }
      process.send?.({ type: 'late-return', messageId: event.message.id });
    }
  },
});

const worker = sentinel.startWorker();
process.send?.({ type: 'ready' });
process.on('message', (message: unknown) => {
  if (message === 'stop') {
    void worker.stop().then(async () => {
      await pool.end();
      process.disconnect?.();
    });
  }
});
