import { env, isLiveProviderConfigured } from '../config/env.js';
import { OpenAIProvider } from './openai.provider.js';
import { SimulatorProvider } from './simulator.provider.js';
import type { StreamProvider } from '../types/stream.types.js';

/**
 * Provider selection with a failover slot.
 *
 * Hardening checklist item #15 ("provider failover"): a single provider outage
 * must not take chat down. The wiring is therefore resolved in ONE place, so a
 * secondary provider can be dropped in behind a flag without touching any
 * streaming code.
 */

let cached: StreamProvider | null = null;

export function resolveProvider(): StreamProvider {
  if (cached) return cached;

  cached = isLiveProviderConfigured() ? new OpenAIProvider() : new SimulatorProvider();
  return cached;
}

/** Override the resolved provider (tests inject deterministic simulators). */
export function setProvider(provider: StreamProvider): void {
  cached = provider;
}

export function resetProvider(): void {
  cached = null;
}

export function describeProvider(): { name: string; live: boolean; model: string } {
  const provider = resolveProvider();
  return { name: provider.name, live: provider.name !== 'simulator', model: env.AI_MODEL };
}
