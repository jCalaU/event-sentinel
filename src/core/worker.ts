import type { PoolClient, QueryConfig, QueryResultRow } from 'pg';
import type { Logger } from 'pino';
import type { PostgresStore } from '../db/postgres.js';
import {
  claimEvent,
  completeOwnedEvent,
  failOwnedEvent,
  lockOwnedEvent,
  oldestPendingAgeMs,
  type ClaimedEvent,
} from '../db/queries.js';
import type {
  MessageEvent,
  MessageHandler,
  Transaction,
  WorkerController,
  WorkerOptions,
} from './types.js';

export type ResolvedWorkerOptions = Required<WorkerOptions> & {
  phoneNumberId: string;
};

class WorkStopped extends Error {
  constructor(
    readonly reason: 'handler_timeout' | 'lease_lost' | 'shutdown_timeout',
  ) {
    super(reason);
  }
}

function fromRow(row: ClaimedEvent): MessageEvent {
  return {
    logicalId: JSON.stringify([
      row.phone_number_id,
      row.event_type,
      row.message_id,
    ]),
    eventType: row.event_type,
    phoneNumberId: row.phone_number_id,
    message: row.payload.message,
    payload: row.payload,
  };
}

// Strip comments before checking the first command. Extended protocol rejects
// multiple commands, so a later statement cannot commit the shared transaction.
function checkStatement(text: string): void {
  let remaining = text.trimStart();
  while (remaining.startsWith('--') || remaining.startsWith('/*')) {
    if (remaining.startsWith('--')) {
      const end = remaining.indexOf('\n');
      remaining = end < 0 ? '' : remaining.slice(end + 1).trimStart();
    } else {
      const end = remaining.indexOf('*/', 2);
      if (end < 0) throw new Error('An SQL statement is required');
      remaining = remaining.slice(end + 2).trimStart();
    }
  }
  if (!/^(?:SELECT|INSERT|UPDATE|DELETE|WITH)\b/i.test(remaining)) {
    throw new Error(
      'Use one SELECT, INSERT, UPDATE, DELETE, or WITH statement',
    );
  }
}

async function runHandler(
  client: PoolClient,
  destroy: () => void,
  event: ClaimedEvent,
  handler: MessageHandler,
  options: ResolvedWorkerOptions,
  shutdown: AbortSignal,
): Promise<void> {
  const abort = new AbortController();
  let active = true;
  let settled = false;
  let destroyed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let rejectTimeout: ((error: Error) => void) | undefined;
  const cancel = (reason: 'handler_timeout' | 'shutdown_timeout') => {
    if (settled) return;
    active = false;
    abort.abort();
    // Closing this connection rolls back all local effects and also interrupts
    // an in-flight query. A late JavaScript callback only sees the gated wrapper.
    destroyed = true;
    destroy();
    rejectTimeout?.(new WorkStopped(reason));
  };
  const onConnectionError = () => cancel('handler_timeout');
  const onShutdown = () => cancel('shutdown_timeout');
  client.on('error', onConnectionError);
  shutdown.addEventListener('abort', onShutdown, { once: true });
  const transaction: Transaction = {
    async query<R extends QueryResultRow = QueryResultRow>(
      text: string,
      values: unknown[] = [],
    ) {
      if (!active) throw new Error('The handler transaction has ended');
      checkStatement(text);
      const config: QueryConfig & { queryMode: 'extended' } = {
        text,
        values,
        queryMode: 'extended',
      };
      return client.query<R>(config);
    },
  };
  const timeout = new Promise<never>((_resolve, reject) => {
    rejectTimeout = reject;
    timer = setTimeout(
      () => cancel('handler_timeout'),
      options.handlerTimeoutMs,
    );
  });
  const work = async () => {
    await client.query('BEGIN');
    // PostgreSQL releases the row lock even if JavaScript stalls and its timer
    // cannot run. Network queries and idle handler time are both bounded.
    await client.query(
      `SELECT set_config('statement_timeout', $1, true),
         set_config('idle_in_transaction_session_timeout', $1, true)`,
      [String(options.handlerTimeoutMs)],
    );
    if (!(await lockOwnedEvent(client, event)))
      throw new WorkStopped('lease_lost');
    await handler(fromRow(event), {
      transaction,
      signal: abort.signal,
      eventId: event.id,
    });
    if (!active) throw new WorkStopped('handler_timeout');
    active = false;
    if (!(await completeOwnedEvent(client, event)))
      throw new WorkStopped('lease_lost');
    await client.query('COMMIT');
  };
  try {
    await Promise.race([work(), timeout]);
  } catch (error) {
    active = false;
    abort.abort();
    if (!destroyed) await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    settled = true;
    active = false;
    if (timer) clearTimeout(timer);
    shutdown.removeEventListener('abort', onShutdown);
    client.off('error', onConnectionError);
  }
}

