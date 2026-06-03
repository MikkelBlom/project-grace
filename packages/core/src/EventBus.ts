// ─────────────────────────────────────────────
// GraceEventBus — fully typed EventEmitter
// This is the nervous system of the entire system.
// Every service communicates exclusively through here.
// ─────────────────────────────────────────────

import { EventEmitter } from 'events';
import type { GraceEvents } from '@grace/shared';

type Listener<T> = T extends void ? () => void : (data: T) => void;

export class GraceEventBus extends EventEmitter {
  private debugMode: boolean;

  constructor(debug = false) {
    super();
    this.setMaxListeners(50); // Many services will subscribe
    this.debugMode = debug;
  }

  emit<K extends keyof GraceEvents>(event: K, data: GraceEvents[K]): boolean {
    if (this.debugMode) {
      const preview = data ? JSON.stringify(data).substring(0, 120) : '';
      console.log(`[EventBus] ▶ ${String(event)} ${preview}`);
    }
    return super.emit(event as string, data);
  }

  on<K extends keyof GraceEvents>(event: K, listener: Listener<GraceEvents[K]>): this {
    return super.on(event as string, listener as (...args: unknown[]) => void);
  }

  once<K extends keyof GraceEvents>(event: K, listener: Listener<GraceEvents[K]>): this {
    return super.once(event as string, listener as (...args: unknown[]) => void);
  }

  off<K extends keyof GraceEvents>(event: K, listener: Listener<GraceEvents[K]>): this {
    return super.off(event as string, listener as (...args: unknown[]) => void);
  }
}

// Singleton — all services import this one instance
export const bus = new GraceEventBus(process.env.GRACE_DEBUG === 'true');
