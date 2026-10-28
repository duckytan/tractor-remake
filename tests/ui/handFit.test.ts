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
import { fitHandGeometry, solveHandFit } from '@ui/render'

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

/**
 * `fitHandGeometry` —— 在 `solveHandFit` 外面再套一层「卡宽收缩」。
 *
 * 为什么需要：步长有硬下限，触到下限还放不下时旧实现直接溢出，
 * 而 `.felt` 是 `overflow: hidden` ⇒ 溢出的牌被裁到屏幕外，扣底时点不到。
 * 这里锁两件事：① 现实窗口尺寸下**必须放得下**；② 收缩有下限、不是无脑缩。
 */
describe('fitHandGeometry', () => {
  /** 硬下限步长下，n 张牌铺开所需的最小宽度（含分组间隔） */
  const needOf = (cardW: number, count: number, gapCount: number) =>
    cardW * (1 + (count - 1) * STEP_HARD_MIN + gapCount * GAP_MIN_RATIO)

  it('放得下时原样返回档位卡宽（不触发收缩）', () => {
    const g = fitHandGeometry(1871, 190, 25, 4)
    expect(g.scaled).toBe(false)
    expect(g.cardW).toBe(190)
    expect(g.step).toBeGreaterThan(STEP_HARD_MIN)
  })

  it('庄家 33 张 + L 档 + 窄窗口：收缩卡宽后不再溢出（v1.3.47 修的就是这个）', () => {
    // 修复前：190px 卡宽 / 33 张 / 可用 1236px ⇒ 溢出 69px；1100px 窗口溢出 159px
    for (const avail of [1236, 1056, 956]) {
      const g = fitHandGeometry(avail, 190, 33, 4)
      expect(g.scaled, `可用 ${avail}`).toBe(true)
      expect(g.cardW, `可用 ${avail}`).toBeLessThan(190)
      const total = g.cardW + g.step * 32 * g.cardW + 4 * g.gap
      expect(total, `可用 ${avail}：总宽 ${total.toFixed(1)} 溢出了`).toBeLessThanOrEqual(avail + 2)
      expect(g.step, `可用 ${avail}`).toBeGreaterThanOrEqual(STEP_HARD_MIN - 1e-6)
    }
  })

  it('M 档 33 张在 1280 窗口本来就放得下，不该白缩一圈', () => {
    const g = fitHandGeometry(1236, 150, 33, 4)
    expect(g.scaled).toBe(false)
    expect(g.cardW).toBe(150)
  })

  it('收缩有下限：极窄窗口下不再缩到看不清', () => {
    // 320px 窗口 + 33 张 ⇒ 按比例要缩到 ~42px，被下限 48px 挡住
    const g = fitHandGeometry(300, 190, 33, 4)
    expect(g.cardW).toBe(48)
    expect(g.scaled).toBe(true)
    // 这种情况下溢出是必然的（物理约束），只要求「不再往下缩」
    expect(needOf(g.cardW, 33, 4)).toBeGreaterThan(300)
  })

  it('收缩结果不会比档位卡宽更大（手机档 L 的卡宽本身只有 60px）', () => {
    // 390×844：L 档被 CSS 媒体查询压到 60px，33 张仍放不下
    const g = fitHandGeometry(378, 60, 33, 4)
    expect(g.scaled).toBe(true)
    expect(g.cardW).toBeLessThanOrEqual(60)
  })

  it('收缩后手牌总宽永远不超过「不收缩时的总宽」', () => {
    for (const baseW of SIZES) {
      for (const avail of [600, 800, 956, 1056, 1236, 1404]) {
        for (const count of [25, 33] as const) {
          const g = fitHandGeometry(avail, baseW, count, 4)
          const raw = baseW + STEP_HARD_MIN * (count - 1) * baseW + 4 * Math.floor(baseW * GAP_MIN_RATIO)
          const total = g.cardW + g.step * (count - 1) * g.cardW + 4 * g.gap
          expect(
            total,
            `卡宽 ${baseW} / 可用 ${avail} / ${count} 张：收缩后反而更宽`,
          ).toBeLessThanOrEqual(Math.max(raw, avail) + 2)
        }
      }
    }
  })
})
