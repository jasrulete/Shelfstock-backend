import dotenv from 'dotenv';
dotenv.config();

import { createApp } from './app';
import { startWinbackSchedule } from './jobs/winback';

// Fail fast at boot rather than at the first login attempt: a missing
// JWT_SECRET would otherwise sign tokens with the string "undefined".
if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) {
  console.error('FATAL: JWT_SECRET is missing or too short (need 32+ chars). Set it in .env');
  process.exit(1);
}
if (!process.env.DATABASE_URL) {
  console.error('FATAL: DATABASE_URL is not set. Set it in .env');
  process.exit(1);
}

const PORT = process.env.PORT ? Number(process.env.PORT) : 4000;

const app = createApp();

app.listen(PORT, () => {
  console.log(`ShelfStock API listening on port ${PORT}`);
  startWinbackSchedule();
});
