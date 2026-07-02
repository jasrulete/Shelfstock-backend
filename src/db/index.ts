import { Pool } from 'pg';

// A single shared connection pool for the whole process. pg handles
// connection reuse/queueing internally, so routes just call pool.query().
export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Railway/Render Postgres typically requires SSL in production but not
  // locally. This flag lets both environments work without extra config.
  ssl: process.env.DATABASE_URL?.includes('localhost')
    ? false
    : { rejectUnauthorized: false },
});

pool.on('error', (err) => {
  // Unexpected errors on idle clients shouldn't crash the whole process.
  console.error('Unexpected PostgreSQL error on idle client', err);
});
