// jsdom project only. Vitest globals are off, so Testing Library can't
// register its automatic unmount; do it here for every component test.
import { afterEach } from 'vitest'
import { cleanup } from '@testing-library/react'

afterEach(() => cleanup())
