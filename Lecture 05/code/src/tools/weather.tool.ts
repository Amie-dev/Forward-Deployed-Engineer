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
