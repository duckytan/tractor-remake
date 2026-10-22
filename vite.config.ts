import { defineConfig } from 'vite'
import { fileURLToPath, URL } from 'node:url'

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url))

export default defineConfig({
  // 相对路径，产物可放任意子目录（含 file:// 直接打开）
  base: './',
  resolve: {
    alias: {
      '@core': r('./src/core'),
      '@ai': r('./src/ai'),
      '@app': r('./src/app'),
      '@ui': r('./src/ui'),
    },
  },
  build: {
    target: 'es2022',
    sourcemap: true,
  },
  server: {
    port: 5173,
    open: false,
  },
})
