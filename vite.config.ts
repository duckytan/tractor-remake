import { defineConfig } from 'vite'
import { fileURLToPath, URL } from 'node:url'
import pkg from './package.json'

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url))

export default defineConfig({
  // 相对路径，产物可放任意子目录（含 file:// 直接打开）
  base: './',
  // 版本号在构建时内联（单一来源 = package.json），运行期零依赖
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  resolve: {
    alias: {
      '@core': r('./src/core'),
      '@ai': r('./src/ai'),
      '@app': r('./src/app'),
      '@ui': r('./src/ui'),
      '@audio': r('./src/audio'),
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
