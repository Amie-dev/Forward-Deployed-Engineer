import express, { Express, Request, Response, NextFunction } from 'express';
import cors from 'cors';
import { ZodError } from 'zod';
import healthRouter from './routes/health.routes.js';
import chatRouter from './routes/chat.routes.js';

export const app: Express = express();

// ============================================================================
// Core Express Middleware
// ============================================================================

app.use(cors());
app.use(express.json({ limit: '1mb' }));

// Request Observability Middleware
app.use((req: Request, _res: Response, next: NextFunction) => {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] ${req.method} ${req.url}`);
  next();
});

// ============================================================================
// REST Route Registration
// ============================================================================

app.use('/health', healthRouter);
app.use('/api/chat', chatRouter);

// 404 Catch-All Middleware
app.use((req: Request, res: Response) => {
  res.status(404).json({
    error: 'Not Found',
    message: `Cannot ${req.method} ${req.originalUrl}`,
  });
});

// ============================================================================
// Global Error Handling Middleware
// ============================================================================

app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
  console.error('Unhandled Application Error:', err);

  // 1. Handle Zod Schema Validation Errors (HTTP 400 Bad Request)
  if (err instanceof ZodError) {
    res.status(400).json({
      error: 'Validation Error',
      details: err.errors.map((e) => ({
        field: e.path.join('.'),
        message: e.message,
      })),
    });
    return;
  }

  // 2. Handle OpenAI SDK Specific API Errors (HTTP 401, 429, 500)
  if (err.status) {
    res.status(err.status).json({
      error: 'AI Provider Error',
      message: err.message,
      code: err.code,
    });
    return;
  }

  // 3. Fallback Internal Server Error (HTTP 500)
  res.status(500).json({
    error: 'Internal Server Error',
    message: err.message || 'An unexpected error occurred.',
  });
});
