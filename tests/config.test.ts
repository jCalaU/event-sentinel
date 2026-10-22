import pg from 'pg';
import { describe, expect, it } from 'vitest';
import { createPostgresStore } from '../src/index.js';

describe('PostgreSQL pool safety settings', () => {
  it.each([undefined, 0, -1, 1.5, 3_001])(
    'rejects unbounded connection timeout %s',
    async (connectionTimeoutMillis) => {
      const pool = new pg.Pool({ connectionTimeoutMillis });
      try {
        expect(() => createPostgresStore(pool)).toThrow(
          'Set pool connectionTimeoutMillis between 1 and 3000',
        );
      } finally {
        await pool.end();
      }
    },
  );

  it.each([1, 3_000])(
    'accepts bounded connection timeout %s',
    async (connectionTimeoutMillis) => {
      const pool = new pg.Pool({ connectionTimeoutMillis });
      try {
        expect(createPostgresStore(pool).pool).toBe(pool);
      } finally {
        await pool.end();
      }
    },
  );

  it('rejects pipeline mode because timeout must close the active query', async () => {
    const pool = new pg.Pool({
      connectionTimeoutMillis: 3_000,
      pipeline: true,
    });
    try {
      expect(() => createPostgresStore(pool)).toThrow(
        'Pipeline mode is not supported',
      );
    } finally {
      await pool.end();
    }
  });
});
