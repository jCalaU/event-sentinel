import pg from 'pg';
import { z } from 'zod';
const pool = new pg.Pool({
  connectionString: z.string().url().parse(process.env.DATABASE_URL),
});
try {
  const { rows } = await pool.query(
    'SELECT message_id, product, quantity FROM orders ORDER BY created_at',
  );
  console.table(rows);
} finally {
  await pool.end();
}
