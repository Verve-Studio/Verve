import { ADJUSTMENT_REGISTRY } from '@/core/operations/adjustments/registry'
import type { AdjustmentRegistrationEntry } from '@/core/operations/adjustments/registry'
import { FILTER_REGISTRY } from '@/core/operations/filters/registry'

export const ADJUSTMENT_MENU_ITEMS = (ADJUSTMENT_REGISTRY as readonly AdjustmentRegistrationEntry[])
  .filter(e => e.group !== 'real-time-effects' && e.group !== 'filters')
  .map(e => ({ type: e.adjustmentType, label: e.label, group: e.group }))

export const EFFECTS_MENU_ITEMS = (ADJUSTMENT_REGISTRY as readonly AdjustmentRegistrationEntry[])
  .filter(e => e.group === 'real-time-effects')
  .map(e => ({ type: e.adjustmentType, label: e.label, group: e.menuGroup }))

export const FILTER_MENU_ITEMS = FILTER_REGISTRY.map(e => ({ key: e.key, label: e.label, instant: e.instant, group: e.group }))
