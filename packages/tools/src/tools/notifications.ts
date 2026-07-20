import { notificationCenter } from '@grace/core';
import { registerTool } from '../registry.js';

registerTool({
  name: 'list_notifications',
  description: "Show Grace's recent proactive notifications/alerts (reminders that fired, mode changes, warnings). Use when Mikkel asks what he missed or what Grace has been flagging.",
  params: { limit: { type: 'number', description: 'how many recent (default 20)' } },
  async run(args) {
    return { notifications: notificationCenter.recent(Math.max(1, Math.min(100, Number(args.limit) || 20))) };
  },
});

registerTool({
  name: 'clear_notifications',
  description: "Clear Grace's notification history.",
  params: {},
  async run() { notificationCenter.clear(); return { ok: true }; },
});
