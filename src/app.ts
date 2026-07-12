import cors from 'cors';
import express from 'express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import analyticsRoutes from './routes/analytics';
import authRoutes from './routes/auth';
import categoriesRoutes from './routes/categories';
import ordersRoutes from './routes/orders';
import productsRoutes from './routes/products';

export function createApp() {
  const app = express();

  // Behind Railway/Render's proxy the client IP arrives in
  // X-Forwarded-For; without this, rate limiting would key every request
  // to the proxy's IP and throttle all users together.
  app.set('trust proxy', 1);

  const allowedOrigins = (process.env.CORS_ORIGIN ?? 'http://localhost:3000')
    .split(',')
    .map((s) => s.trim());

  app.use(helmet());
  app.use(cors({ origin: allowedOrigins }));
  app.use(express.json({ limit: '100kb' }));

  // General limit is generous (browsing fires many requests); the auth
  // limit is tight because login/register are the brute-force targets.
  app.use(
    '/api',
    rateLimit({ windowMs: 15 * 60 * 1000, max: 500, standardHeaders: true, legacyHeaders: false })
  );
  const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 20,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many attempts, please try again later' },
  });

  app.get('/health', (_req, res) => res.json({ status: 'ok' }));

  app.use('/api/auth', authLimiter, authRoutes);
  app.use('/api/products', productsRoutes);
  app.use('/api/categories', categoriesRoutes);
  app.use('/api/orders', ordersRoutes);
  app.use('/api/analytics', analyticsRoutes);

  // Centralized 404 for unmatched API routes
  app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found' }));

  return app;
}
