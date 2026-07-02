import { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { JwtPayload } from '../types';

const JWT_SECRET = process.env.JWT_SECRET as string;

/**
 * Verifies the Bearer JWT on the request and attaches the decoded payload
 * to req.user. This ONLY proves "who is this request from" - it does not
 * by itself authorize access to any particular resource. Route handlers
 * that touch user-owned data (e.g. orders) must additionally compare
 * req.user.id against the resource's owner id. See routes/orders.ts.
 */
export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing or malformed Authorization header' });
  }

  const token = header.slice('Bearer '.length);

  try {
    const payload = jwt.verify(token, JWT_SECRET) as JwtPayload;
    req.user = payload;
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}
