// Promote an existing user to admin.
// Usage: node scripts/create-admin.js user@example.com
// (register the account through the app first, then run this)
require('dotenv').config();
const { Pool } = require('pg');

const email = process.argv[2];
if (!email) {
  console.error('Usage: node scripts/create-admin.js <email>');
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('localhost') ? false : { rejectUnauthorized: false },
});

pool
  .query(`UPDATE users SET role = 'admin' WHERE email = $1 RETURNING id, email, role`, [
    email.trim().toLowerCase(),
  ])
  .then((result) => {
    if (result.rows.length === 0) {
      console.error(`No user found with email "${email}". Register the account first.`);
      process.exit(1);
    }
    console.log(`${result.rows[0].email} is now an admin.`);
    return pool.end();
  })
  .catch((err) => {
    console.error('Failed to promote user:', err.message);
    process.exit(1);
  });
