import bcrypt from 'bcrypt';
import { Router } from 'express';
import jwt from 'jsonwebtoken';
import { pool } from '../db';
import { PublicUser, User } from '../types';

const router = Router();
const JWT_SECRET = process.env.JWT_SECRET as string;
const SALT_ROUNDS = 10;

function toPublicUser(user: User): PublicUser {
  return { id: user.id, email: user.email, role: user.role };
}

function signToken(user: PublicUser): string {
  return jwt.sign({ userId: user.id, role: user.role }, JWT_SECRET, {
    expiresIn: '7d',
  });
}

router.post('/register', async (req, res) => {
  const { email, password } = req.body ?? {};

  if (typeof email !== 'string' || typeof password !== 'string') {
    return res.status(400).json({ error: 'email and password are required' });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
  }

  const normalizedEmail = email.trim().toLowerCase();

  try {
    const existing = await pool.query('SELECT id FROM users WHERE email = $1', [normalizedEmail]);
    if (existing.rows.length > 0) {
      return res.status(409).json({ error: 'An account with that email already exists' });
    }

    // Never store plaintext passwords - bcrypt hashes + salts in one step.
    const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);

    const result = await pool.query<User>(
      `INSERT INTO users (email, password_hash, role)
       VALUES ($1, $2, 'customer')
       RETURNING id, email, password_hash, role, created_at`,
      [normalizedEmail, passwordHash]
    );

    const user = toPublicUser(result.rows[0]);
    const token = signToken(user);
    res.status(201).json({ user, token });
  } catch (err) {
    console.error('Register error:', err);
    res.status(500).json({ error: 'Failed to register' });
  }
});

router.post('/login', async (req, res) => {
  const { email, password } = req.body ?? {};

  if (typeof email !== 'string' || typeof password !== 'string') {
    return res.status(400).json({ error: 'email and password are required' });
  }

  try {
    const result = await pool.query<User>('SELECT * FROM users WHERE email = $1', [
      email.trim().toLowerCase(),
    ]);
    const user = result.rows[0];

    // Same error message whether the email doesn't exist or the password is
    // wrong, so we don't leak which emails are registered.
    if (!user) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const matches = await bcrypt.compare(password, user.password_hash);
    if (!matches) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const publicUser = toPublicUser(user);
    const token = signToken(publicUser);
    res.json({ user: publicUser, token });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Failed to log in' });
  }
});

export default router;
