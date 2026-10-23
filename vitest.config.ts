import { defineConfig } from 'vitest/config'
import { fileURLToPath, URL } from 'node:url'
import pkg from './package.json'

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url))

export default defineConfig({
  // Vite 默认把缓存写到系统临时目录，受限环境下会 EPERM。
  // 显式落到项目内，保证任何环境都能跑。
  cacheDir: 'node_modules/.vite',
  // 与 vite.config.ts 保持一致：版本号构建时内联
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  resolve: {
    alias: {
      '@core': r('./src/core'),
      '@ai': r('./src/ai'),
      '@app': r('./src/app'),
      '@ui': r('./src/ui'),
    },
  },
  test: {
    // 规则引擎是纯函数库，测试不需要浏览器
    environment: 'node',
    include: ['tests/**/*.test.ts'],

    // isolate: false —— 所有测试文件共用一个 worker。
    // 默认的 isolate: true 会为每个测试文件把模块写到系统临时目录，
    // 在受限环境（沙箱 / 无写权限的 TEMP）会 EPERM，且**静默丢文件**
    // （表现为「只跑了 1 个测试文件」）。关掉隔离后稳定跑全部文件。
    // 前提：core 是纯函数、无模块级可变状态 —— 这正是 ADR-004 要求的。
    pool: 'threads',
    isolate: false,

    coverage: {
      provider: 'v8',
      // 只统计规则引擎；UI 与 AI 不纳入覆盖率门槛
      include: ['src/core/**/*.ts'],
      exclude: [
        'src/core/**/*.test.ts',
        // types.ts 只有类型声明，编译后不产生代码
        'src/core/types.ts',
      ],
      // 低于门槛直接失败（NFR-05 / 05-测试计划 §6）
      thresholds: {
        lines: 90,
        branches: 85,
        functions: 90,
        statements: 90,
      },
    },
  },
})