/** Covers acquisition and every query, including claim, health, and retry writes. */
async function withWorkerClient<T>(
  store: PostgresStore,
  shutdown: AbortSignal,
  operation: (client: PoolClient, destroy: () => void) => Promise<T>,
): Promise<T> {
  if (shutdown.aborted) throw new WorkStopped('shutdown_timeout');
  let client: PoolClient | undefined;
  let released = false;
  let cancelled = false;
  let rejectShutdown: (error: Error) => void = () => undefined;
  const onConnectionError = () => undefined;
  const release = (destroy = false) => {
    if (!client || released) return;
    released = true;
    const connection = client;
    if (destroy) {
      // End while checked out, so pg-pool does not observe an expected closing
      // socket as an idle-client failure. Return it only after all errors end.
      void connection.end().then(() => {
        connection.off('error', onConnectionError);
        connection.release(true);
      });
    } else {
      connection.off('error', onConnectionError);
      connection.release();
    }
  };
  const onShutdown = () => {
    cancelled = true;
    release(true);
    rejectShutdown(new WorkStopped('shutdown_timeout'));
  };
  const stopped = new Promise<never>((_resolve, reject) => {
    rejectShutdown = reject;
  });
  shutdown.addEventListener('abort', onShutdown, { once: true });
  const work = async () => {
    client = await store.pool.connect();
    client.on('error', onConnectionError);
    if (cancelled || shutdown.aborted) {
      release(true);
      throw new WorkStopped('shutdown_timeout');
    }
    return operation(client, () => release(true));
  };
  try {
    return await Promise.race([work(), stopped]);
  } catch (error) {
    // A caller's driver query timeout may reject while SQL is still active.
    // Never return a failed operation's connection to the shared pool.
    release(true);
    throw error;
  } finally {
    shutdown.removeEventListener('abort', onShutdown);
    // A cancelled acquire releases its client when it eventually resolves.
    release();
  }
}

/** Returns immediately. Await controller.stop() before closing the pool. */
export function startWorker(
  store: PostgresStore,
  handler: MessageHandler,
  options: ResolvedWorkerOptions,
  logger: Logger,
  { signal }: { signal?: AbortSignal } = {},
): WorkerController {
  let stopping = signal?.aborted ?? false;
  const shutdown = new AbortController();
  let wake: (() => void) | undefined;
  let shutdownTimer: ReturnType<typeof setTimeout> | undefined;
  const requestStop = () => {
    if (stopping) return;
    stopping = true;
    wake?.();
    shutdownTimer = setTimeout(
      () => shutdown.abort(),
      options.shutdownTimeoutMs,
    );
  };
  signal?.addEventListener('abort', requestStop, { once: true });
  const pause = () =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        wake = undefined;
        resolve();
      }, options.pollIntervalMs);
      wake = () => {
        clearTimeout(timer);
        wake = undefined;
        resolve();
      };
    });
  const done = (async () => {
    let nextHealthLog = 0;
    try {
      while (!stopping) {
        try {
          const { event, expiredDead } = await withWorkerClient(
            store,
            shutdown.signal,
            (client) =>
              claimEvent(
                client,
                options.phoneNumberId,
                options.maxAttempts,
                options.leaseMs,
              ),
          );
          if (expiredDead > 0) {
            logger.warn(
              {
                outcome: 'dead',
                dead: expiredDead,
                reason: 'worker_lease_expired',
              },
              'Expired events reached the attempt limit',
            );
          }
          // A claim already committed while shutdown arrived stays recoverable.
          if (stopping) break;
          if (Date.now() >= nextHealthLog) {
            const age = await withWorkerClient(
              store,
              shutdown.signal,
              (client) => oldestPendingAgeMs(client, options.phoneNumberId),
            );
            logger.info(
              { outcome: 'worker_health', oldestPendingAgeMs: age },
              'Worker queue age',
            );
            nextHealthLog = Date.now() + 30_000;
          }
          if (stopping) break;
          if (!event) {
            await pause();
            continue;
          }
          logger.info(
            { outcome: 'process', eventId: event.id, attempt: event.attempts },
            'Processing event',
          );
          try {
            const completed = await withWorkerClient(
              store,
              shutdown.signal,
              async (client, destroy) => {
                if (stopping) return false;
                await runHandler(
                  client,
                  destroy,
                  event,
                  handler,
                  options,
                  shutdown.signal,
                );
                return true;
              },
            );
            if (!completed) break;
            logger.info(
              { outcome: 'completed', eventId: event.id, completed: 1 },
              'Completed event',
            );
          } catch (error) {
            const reason =
              error instanceof WorkStopped ? error.reason : 'handler_failed';
            // Forced shutdown leaves the lease for recovery. It must not wait
            // for another database operation after the shutdown deadline.
            if (shutdown.signal.aborted) break;
            const backoff = Math.min(
              options.retryBaseMs * 2 ** Math.min(event.attempts - 1, 20),
              60_000,
            );
            const delay = Math.floor(backoff * (0.5 + Math.random() * 0.5));
            const outcome = await withWorkerClient(
              store,
              shutdown.signal,
              (client) =>
                failOwnedEvent(
                  client,
                  event,
                  options.maxAttempts,
                  delay,
                  reason,
                ),
            );
            logger.warn(
              { outcome, eventId: event.id, attempt: event.attempts, reason },
              'Event processing failed',
            );
          }
        } catch {
          if (shutdown.signal.aborted) break;
          // Errors can contain SQL data or credentials. Log only a safe code.
          logger.error(
            { outcome: 'worker_database_error' },
            'Worker database operation failed',
          );
          if (!stopping) await pause();
        }
      }
    } finally {
      signal?.removeEventListener('abort', requestStop);
      if (shutdownTimer) clearTimeout(shutdownTimer);
    }
  })();
  return {
    done,
    async stop() {
      requestStop();
      await done;
    },
  };
}
