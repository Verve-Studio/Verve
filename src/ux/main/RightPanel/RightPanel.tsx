import React, { useEffect } from 'react'
import { ColorPicker } from '@/ux/main/RightPanel/ColorPicker/ColorPicker'
import { Layers } from '@/ux/main/RightPanel/Layers/Layers'
import { Navigator } from '@/ux/main/RightPanel/Navigator/Navigator'
import { SwatchPanel } from '@/ux/main/RightPanel/Swatch/SwatchPanel'
import { HistoryPanel } from '@/ux/main/RightPanel/History/HistoryPanel'
import { InfoPanel } from '@/ux/main/RightPanel/Info/InfoPanel'
import { HDRPanel } from '@/ux/windows/HDRPanel/HDRPanel'
import { Dock } from './Dock/Dock'
import { dockStore } from './Dock/dockStore'
import { useDockLayoutLoader } from './Dock/useDockLayout'
import type { PanelId } from './Dock/types'
import styles from './RightPanel.module.scss'

interface RightPanelProps {
  activeTabId: string
  findLayersTrigger?: number
  onMergeSelected: (ids: string[]) => void
  onMergeVisible: () => void
  onMergeDown: () => void
  onFlattenImage: () => void
  onRasterizeLayer: (layerId: string) => void
  onDuplicateLayer: () => void
  onOpenAdjustmentPanel?: (layerId: string) => void
  onGeneratePalette?: () => void
  onMergeGroup: (groupId: string) => void
  onGroupSelected: (layerIds: string[]) => void
  onUngroup: (groupId: string) => void
}

export function RightPanel({ activeTabId, findLayersTrigger, onMergeSelected, onMergeVisible, onMergeDown, onFlattenImage, onRasterizeLayer, onDuplicateLayer, onOpenAdjustmentPanel, onGeneratePalette, onMergeGroup, onGroupSelected, onUngroup }: RightPanelProps): React.JSX.Element {
  useDockLayoutLoader()

  // Sync panel checked states to native menu whenever layout changes
  useEffect(() => {
    return dockStore.subscribe(() => {
      const open = dockStore.openPanelIds
      const updates: Record<string, boolean> = {}
      const all: PanelId[] = ['Color', 'Swatches', 'Navigator', 'Layers', 'History', 'Info', 'HDR']
      for (const id of all) {
        updates[`togglePanel:${id}`] = open.includes(id)
      }
      window.api.setMenuItemChecked(updates)
    })
  }, [])

  function renderPanel(panelId: PanelId): React.ReactNode {
    switch (panelId) {
      case 'Color':
        return <ColorPicker />
      case 'Swatches':
        return <SwatchPanel activeTabId={activeTabId} onGeneratePalette={onGeneratePalette} />
      case 'Navigator':
        return <Navigator />
      case 'Layers':
        return (
          <Layers
            onMergeSelected={onMergeSelected}
            onMergeVisible={onMergeVisible}
            onMergeDown={onMergeDown}
            onFlattenImage={onFlattenImage}
            onRasterizeLayer={onRasterizeLayer}
            onDuplicateLayer={onDuplicateLayer}
            onOpenAdjustmentPanel={onOpenAdjustmentPanel}
            onMergeGroup={onMergeGroup}
            onGroupSelected={onGroupSelected}
            onUngroup={onUngroup}
            activeTabId={activeTabId}
            findLayersTrigger={findLayersTrigger}
          />
        )
      case 'History':
        return <HistoryPanel />
      case 'Info':
        return <InfoPanel />
      case 'HDR':
        return <HDRPanel />
      default:
        return null
    }
  }

  return (
    <aside className={styles.panel}>
      <Dock renderPanel={renderPanel} />
    </aside>
  )
}
