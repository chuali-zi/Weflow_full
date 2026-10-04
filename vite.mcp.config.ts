import { defineConfig } from 'vite'
import { resolve } from 'node:path'
import { builtinModules } from 'node:module'

export default defineConfig({
  build: {
    target: 'node22', outDir: 'build/mcp', emptyOutDir: false,
    lib: { entry: resolve(__dirname, 'mcp/server.ts'), formats: ['cjs'], fileName: () => 'server.cjs' },
    rollupOptions: { external: [...builtinModules, /^node:/, 'sharp', 'heic-decode'], output: { inlineDynamicImports: true } },
    minify: false
  }
})
