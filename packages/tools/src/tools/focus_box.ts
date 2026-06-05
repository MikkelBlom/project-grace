// focus_box — draw an animated focus box on screen to highlight a UI element.
//
// Emits overlay:focusBox / overlay:clearFocusBoxes on the EventBus. VignetteWindow
// (overlay package) routes the box to the correct monitor and animates it flying
// in from the Grace icon. Coordinates are ABSOLUTE virtual-desktop pixels in the
// same space analyze_screen returns — so the usual flow is:
//   take_screenshot → analyze_screen(find_element:true) → focus_box(boundingBox).

import { registerTool } from '../registry.js';
import { bus } from '@grace/core';

registerTool({
  name: 'focus_box',
  description:
    'Draw an animated focus box on screen to highlight a UI element. ' +
    'The box animates in from the Grace icon and highlights the target area. ' +
    'Coordinates are screen pixels (the same coordinates analyze_screen returns). ' +
    'Combine with analyze_screen to find elements. Use action:"clear" to remove all boxes.',
  params: {
    x:        { type: 'number',  description: 'Left edge X in screen pixels (required unless action="clear")' },
    y:        { type: 'number',  description: 'Top edge Y in screen pixels (required unless action="clear")' },
    w:        { type: 'number',  description: 'Width in pixels (required unless action="clear")' },
    h:        { type: 'number',  description: 'Height in pixels (required unless action="clear")' },
    label:    { type: 'string',  description: 'Label text shown above the box' },
    duration: { type: 'number',  description: 'Auto-dismiss after this many ms (default 4000)' },
    pulse:    { type: 'boolean', description: 'Keep pulsing while discussing this element' },
    action:   { type: 'string',  description: '"draw" (default) or "clear" to remove all boxes' },
  },
  async run(args) {
    const action = String(args.action ?? 'draw').toLowerCase();

    if (action === 'clear') {
      bus.emit('overlay:clearFocusBoxes', {});
      return { ok: true, cleared: true };
    }

    const x = Number(args.x), y = Number(args.y), w = Number(args.w), h = Number(args.h);
    if ([x, y, w, h].some((n) => !Number.isFinite(n))) {
      return { error: 'focus_box needs numeric x, y, w, h (in screen pixels) to draw a box.' };
    }
    if (w <= 0 || h <= 0) {
      return { error: 'focus_box width and height must be positive.' };
    }

    const duration = Number.isFinite(Number(args.duration)) ? Number(args.duration) : 4000;

    bus.emit('overlay:focusBox', {
      x, y, w, h,
      label: args.label != null ? String(args.label) : undefined,
      duration,
      pulse: !!args.pulse,
    });

    return { ok: true, drawn: { x, y, w, h }, label: args.label ?? null, duration };
  },
});
