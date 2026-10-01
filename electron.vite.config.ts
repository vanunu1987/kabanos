import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

const shared = { '@shared': resolve('src/shared') }

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: shared }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: shared },
    build: { rollupOptions: { output: { format: 'cjs', entryFileNames: '[name].cjs' } } }
  },
  renderer: {
    resolve: {
      alias: [
        { find: '@shared', replacement: resolve('src/shared') },
        { find: '@renderer', replacement: resolve('src/renderer') },
        // Deep imports into monaco-editor's ESM tree (bypasses its package "exports" map); see scripts/gen-monaco-entry.mjs.
        { find: /^monaco-esm\//, replacement: `${resolve('node_modules/monaco-editor/esm/vs')}/` }
      ]
    },
    plugins: [react()]
  }
})
