import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { z } from 'zod';

const connectionString = z.string().url().parse(process.env.DATABASE_URL);
const pool = new pg.Pool({ connectionString, connectionTimeoutMillis: 2000 });
const client = await pool.connect();
try {
  await client.query('BEGIN');
  await client.query('SELECT pg_advisory_xact_lock(17013001)');
  await client.query(
    await readFile(
      new URL('../migrations/001_init.sql', import.meta.url),
      'utf8',
    ),
  );
  await client.query(
    await readFile(
      new URL('../examples/orders/schema.sql', import.meta.url),
      'utf8',
    ),
  );
  await client.query('COMMIT');
  console.log('Library and example tables ready');
} catch {
  await client.query('ROLLBACK');
  console.error('Migration failed');
  process.exitCode = 1;
} finally {
  client.release();
  await pool.end();
}
