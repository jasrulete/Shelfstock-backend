// Seed two demo accounts so reviewers can try both sides of the app:
//   admin@shelfstock.demo   / ShelfAdmin123    (admin  — dashboard, order mgmt)
//   shopper@shelfstock.demo / ShelfShopper123  (customer — browse, checkout)
//
// Idempotent: re-running only resets these two demo accounts' passwords, never
// touches real users, products, or orders. Run it wherever DATABASE_URL points:
//   local:   node scripts/seed-demo-users.js
//   Railway: railway run node scripts/seed-demo-users.js
require('dotenv').config();
const bcrypt = require('bcrypt');
const { Pool } = require('pg');

const DEMO_USERS = [
  { email: 'admin@shelfstock.demo', password: 'ShelfAdmin123', role: 'admin' },
  { email: 'shopper@shelfstock.demo', password: 'ShelfShopper123', role: 'customer' },
];

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('localhost') ? false : { rejectUnauthorized: false },
});

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is not set.');
    process.exit(1);
  }
  for (const u of DEMO_USERS) {
    const hash = await bcrypt.hash(u.password, 10);
    await pool.query(
      `INSERT INTO users (email, password_hash, role)
       VALUES ($1, $2, $3)
       ON CONFLICT (email)
       DO UPDATE SET password_hash = EXCLUDED.password_hash, role = EXCLUDED.role`,
      [u.email, hash, u.role]
    );
    console.log(`seeded ${u.role.padEnd(8)} ${u.email}  /  ${u.password}`);
  }
  await pool.end();
  console.log('\nDemo accounts ready.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
