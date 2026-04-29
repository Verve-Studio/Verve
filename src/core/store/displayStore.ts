import type { ToneMappingOperator } from '@/types'

// ─── Operator → shader u32 ID mapping ─────────────────────────────────────────

export const OPERATOR_SHADER_ID: Record<ToneMappingOperator, number> = {
  reinhard: 1,
  clamp:    0,
}

// ─── DisplayStore ─────────────────────────────────────────────────────────────
// Module-level singleton. Stores HDR display parameters (EV, tone-mapping
// operator) that are read each frame in the GPU render loop. Kept outside
// React state to avoid re-renders on every EV slider tick.

type Listener = () => void

class DisplayStore {
  exposureEV: number = 0
  toneMappingOperator: ToneMappingOperator = 'clamp'

  private listeners = new Set<Listener>()

  subscribe(fn: Listener): void   { this.listeners.add(fn) }
  unsubscribe(fn: Listener): void { this.listeners.delete(fn) }
  private notify(): void          { for (const fn of this.listeners) fn() }

  setEV(ev: number): void {
    this.exposureEV = ev
    this.notify()
  }

  setOperator(op: ToneMappingOperator): void {
    this.toneMappingOperator = op
    this.notify()
  }

  /** Reset to defaults (called on tab switch). */
  reset(): void {
    this.exposureEV = 0
    this.notify()
  }
}

export const displayStore = new DisplayStore()
