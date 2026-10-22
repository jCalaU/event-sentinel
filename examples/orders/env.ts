import { z } from 'zod';
import pg from 'pg';
import { createEventSentinel, createPostgresStore } from '../../src/index.js';
import { orderHandler } from './handler.js';

export const envSchema = z.object({
  DATABASE_URL: z.string().url(),
  KAPSO_WEBHOOK_SECRET: z.string().min(1),
  KAPSO_PHONE_NUMBER_ID: z.string().min(1),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  RUN_WORKER: z.enum(['true', 'false']).default('true'),
});
export function createExample() {
  const env = envSchema.parse(process.env);
  const pool = new pg.Pool({
    connectionString: env.DATABASE_URL,
    connectionTimeoutMillis: 2000,
    statement_timeout: 3000,
  });
  // Do not emit database error objects: they may include SQL or private data.
  pool.on('error', () => {
    console.error('Idle database connection failed');
  });
  const sentinel = createEventSentinel({
    webhookSecret: env.KAPSO_WEBHOOK_SECRET,
    phoneNumberId: env.KAPSO_PHONE_NUMBER_ID,
    store: createPostgresStore(pool),
    onMessage: orderHandler,
  });
  return { env, pool, sentinel };
}
