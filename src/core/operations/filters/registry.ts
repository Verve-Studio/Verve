import type { FilterKey } from '@/types'

export interface FilterRegistryEntry {
  key:      FilterKey
  label:    string
  instant?: boolean
  group?:   'blur' | 'sharpen' | 'noise' | 'render' | 'pixelate' | 'texture'
}

export const FILTER_REGISTRY: FilterRegistryEntry[] = [
  { key: 'gaussian-blur',  label: 'Gaussian Blur…',  group: 'blur'    },
  { key: 'box-blur',       label: 'Box Blur…',        group: 'blur'    },
  { key: 'radial-blur',    label: 'Radial Blur…',     group: 'blur'    },
  { key: 'motion-blur',    label: 'Motion Blur…',     group: 'blur'    },
  { key: 'remove-motion-blur', label: 'Remove Motion Blur…', group: 'blur' },
  { key: 'lens-blur',      label: 'Lens Blur…',       group: 'blur'    },
  { key: 'sharpen',        label: 'Sharpen',          group: 'sharpen', instant: true },
  { key: 'sharpen-more',   label: 'Sharpen More',     group: 'sharpen', instant: true },
  { key: 'unsharp-mask',   label: 'Unsharp Mask…',    group: 'sharpen' },
  { key: 'smart-sharpen',  label: 'Smart Sharpen…',   group: 'sharpen' },
  { key: 'add-noise',      label: 'Add Noise…',       group: 'noise'   },
  { key: 'film-grain',       label: 'Film Grain…',        group: 'noise'   },
  { key: 'median-filter',    label: 'Median…',            group: 'noise'   },
  { key: 'bilateral-filter', label: 'Bilateral…',         group: 'noise'   },
  { key: 'reduce-noise',     label: 'Reduce Noise…',      group: 'noise'   },
  { key: 'clouds',           label: 'Clouds…',            group: 'render'  },
  { key: 'render-lens-flare', label: 'Lens Flare…',       group: 'render'  },
  { key: 'pixelate',         label: 'Pixelate…',         group: 'pixelate' },
  { key: 'seamless-texture', label: 'Seamless Texture…', group: 'texture'  },
]
