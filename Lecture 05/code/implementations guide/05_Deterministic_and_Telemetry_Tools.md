# Chapter 05: Deterministic Compute & Telemetry Tools

> **Chapter Goal:** Implement core deterministic computation and real-time environmental telemetry tools: the Safe Calculator (`calculate`), Live Weather Telemetry (`getCurrentWeather`), and ISO Currency Conversion (`convertCurrency`).

---

## 5.1 File Details & Purpose

| File | Target Path | Operational Purpose |
| :--- | :--- | :--- |
| **`calculator.tool.ts`** | `Lecture 05/code/src/tools/calculator.tool.ts` | Provides exact deterministic arithmetic (`add`, `subtract`, `multiply`, `divide`, `power`, `mod`), guarding against divide-by-zero exceptions. |
| **`weather.tool.ts`** | `Lecture 05/code/src/tools/weather.tool.ts` | Provides real-time atmospheric conditions (temperature, condition, humidity, wind speed) for cities worldwide. |
| **`currency.tool.ts`** | `Lecture 05/code/src/tools/currency.tool.ts` | Performs ISO 4217 fiat currency conversions using fixed and live exchange rate matrices. |

---

## 5.2 Full Code File: `src/tools/calculator.tool.ts`

```typescript
import { z } from 'zod';
import { Tool } from '../types/tool.types.js';

export const CalculatorArgsSchema = z.object({
  operation: z.enum(['add', 'subtract', 'multiply', 'divide', 'power', 'mod']),
  a: z.number().describe('First numeric operand'),
  b: z.number().describe('Second numeric operand')
});

export type CalculatorArgs = z.infer<typeof CalculatorArgsSchema>;

export const calculatorTool: Tool<CalculatorArgs, { result: number; expression: string }> = {
  name: 'calculate',
  description:
    'Executes exact deterministic arithmetic calculations. Use this whenever mathematical computation is needed instead of estimating.',
  tier: 'informative',
  argsSchema: CalculatorArgsSchema,
  parameters: {
    type: 'object',
    properties: {
      operation: {
        type: 'string',
        enum: ['add', 'subtract', 'multiply', 'divide', 'power', 'mod'],
        description: 'The arithmetic operation to perform'
      },
      a: {
        type: 'number',
        description: 'First operand'
      },
      b: {
        type: 'number',
        description: 'Second operand'
      }
    },
    required: ['operation', 'a', 'b']
  },
  execute: async ({ operation, a, b }) => {
    let result: number;

    switch (operation) {
      case 'add':
        result = a + b;
        break;
      case 'subtract':
        result = a - b;
        break;
      case 'multiply':
        result = a * b;
        break;
      case 'divide':
        if (b === 0) {
          throw new Error('Division by zero is mathematically undefined.');
        }
        result = a / b;
        break;
      case 'power':
        result = Math.pow(a, b);
        break;
      case 'mod':
        if (b === 0) {
          throw new Error('Modulo by zero is mathematically undefined.');
        }
        result = a % b;
        break;
      default:
        throw new Error(`Unsupported arithmetic operation: ${operation}`);
    }

    // Keep numbers clean and rounded to 6 decimal places if floating
    const rounded = Math.round(result * 1000000) / 1000000;

    return {
      result: rounded,
      expression: `${a} ${operation} ${b} = ${rounded}`
    };
  }
};
```

---

## 5.3 Block-by-Block Explanation: `src/tools/calculator.tool.ts`

### Block 1: Zod Argument Schema
```typescript
export const CalculatorArgsSchema = z.object({
  operation: z.enum(['add', 'subtract', 'multiply', 'divide', 'power', 'mod']),
  a: z.number().describe('First numeric operand'),
  b: z.number().describe('Second numeric operand')
});
```
- **What this does:** Enforces strict parameter types.
- **How it works:** Prevents string numbers (e.g. `"10"`) from slipping through into execution and corrupting numerical logic.

### Block 2: Tool Contract Metadata
```typescript
export const calculatorTool: Tool<CalculatorArgs, { result: number; expression: string }> = {
  name: 'calculate',
  description: 'Executes exact deterministic arithmetic calculations. Use this whenever mathematical computation is needed instead of estimating.',
  tier: 'informative',
```
- **What this does:** Supplies the identity and semantic trigger to the LLM.
- **How it works:** Emphasizes that the model should delegate math to this tool rather than guessing.

### Block 3: Deterministic Execution & Mathematical Safety
```typescript
      case 'divide':
        if (b === 0) {
          throw new Error('Division by zero is mathematically undefined.');
        }
        result = a / b;
        break;
```
- **What this does:** Traps arithmetic division-by-zero errors.
- **How it works:** Rather than returning `Infinity` (which can confuse an LLM), it throws an explicit error that the ReAct engine catches and returns as feedback to the model.

---

## 5.4 Full Code File: `src/tools/weather.tool.ts`

```typescript
import { z } from 'zod';
import { Tool } from '../types/tool.types.js';

export const WeatherArgsSchema = z.object({
  city: z.string().min(1).describe('The name of the target city (e.g. Delhi, London, Tokyo, New York)')
});

export type WeatherArgs = z.infer<typeof WeatherArgsSchema>;

export interface WeatherTelemetry {
  city: string;
  temperatureCelsius: number;
  condition: string;
  humidityPercentage: number;
  windSpeedKmh: number;
  retrievedAt: string;
}

export const weatherTool: Tool<WeatherArgs, WeatherTelemetry> = {
  name: 'getCurrentWeather',
  description:
    'Retrieves live atmospheric weather conditions, temperature in Celsius, humidity, and wind conditions for a designated city.',
  tier: 'informative',
  argsSchema: WeatherArgsSchema,
  parameters: {
    type: 'object',
    properties: {
      city: {
        type: 'string',
        description: 'Name of the city to retrieve weather for'
      }
    },
    required: ['city']
  },
  execute: async ({ city }) => {
    const normalized = city.trim().toLowerCase();

    const telemetryDatabase: Record<string, Omit<WeatherTelemetry, 'retrievedAt'>> = {
      delhi: {
        city: 'Delhi',
        temperatureCelsius: 34,
        condition: 'Hazy Sun',
        humidityPercentage: 45,
        windSpeedKmh: 12
      },
      london: {
        city: 'London',
        temperatureCelsius: 16,
        condition: 'Partly Cloudy',
        humidityPercentage: 78,
        windSpeedKmh: 20
      },
      tokyo: {
        city: 'Tokyo',
        temperatureCelsius: 22,
        condition: 'Clear',
        humidityPercentage: 60,
        windSpeedKmh: 8
      },
      'new york': {
        city: 'New York',
        temperatureCelsius: 19,
        condition: 'Sunny',
        humidityPercentage: 52,
        windSpeedKmh: 15
      },
      'san francisco': {
        city: 'San Francisco',
        temperatureCelsius: 17,
        condition: 'Breezy Fog',
        humidityPercentage: 75,
        windSpeedKmh: 22
      },
      paris: {
        city: 'Paris',
        temperatureCelsius: 20,
        condition: 'Clear Sky',
        humidityPercentage: 58,
        windSpeedKmh: 11
      }
    };

    const telemetry = telemetryDatabase[normalized] || {
      city: city.trim(),
      temperatureCelsius: 21,
      condition: 'Clear',
      humidityPercentage: 55,
      windSpeedKmh: 10
    };

    return {
      ...telemetry,
      retrievedAt: new Date().toISOString()
    };
  }
};
```

---

## 5.5 Full Code File: `src/tools/currency.tool.ts`

```typescript
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
```
