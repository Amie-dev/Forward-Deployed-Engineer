import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { summarizerService } from '../services/summarizer.service.js';
import { auditedSummarizerService } from '../services/audited.service.js';
import { secureSummarizerService } from '../services/secure.service.js';

export const summarizerRouter = Router();

// Zod Schema for incoming ticket payload
const summarizeRequestSchema = z.object({
  text: z
    .string({ required_error: 'Field "text" is required.' })
    .min(10, 'Ticket text must be at least 10 characters long.')
    .max(25000, 'Ticket text exceeds maximum character limit of 25,000.'),
});

/**
 * POST /api/summarize
 * Basic 2-line ticket summarization endpoint (Chapter 05).
 */
summarizerRouter.post(
  '/summarize',
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const parsed = summarizeRequestSchema.safeParse(req.body);

      if (!parsed.success) {
        res.status(400).json({
          error: 'Validation failed',
          details: parsed.error.flatten().fieldErrors,
        });
        return;
      }

      const summary = await summarizerService.summarize(parsed.data.text);

      res.status(200).json({
        success: true,
        summary,
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * POST /api/summarize/audited
 * Summarization with full token economics and telemetry metadata (Chapter 06).
 */
summarizerRouter.post(
  '/summarize/audited',
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const parsed = summarizeRequestSchema.safeParse(req.body);

      if (!parsed.success) {
        res.status(400).json({
          error: 'Validation failed',
          details: parsed.error.flatten().fieldErrors,
        });
        return;
      }

      const result = await auditedSummarizerService.summarizeWithAudit(parsed.data.text);

      res.status(200).json({
        success: true,
        data: result,
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * POST /api/summarize/secure
 * Multi-role summarizer hardened against prompt injection and goal hijacking (Chapter 06).
 */
summarizerRouter.post(
  '/summarize/secure',
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const parsed = summarizeRequestSchema.safeParse(req.body);

      if (!parsed.success) {
        res.status(400).json({
          error: 'Validation failed',
          details: parsed.error.flatten().fieldErrors,
        });
        return;
      }

      const result = await secureSummarizerService.summarizeSecure(parsed.data.text);

      res.status(200).json({
        success: true,
        data: result,
      });
    } catch (error) {
      next(error);
    }
  }
);
