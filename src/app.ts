import cors from 'cors';
import express from 'express';
import analyticsRoutes from './routes/analytics';
import authRoutes from './routes/auth';
import ordersRoutes from './routes/orders';
import productsRoutes from './routes/products';

export function createApp() {
  const app = express();

  const allowedOrigins = (process.env.CORS_ORIGIN ?? 'http://localhost:3000')
    .split(',')
    .map((s) => s.trim());

  app.use(cors({ origin: allowedOrigins }));
  app.use(express.json());

  app.get('/health', (_req, res) => res.json({ status: 'ok' }));

  app.use('/api/auth', authRoutes);
  app.use('/api/products', productsRoutes);
  app.use('/api/orders', ordersRoutes);
  app.use('/api/analytics', analyticsRoutes);

  // Centralized 404 for unmatched API routes
  app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found' }));

  return app;
}
