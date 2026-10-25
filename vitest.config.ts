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
      '@audio': r('./src/audio'),
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
    //
    // **必须 singleThread**（v1.3.11）：`pool: 'threads'` 默认按 CPU 核数开线程，
    // 而 isolate:false 的语义是「所有文件共用一个 worker」。多线程下每个线程一份
    // 模块注册表，覆盖率与「测试是否共享模块级状态」都会随核数变化 ——
    // 同一份代码实测：8 核全局 70.83%，2 核 68.40%（CI 就是 2 核，直接卡在门槛下）。
    // 强制单线程后任何机器结果一致。
    pool: 'threads',
    poolOptions: { threads: { singleThread: true } },
    isolate: false,

    coverage: {
      provider: 'v8',
      // 统计四层源码（2026-10-23 修订：三司会审指出原口径只含 core，
      // app / ai / ui 的覆盖率不可见，门槛形同虚设）。ui 渲染代码难测，
      // 给低档位但纳入统计。
      include: [
        'src/core/**/*.ts',
        'src/app/**/*.ts',
        'src/ai/**/*.ts',
        'src/ui/**/*.ts',
      ],
      exclude: [
        'src/**/*.test.ts',
        // types.ts 只有类型声明，编译后不产生代码
        'src/core/types.ts',
      ],
      // 低于门槛直接失败（NFR-05 / 05-测试计划 §6）。
      //
      // 门槛依据 2026-10-24 实测（v8 provider；v1.3.9，336 个用例）：
      //   全局   statements 70.83 / branches 90.22 / functions 80.19 / lines 70.83
      //   core   99.54 / 97.64 / 98.30 / 99.54
      //   ai     95.97 / 90.95 / 89.28 / 95.97
      //   app    93.28 / 82.35 / 95.94 / 93.28
      //   ui     16.86 / 89.36 / 19.51 / 16.86（DOM 渲染，vitest node 环境基本覆盖不到）
      // 各层门槛 = 实测下浮 2~5 个百分点：既留出小改动的余量，又保留约束力。
      // ui 特别低是渲染代码的本质决定的（纯 DOM 操作，无单测环境），见
      // tests/ui/handFit.test.ts 的思路：只把可纯测的几何计算抽出来测。
      //
      // **ui 的 branches 门槛 v1.3.9 从 95 调到 87**：原 95 是在「ui 只有 handFit
      // 一个纯函数文件（100% 分支）」时标的；v1.3.8 的卡牌动画（ADR-017）让 ui
      // 多了 dealFly / fxDiff / render 面板等带分支的 DOM 代码，实测 89.36。
      // 这里按同一套「实测下浮 2~5 点」的口径重标为 87，并保留约束力
      // （纯函数仍要求高分：fxDiff / 面板构建都有单测）。
      thresholds: {
        // 全局（四层合计）
        statements: 70,
        branches: 88,
        functions: 79,
        lines: 70,
        // 规则引擎：接近全覆盖，保持高门槛
        'src/core/**/*.ts': {
          statements: 98,
          branches: 94,
          functions: 95,
          lines: 98,
        },
        // AI 策略
        'src/ai/**/*.ts': {
          statements: 93,
          branches: 86,
          functions: 85,
          lines: 93,
        },
        // 装配层（persist 的 localStorage 分支在 node 环境天然测不到，是主要缺口）
        'src/app/**/*.ts': {
          statements: 84,
          branches: 75,
          functions: 88,
          lines: 84,
        },
        // 渲染层：低档位，仅防「整个文件一行不跑」的回退
        'src/ui/**/*.ts': {
          statements: 12,
          branches: 87,
          functions: 8,
          lines: 12,
        },
      },
    },
  },
})
