import React, { useEffect, useState } from 'react'
import { ModalDialog } from '../ModalDialog/ModalDialog'
import { DialogButton } from '../../widgets/DialogButton/DialogButton'
import styles from './SystemInfoDialog.module.scss'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface SystemInfoDialogProps {
  open: boolean
  onClose: () => void
}

interface SystemData {
  osName: string
  osVersion: string
  cpuModel: string
  cpuCores: number
  totalRamBytes: number
  gpus: Array<{ name: string; active: boolean; driverVersion: string }>
  webGpuAdapter: string | null
  webGpuVendor: string | null
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatBytes(bytes: number): string {
  const gb = bytes / (1024 ** 3)
  return `${gb.toFixed(1)} GB`
}

// ─── Component ────────────────────────────────────────────────────────────────

export function SystemInfoDialog({ open, onClose }: SystemInfoDialogProps): React.JSX.Element | null {
  const [data, setData] = useState<SystemData | null>(null)

  useEffect(() => {
    if (!open) return
    setData(null)

    async function fetchInfo(): Promise<void> {
      const sysInfo = await window.api.getSystemInfo()

      // Get WebGPU adapter info directly in the renderer
      let webGpuAdapter: string | null = null
      let webGpuVendor: string | null = null
      if ('gpu' in navigator) {
        try {
          const adapter = await (navigator as { gpu: { requestAdapter(): Promise<GPUAdapter | null> } }).gpu.requestAdapter()
          if (adapter) {
            // `info` is available in Chrome 113+ / Electron 25+; fall back gracefully
            const info = (adapter as GPUAdapter & { info?: { vendor?: string; device?: string; architecture?: string; description?: string } }).info
            webGpuAdapter = info?.description || info?.device || info?.architecture || null
            webGpuVendor  = info?.vendor || null
          }
        } catch {
          // WebGPU not available or denied
        }
      }

      setData({ ...sysInfo, webGpuAdapter, webGpuVendor })
    }

    void fetchInfo()
  }, [open])

  return (
    <ModalDialog open={open} title="System Information" width={480} onClose={onClose}>
      <div className={styles.body}>
        {data === null ? (
          <div className={styles.loading}>Loading…</div>
        ) : (
          <>
            {/* Operating System */}
            <div className={styles.section}>
              <h3 className={styles.sectionTitle}>Operating System</h3>
              <div className={styles.row}>
                <span className={styles.label}>Name</span>
                <span className={styles.value}>{data.osName}</span>
              </div>
              <div className={styles.row}>
                <span className={styles.label}>Version</span>
                <span className={styles.value}>{data.osVersion}</span>
              </div>
            </div>
            {/* Processor */}
            <div className={styles.section}>
              <h3 className={styles.sectionTitle}>Processor</h3>
              <div className={styles.row}>
                <span className={styles.label}>Model</span>
                <span className={styles.value}>{data.cpuModel}</span>
              </div>
              <div className={styles.row}>
                <span className={styles.label}>Logical cores</span>
                <span className={styles.value}>{data.cpuCores}</span>
              </div>
            </div>

            {/* Memory */}
            <div className={styles.section}>
              <h3 className={styles.sectionTitle}>Memory</h3>
              <div className={styles.row}>
                <span className={styles.label}>System RAM</span>
                <span className={styles.value}>{formatBytes(data.totalRamBytes)}</span>
              </div>
            </div>

            {/* Graphics */}
            <div className={styles.section}>
              <h3 className={styles.sectionTitle}>Graphics</h3>
              {data.gpus.length === 0 ? (
                <div className={styles.row}>
                  <span className={styles.label}>Available GPUs</span>
                  <span className={styles.value}>Not detected</span>
                </div>
              ) : (
                data.gpus.map((g, i) => (
                  <div key={i} className={styles.row}>
                    <span className={styles.label}>{i === 0 ? 'Available GPUs' : ''}</span>
                    <span className={styles.value}>
                      {g.name}
                      {g.active && <span className={styles.gpuBadge}>Active</span>}
                    </span>
                  </div>
                ))
              )}
              <div className={styles.row}>
                <span className={styles.label}>GPU used by app</span>
                <span className={styles.value}>
                  {data.webGpuVendor && data.webGpuAdapter
                    ? `${data.webGpuVendor} — ${data.webGpuAdapter}`
                    : data.webGpuAdapter || data.webGpuVendor || (data.gpus.find(g => g.active)?.name ?? 'Not available')}
                </span>
              </div>
              <div className={styles.row}>
                <span className={styles.label}>VRAM</span>
                <span className={styles.value}>Not available</span>
              </div>
              {data.gpus.find(g => g.active)?.driverVersion && (
                <div className={styles.row}>
                  <span className={styles.label}>Driver version</span>
                  <span className={styles.value}>{data.gpus.find(g => g.active)?.driverVersion}</span>
                </div>
              )}
            </div>
          </>
        )}
      </div>

      <div className={styles.footer}>
        <DialogButton width='196px' align='center' onClick={onClose} primary>Close</DialogButton>
      </div>
    </ModalDialog>
  )
}
