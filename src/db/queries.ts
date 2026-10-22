import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { ReceivedPayload } from '../kapso/schema.js';

type Database = Pick<Pool, 'query'>;

export interface ClaimedEvent {
  id: string;
  phone_number_id: string;
  event_type: 'whatsapp.message.received';
  message_id: string;
  payload: ReceivedPayload;
  attempts: number;
  lease_token: string;
  lease_until: Date;
}

export async function claimEvent(
  pool: Database,
  phoneNumberId: string,
  maxAttempts: number,
  leaseMs: number,
): Promise<{ event: ClaimedEvent | undefined; expiredDead: number }> {
  // SKIP LOCKED also protects an expired job whose old transaction is rolling back.
  const expired = await pool.query(
    `WITH exhausted AS (
       SELECT id FROM webhook_events
       WHERE phone_number_id = $1 AND state = 'processing'
         AND lease_until <= clock_timestamp() AND attempts >= $2
       FOR UPDATE SKIP LOCKED LIMIT 100
     )
     UPDATE webhook_events e SET state = 'dead', lease_until = NULL,
       lease_token = NULL, last_error = 'worker_lease_expired', updated_at = clock_timestamp()
     FROM exhausted WHERE e.id = exhausted.id`,
    [phoneNumberId, maxAttempts],
  );
  const result = await pool.query<ClaimedEvent>(
    `WITH due AS (
       SELECT id FROM webhook_events
       WHERE phone_number_id = $1 AND attempts < $2
         AND ((state = 'pending' AND available_at <= clock_timestamp())
           OR (state = 'processing' AND lease_until <= clock_timestamp()))
       ORDER BY available_at, created_at, id
       FOR UPDATE SKIP LOCKED LIMIT 1
     )
     UPDATE webhook_events e SET state = 'processing', attempts = attempts + 1,
       lease_until = clock_timestamp() + ($3::double precision * interval '1 millisecond'),
       lease_token = $4, updated_at = clock_timestamp()
     FROM due WHERE e.id = due.id
     RETURNING e.id, e.phone_number_id, e.event_type, e.message_id,
       e.payload, e.attempts, e.lease_token, e.lease_until`,
    [phoneNumberId, maxAttempts, leaseMs, randomUUID()],
  );
  return { event: result.rows[0], expiredDead: expired.rowCount ?? 0 };
}

export async function lockOwnedEvent(
  client: PoolClient,
  event: ClaimedEvent,
): Promise<boolean> {
  const result = await client.query(
    `SELECT id FROM webhook_events
     WHERE id = $1 AND state = 'processing' AND lease_token = $2
       AND lease_until > clock_timestamp()
     FOR UPDATE`,
    [event.id, event.lease_token],
  );
  return result.rowCount === 1;
}

export async function completeOwnedEvent(
  client: PoolClient,
  event: ClaimedEvent,
): Promise<boolean> {
  const result = await client.query(
    `UPDATE webhook_events SET state = 'completed', lease_until = NULL,
       lease_token = NULL, last_error = NULL, updated_at = clock_timestamp()
     WHERE id = $1 AND state = 'processing' AND lease_token = $2
       AND lease_until > clock_timestamp()`,
    [event.id, event.lease_token],
  );
  return result.rowCount === 1;
}

export async function failOwnedEvent(
  pool: Database,
  event: ClaimedEvent,
  maxAttempts: number,
  delayMs: number,
  reason: string,
): Promise<'retry' | 'dead' | 'lost'> {
  const dead = event.attempts >= maxAttempts;
  const result = await pool.query(
    `UPDATE webhook_events SET state = $3, lease_until = NULL, lease_token = NULL,
       available_at = clock_timestamp() + ($4::double precision * interval '1 millisecond'),
       last_error = $5, updated_at = clock_timestamp()
     WHERE id = $1 AND state = 'processing' AND lease_token = $2`,
    [
      event.id,
      event.lease_token,
      dead ? 'dead' : 'pending',
      delayMs,
      reason.slice(0, 160),
    ],
  );
  return result.rowCount === 1 ? (dead ? 'dead' : 'retry') : 'lost';
}

export async function oldestPendingAgeMs(
  pool: Database,
  phoneNumberId: string,
): Promise<number> {
  const result = await pool.query<{ age_ms: string | null }>(
    `SELECT EXTRACT(EPOCH FROM (clock_timestamp() - MIN(created_at))) * 1000 AS age_ms
     FROM webhook_events WHERE phone_number_id = $1 AND state IN ('pending', 'processing')`,
    [phoneNumberId],
  );
  return Math.max(0, Number(result.rows[0]?.age_ms ?? 0));
}
