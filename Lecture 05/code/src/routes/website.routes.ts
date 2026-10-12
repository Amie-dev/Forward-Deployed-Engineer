import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { defaultWebsiteBuilderService } from '../services/website-builder.service.js';

export const websiteRouter = Router();

const GenerateSiteRequestSchema = z.object({
  prompt: z.string().min(5, 'Prompt must be at least 5 characters long')
});

/**
 * POST /api/generate-site
 * Autonomous website generation endpoint invoking workspace tools
 */
websiteRouter.post('/', async (req: Request, res: Response): Promise<void> => {
  try {
    const parseResult = GenerateSiteRequestSchema.safeParse(req.body);
    if (!parseResult.success) {
      res.status(400).json({
        error: 'Invalid request payload',
        details: parseResult.error.issues.map((i) => i.message)
      });
      return;
    }

    const { prompt } = parseResult.data;
    const result = await defaultWebsiteBuilderService.buildSite(prompt);

    res.status(200).json({
      success: true,
      data: result
    });
  } catch (error: any) {
    console.error('[WebsiteRoute Error]', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Internal server error generating website'
    });
  }
});
