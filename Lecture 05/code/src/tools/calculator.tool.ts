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
