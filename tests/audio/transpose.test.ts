/**
 * 调性稳定性（v1.3.45 修）
 *
 * 用户反馈「音乐变调得很不自然，有点突兀」。查下来是**紧张度在改音高**：
 * `tr = sc.tp + Math.round(-2 * tension)`，而 tension 每 40ms 平滑更新一次，
 * `Math.round` 把它量化成整半音 ⇒ 整首曲子会在**乐句中间**突然降 1~2 个半音。
 * 实测一轮 48 小节降两个半音，其中一次落在「全奏」段第 5 小节。
 *
 * 这里锁两条不变量：
 *   ① 紧张度从 0 拉到 1，**移调量一格都不许变**
 *   ② 只有切换场景（`tp` 不同）才允许改变移调
 */

import { describe, expect, it } from 'vitest'
import { MusicEngine } from '@audio/music'

/** 造一个不发声的引擎：只关心调度出来的移调量 */
function makeEngine(scene = 'play'): { engine: MusicEngine; drive: (n: number, tensionOf: (i: number) => number) => void } {
  let now = 0
  const ctx = { get currentTime() { return now } }
  const stub = {} as never
  const engine = new MusicEngine(
    {
      env: { ctx } as never,
      accBus: stub,
      leadBus: stub,
      padBus: stub,
      fxBus: stub,
      render: { voice: () => {}, pad: () => {}, shaker: () => {} } as never,
    } as never,
    { theme: 'spring', scene: scene as never, autoVariation: true, tension: 0 } as never,
  )
  const priv = engine as unknown as { tick: () => void; opts: { tension: number } }
  return {
    engine,
    drive: (n, tensionOf) => {
      for (let i = 0; i < n; i++) {
        now += 0.05
        priv.tick()
        priv.opts.tension = tensionOf(i)
      }
    },
  }
}

describe('BGM · 调性稳定', () => {
  it('紧张度 0 → 1 全程，移调量保持不变', () => {
    const { engine, drive } = makeEngine()
    const seen = new Set<number>()
    // 每 40ms 记录一次；紧张度用不同的斜率各跑一遍
    for (const slope of [0.0006, 0.002, 0.02]) {
      drive(1200, (i) => Math.min(1, i * slope))
      seen.add(engine.lastTranspose)
    }
    expect([...seen]).toEqual([0])
  })

  it('紧张度突变（0 → 1 一步到位）也不会改变移调', () => {
    const { engine, drive } = makeEngine()
    const seen = new Set<number>()
    for (let round = 0; round < 3; round++) {
      drive(400, () => (round % 2 === 0 ? 1 : 0))
      seen.add(engine.lastTranspose)
    }
    expect([...seen]).toEqual([0])
  })

  it('切换场景才允许改变移调（终局负 = memory，tp 为 -2）', () => {
    const { engine, drive } = makeEngine('overLose')
    drive(400, () => 0.5)
    expect(engine.lastTranspose).toBe(-2)
  })
})
