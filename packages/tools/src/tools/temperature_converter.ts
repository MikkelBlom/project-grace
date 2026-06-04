import { registerTool } from '../registry.js';

registerTool({
  name: 'temperature_converter',
  description: 'Converts temperatures between Celsius, Fahrenheit, and Kelvin.',
  params: {
    value: { type: 'number', description: 'The temperature value to convert.' },
    from: { type: 'string', description: 'The source temperature unit (C, F, or K).' },
    to: { type: 'string', description: 'The target temperature unit (C, F, or K).' }
  },
  async run(args: any, ctx: any) {
    const { value, from, to } = args;
    let celsius;

    if (from === 'C') {
      celsius = value;
    } else if (from === 'F') {
      celsius = (value - 32) * 5 / 9;
    } else if (from === 'K') {
      celsius = value - 273.15;
    } else {
      return { error: 'Invalid source unit' };
    }

    let result;
    if (to === 'C') {
      result = celsius;
    } else if (to === 'F') {
      result = (celsius * 9 / 5) + 32;
    } else if (to === 'K') {
      result = celsius + 273.15;
    } else {
      return { error: 'Invalid target unit' };
    }

    return { result };
  }
});