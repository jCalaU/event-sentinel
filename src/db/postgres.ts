import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { MessageEvent } from '../core/types.js';

export interface PostgresStore {
  pool: Pool;
  persist(
    events: MessageEvent[],
    deliveryKey?: string,
  ): Promise<{ inserted: number; duplicates: number }>;
}

/** The caller owns the pool and closes it after every worker has stopped. */
export function createPostgresStore(pool: Pool): PostgresStore {
  if (pool.options.pipeline) throw new Error('Pipeline mode is not supported');
  const connectionTimeout = pool.options.connectionTimeoutMillis;
  if (
    !Number.isInteger(connectionTimeout) ||
    !connectionTimeout ||
    connectionTimeout < 1 ||
    connectionTimeout > 3_000
  ) {
    throw new Error('Set pool connectionTimeoutMillis between 1 and 3000');
  }
  return {
    pool,
    async persist(events, deliveryKey) {
      const client = await pool.connect();
      let expired = false;
      let released = false;
      // Keep a listener until a forcibly closed socket has ended.
      const onConnectionError = () => undefined;
      client.on('error', onConnectionError);
      const release = (destroy = false) => {
        if (released) return;
        released = true;
        if (destroy) {
          // Keep the client checked out while it closes. Releasing first adds
          // pg-pool's idle error listener during an expected timeout failure.
          void client.end().then(() => {
            client.off('error', onConnectionError);
            client.release(true);
          });
        } else {
          client.off('error', onConnectionError);
          client.release();
        }
      };
      const guard = () => {
        if (expired) throw new Error('Database transaction timed out');
      };
      // Together with the pool's <= 3 second acquire limit, leave time for the
      // HTTP response before Kapso's 10 second delivery deadline.
      const timer = setTimeout(() => {
        expired = true;
        release(true);
      }, 6_000);
      let inserted = 0;
      try {
        await client.query('BEGIN');
        guard();
        await client.query("SET LOCAL statement_timeout = '3000ms'");
        guard();
        await client.query("SET LOCAL lock_timeout = '2000ms'");
        guard();
        // A fixed insert order avoids deadlocks between overlapping batches.
        const ordered = [...events].sort((a, b) =>
          a.logicalId < b.logicalId ? -1 : a.logicalId > b.logicalId ? 1 : 0,
        );
        for (const event of ordered) {
          guard();
          const result = await client.query(
            `INSERT INTO webhook_events
              (id, phone_number_id, event_type, message_id, payload, delivery_key)
             VALUES ($1, $2, $3, $4, $5::jsonb, $6)
             ON CONFLICT (phone_number_id, event_type, message_id) DO NOTHING`,
            [
              randomUUID(),
              event.phoneNumberId,
              event.eventType,
              event.message.id,
              JSON.stringify(event.payload),
              deliveryKey ?? null,
            ],
          );
          inserted += result.rowCount ?? 0;
        }
        guard();
        await client.query('COMMIT');
        guard();
        return { inserted, duplicates: events.length - inserted };
      } catch (error) {
        if (!released)
          await client.query('ROLLBACK').catch(() => release(true));
        throw error;
      } finally {
        clearTimeout(timer);
        release();
      }
    },
  };
}
