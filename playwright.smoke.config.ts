import { defineConfig } from '@playwright/test'

/** Packaged-app smoke test: pnpm exec electron-builder --mac --arm64 --dir && pnpm smoke */
export default defineConfig({ testDir: 'e2e', testMatch: /packaged\.smoke\.ts$/, workers: 1, timeout: 60_000, reporter: 'list' })
