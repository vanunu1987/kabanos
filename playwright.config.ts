import { defineConfig } from '@playwright/test'

export default defineConfig({ testDir: 'e2e', testMatch: '*.e2e.ts', expect: { timeout: 10_000 }, workers: 1, timeout: 60_000, reporter: 'list' })
