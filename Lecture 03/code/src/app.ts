import express, { Request, Response, NextFunction } from 'express';
import { healthRouter } from './routes/health.routes.js';
import { summarizerRouter } from './routes/summarizer.routes.js';

export const app = express();

// Middleware: parse incoming application/json payloads up to 2MB
app.use(express.json({ limit: '2mb' }));

// Middleware: request logger
app.use((req: Request, _res: Response, next: NextFunction) => {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] ${req.method} ${req.path}`);
  next();
});

// Mount Routes
app.use(healthRouter);
app.use('/api', summarizerRouter);

// 404 Route Handler
app.use((_req: Request, res: Response) => {
  res.status(404).json({
    error: 'Not Found',
    message: 'The requested resource does not exist.',
  });
});

// Global Error Handling Middleware
app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  console.error('Unhandled Application Error:', err);
  res.status(500).json({
    error: 'Internal Server Error',
    message: err.message || 'An unexpected error occurred during processing.',
  });
});
