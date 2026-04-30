import { useSyncExternalStore, useEffect } from 'react'
import { dockStore } from './dockStore'
import type { DockLayout } from './types'

/** Reactive read of the dock layout. Triggers re-render whenever dockStore changes. */
export function useDockLayout(): DockLayout {
  return useSyncExternalStore(
    dockStore.subscribe.bind(dockStore),
    dockStore.getSnapshot.bind(dockStore),
  )
}

/** Load the persisted layout from disk once on mount. */
export function useDockLayoutLoader(): void {
  useEffect(() => {
    void dockStore.load()
  }, [])
}
