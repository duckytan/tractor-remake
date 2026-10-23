/**
 * 手牌排布求解（`ui/render.ts` 的 `solveHandFit`）
 *
 * 为什么给 UI 层的几何计算写单测：这里出过两次「某个档位下花色分组间隔悄悄变成 0」
 * 的回归，而它只有在特定窗口宽度下用肉眼才看得出来（S 档能看见、M/L 档看不见）。
 * `solveHandFit` 是纯函数，把「间隔不许归零」这条约束锁进测试，比靠肉眼回归靠谱。
 *
 * 断言里的比例常量故意写成字面量（不复用 render.ts 的导出）：
 * 那些常量一改就说明排布规则变了，测试应该跟着红一次，而不是自动跟着变。
 */

import { describe, expect, it } from 'vitest'
import { solveHandFit } from '@ui/render'

/** 三档卡宽（S/M/L） */
const SIZES = [120, 150, 190] as const
/** 常见可用宽度：1024~1920 的窗口宽度减掉牌桌左右内边距（18px × 2） */
const WIDTHS = [988, 1064, 1164, 1244, 1330, 1404, 1564, 1884] as const
/** 手牌张数：开局 25 张，之后逐墩减少 */
const COUNTS = [25, 20, 13, 8] as const

/** 分组间隔占卡宽的比例（理想值 / 压缩下限） */
const GAP_RATIO = 0.2
const GAP_MIN_RATIO = 0.08
/** 重叠步长的上限 / 硬下限 */
const STEP_MAX = 0.58
const STEP_HARD_MIN = 0.18

describe('solveHandFit', () => {
  it('空间宽松时，分组间隔正好是卡宽的 20%', () => {
    // M 档 150px 卡宽、25 张、3 处花色分组、可用 1404px
    const f = solveHandFit(1404, 150, 25, 3)
    expect(f.gap).toBe(30)
    expect(f.step).toBeGreaterThan(0.3)
  })

  it('空间拥挤时间隔可以缩，但绝不会缩到 0（三档 × 各种窗口宽度）', () => {
    for (const cardW of SIZES) {
      for (const avail of WIDTHS) {
        for (const count of COUNTS) {
          const f = solveHandFit(avail, cardW, count, 3)
          const floor = Math.floor(cardW * GAP_MIN_RATIO) - 1
          expect(
            f.gap,
            `卡宽 ${cardW} / 可用 ${avail} / ${count} 张：间隔不该低于保底 ${floor}px`,
          ).toBeGreaterThanOrEqual(floor)
        }
      }
    }
  })

  it('间隔不会超过理想值（卡宽 20%）', () => {
    for (const cardW of SIZES) {
      for (const avail of WIDTHS) {
        const f = solveHandFit(avail, cardW, 25, 3)
        expect(f.gap, `卡宽 ${cardW} / 可用 ${avail}：间隔不该超过 20%`).toBeLessThanOrEqual(
          Math.round(cardW * GAP_RATIO),
        )
      }
    }
  })

  it('步长始终夹在 [硬下限, 上限] 之间', () => {
    for (const cardW of SIZES) {
      for (const avail of WIDTHS) {
        for (const count of COUNTS) {
          for (const gapCount of [0, 1, 3, 4]) {
            const f = solveHandFit(avail, cardW, count, gapCount)
            const tag = `卡宽 ${cardW} / 可用 ${avail} / ${count} 张 / ${gapCount} 处间隔`
            expect(f.step, tag).toBeGreaterThanOrEqual(STEP_HARD_MIN)
            expect(f.step, tag).toBeLessThanOrEqual(STEP_MAX)
          }
        }
      }
    }
  })

  it('只有一组牌时间隔归零，余量全给步长', () => {
    const f = solveHandFit(1404, 150, 5, 0)
    expect(f.gap).toBe(0)
    expect(f.step).toBe(STEP_MAX)
  })

  it('步长没触到硬下限时，手牌总宽不会溢出容器', () => {
    for (const cardW of SIZES) {
      for (const avail of WIDTHS) {
        for (const count of COUNTS) {
          const f = solveHandFit(avail, cardW, count, 3)
          // 触到硬下限说明「已经挤到不能再挤」，此时允许溢出（见 solveHandFit 注释 ③）
          if (f.step <= STEP_HARD_MIN + 1e-6) continue
          const total = cardW + f.step * (count - 1) * cardW + 3 * f.gap
          expect(
            total,
            `卡宽 ${cardW} / 可用 ${avail} / ${count} 张：总宽 ${total.toFixed(1)} 溢出了`,
          ).toBeLessThanOrEqual(avail + 2)
        }
      }
    }
  })

  it('L 档 25 张的极端拥挤场景：间隔仍在（v1.2.9 修的就是这个）', () => {
    // 修复前这里 gap = 0（先是降到写死的 6px，再被压到 0），L 档完全看不出花色分组
    const f = solveHandFit(1244, 190, 25, 3)
    expect(f.gap).toBe(15)
    expect(f.step).toBeCloseTo(0.221, 3)
  })

  it('牌数不足 2 张时不做排布', () => {
    expect(solveHandFit(1404, 150, 1, 0)).toEqual({ gap: 0, step: STEP_MAX })
  })
})
