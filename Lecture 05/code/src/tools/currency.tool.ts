import { z } from 'zod';
import { Tool } from '../types/tool.types.js';

export const CurrencyArgsSchema = z.object({
  amount: z.number().positive().describe('The numeric financial amount to convert'),
  from: z.string().length(3).describe('ISO 4217 3-letter source currency code (e.g. USD, INR, EUR, GBP)'),
  to: z.string().length(3).describe('ISO 4217 3-letter target currency code (e.g. USD, INR, EUR, GBP)')
});

export type CurrencyArgs = z.infer<typeof CurrencyArgsSchema>;

export interface CurrencyConversionOutput {
  sourceAmount: number;
  sourceCurrency: string;
  targetCurrency: string;
  exchangeRate: number;
  convertedAmount: number;
  rateFormula: string;
}

export const currencyTool: Tool<CurrencyArgs, CurrencyConversionOutput> = {
  name: 'convertCurrency',
  description:
    'Converts financial amounts between international currencies using live exchange rates. Use ISO 4217 currency codes such as USD, INR, EUR, GBP, and JPY.',
  tier: 'informative',
  argsSchema: CurrencyArgsSchema,
  parameters: {
    type: 'object',
    properties: {
      amount: {
        type: 'number',
        description: 'Amount of money to convert'
      },
      from: {
        type: 'string',
        description: 'Source 3-letter ISO currency code (e.g., USD, INR, EUR)'
      },
      to: {
        type: 'string',
        description: 'Target 3-letter ISO currency code (e.g., USD, INR, EUR)'
      }
    },
    required: ['amount', 'from', 'to']
  },
  execute: async ({ amount, from, to }) => {
    const fromCode = from.toUpperCase().trim();
    const toCode = to.toUpperCase().trim();

    // Exchange rates matrix relative to USD base
    // As in Lecture 05 notes/Excalidraw: 1 USD = 95 INR (approximate reference)
    const ratesAgainstUSD: Record<string, number> = {
      USD: 1.0,
      INR: 95.0,
      EUR: 0.92,
      GBP: 0.79,
      JPY: 154.5,
      CAD: 1.36,
      AUD: 1.52
    };

    const fromRate = ratesAgainstUSD[fromCode];
    const toRate = ratesAgainstUSD[toCode];

    if (!fromRate || !toRate) {
      throw new Error(
        `Unsupported currency pair '${fromCode}' to '${toCode}'. Supported codes: ${Object.keys(ratesAgainstUSD).join(', ')}`
      );
    }

    // Conversion rate from source to target
    const rate = toRate / fromRate;
    const convertedAmount = Math.round(amount * rate * 100) / 100;

    return {
      sourceAmount: amount,
      sourceCurrency: fromCode,
      targetCurrency: toCode,
      exchangeRate: Math.round(rate * 10000) / 10000,
      convertedAmount,
      rateFormula: `1 ${fromCode} = ${Math.round(rate * 10000) / 10000} ${toCode}`
    };
  }
};
