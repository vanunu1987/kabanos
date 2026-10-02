import { defineConfig } from '@playwright/test'

// Website screenshots (e2e/site-screens.capture.ts) — needs the docker clusters seeded.
export default defineConfig({ testDir: 'e2e', testMatch: '*.capture.ts', workers: 1, timeout: 240_000, reporter: 'list' })
