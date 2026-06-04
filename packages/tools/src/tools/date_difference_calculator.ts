import { registerTool } from '../registry.js';

registerTool({
  name: 'date_difference_calculator',
  description: 'Calculates the number of days between two given dates.',
  params: {
    start_date: { type: 'string', description: 'The start date in YYYY-MM-DD format' },
    end_date: { type: 'string', description: 'The end date in YYYY-MM-DD format' }
  },
  async run(args, ctx) {
    const start = new Date(args.start_date);
    const end = new Date(args.end_date);

    if (isNaN(start.getTime()) || isNaN(end.getTime())) {
      return { error: 'Invalid date format. Please use YYYY-MM-DD.' };
    }

    const diffTime = Math.abs(end.getTime() - start.getTime());
    const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

    return { days: diffDays };
  }
});