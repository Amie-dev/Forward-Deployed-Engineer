// Lecture 16 · Chapter 08.2 — images are expensive tokens.
//
// Everything in Chapter 04's arithmetic becomes money here, and the scaling law is
// the one to remember: cost grows with AREA, not with the number of files.
import { config } from '../config/config.js';

// The lecture's formula:  image tokens ≈ (width / patch) × (height / patch).
//   512  x 512   @16 -> ~1,024
//   1024 x 1024  @16 -> ~4,096
//   1920 x 1080  @16 -> ~8,160   ← the board's cat.jpg
export function estimateImageTokens({ width, height }, patchSize = config.patchSize) {
  return Math.ceil(width / patchSize) * Math.ceil(height / patchSize);
}

// The pre-send guard: decide BEFORE spending money.
//   send              — inside budget, pass the image through
//   crop-or-downscale — over budget, the caller must shrink the region of interest
export function guardImage(dimensions, budget = config.maxImageTokens) {
  const tokens = estimateImageTokens(dimensions);
  if (tokens > budget) {
    return {
      action: 'crop-or-downscale',
      tokens,
      budget,
      reason: `estimated ${tokens} image tokens exceeds the ${budget}-token budget`,
    };
  }
  return { action: 'send', tokens, budget };
}

// Chapter 07.6 / 08.2 — the conversation cost trap.
// An image in history is re-sent every turn, so the real cost is tokens × turns.
// One 1,000-token image over 10 turns is 10,000 tokens, not 1,000.
export function conversationCost(tokensPerImage, turns) {
  return tokensPerImage * turns;
}
