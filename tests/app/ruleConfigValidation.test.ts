/**
 * 对局存档：config / pendingConfig 的**字段级**校验（KN-27）
 *
 * 背景：`loadStateDetailed` 文件头宣称「声明式字段校验 + 不合法整份丢弃」，
 * 数字字段一律要求 `Number.isFinite`、牌 id 全局唯一、`Play.analysis` 重算 ——
 * 但对 `config` / `pendingConfig` 只做了 `isObj` 一个判断，8 个规则开关字段全部裸奔。
 *
 * 这不是「类型不整洁」而已，是**规则行为会被静默改写**：
 *   - `state.config.twoAsPermanent` 直接决定 `ctxOf` 里 `buildPowerTable({ mode })`，
 *     被塞成字符串 / null 会让「2 是否为常主」翻转（见本文件的证据用例）；
 *   - `ctx.config.allowSelfCounter / allowCounterNT / allowPartnerGuard` 被
 *     `core/counter.ts` 的 `if (!ctx.config.X)` 读取，非 boolean 直接反转分支；
 *   - `config.guardScoreLevels / guardJack / ...` 被 `core/settle.ts` 的
 *     `isGuardedLevel` 读取，决定 5/10/K/J/A/打王 是否禁跳级；
 *   - `pendingConfig` 被设置面板 `render.ts` 直接渲染成 `aria-checked`。
 *
 * 偏好侧 `loadPrefs().sanitizeConfig` 早就逐字段校验了，状态侧是漏的 ——
 * 两处各自手写字段清单还会再次分叉（KN-24 / KN-26 同类教训）。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { loadStateDetailed, saveState } from '@app/persist'
import { ctxOf } from '@app/state'
import { DEFAULT_RULE_CONFIG } from '@core'
import type { Card, CardValue, LevelRank, RuleConfig, Trump } from '@core'
import type { GameState } from '@app/state'
import { newGame, reduce } from '@app/game'
import { declareAndPass } from '../helpers/declare'

const KEY_STATE = 'tractor.state.v1'

class MemoryStorage {
  private readonly map = new Map<string, string>()
  getItem(key: string): string | null { return this.map.get(key) ?? null }
  setItem(key: string, value: string): void { this.map.set(key, value) }
  removeItem(key: string): void { this.map.delete(key) }
  clear(): void { this.map.clear() }
}

let store: MemoryStorage
beforeEach(() => {
  store = new MemoryStorage()
  vi.stubGlobal('localStorage', store)
})
afterEach(() => { vi.unstubAllGlobals() })

/** 打到 play 阶段的可恢复对局（contract 阶段本就不恢复，见 persist.test.ts） */
const playState = (seed: number): GameState => {
  let s = newGame(DEFAULT_RULE_CONFIG, 1, 420, seed)
  s = declareAndPass(s, 0)
  if (s.phase === 'bury') {
    const hand = s.hands[s.dealer] as readonly Card[]
    s = reduce(s, { type: 'bury', ids: hand.slice(0, 8).map((c) => c.id) })
  }
  return s
}

/** 从默认配置动态取键，测试自动跟随 RuleConfig 增删（不再手写第二份清单） */
const CFG_KEYS = Object.keys(DEFAULT_RULE_CONFIG) as (keyof RuleConfig)[]

/** 把存档里 config / pendingConfig 的某个键替换成任意非法值 */
function withTampered(
  field: 'config' | 'pendingConfig',
  key: keyof RuleConfig,
  value: unknown,
): ReturnType<typeof loadStateDetailed> {
  const s = playState(41)
  store.setItem(
    KEY_STATE,
    JSON.stringify({ ...s, [field]: { ...s[field], [key]: value } }),
  )
  return loadStateDetailed()
}

const BAD_VALUES: readonly unknown[] = ['yes', 'false', null, 42, 0, {}, [], { x: 1 }]

describe('对局存档：规则开关必须逐字段是 boolean', () => {
  it('证据：非 boolean 的规则开关会被 truthy 语义解释成另一套规则', () => {
    const s = playState(50)
    // 走真实的受害路径 ctxOf：它用 `config.twoAsPermanent ? 1 : 0` 决定牌力表 mode。
    const seq = (two: unknown, levelRank: LevelRank, trump: Trump): number[] => {
      const p = ctxOf({
        ...s,
        levelRank,
        trump,
        config: { ...s.config, twoAsPermanent: two as boolean },
      }).power
      return Array.from({ length: 54 }, (_, i) => p.get(i as CardValue) as unknown as number)
    }
    const ranks: LevelRank[] = [2, 3, 5, 10, 13, 18]
    const trumps: Trump[] = [0, 1, 2, 3, 'NT']
    // 合法「关」= false ⇒ mode 0；存档里被篡改成字符串 'false'（truthy）⇒ mode 1。
    // 遍历多组级牌/主花色，只要有一组不同，就证明「非法值会静默改写本局规则」
    // 不只是类型不整洁（单一组合下 mode 0/1 可能恰好同表，故不能只测一组）。
    const hasDiff = ranks.some((lr) =>
      trumps.some((t) => seq('false', lr, t).some((v, i) => v !== seq(false, lr, t)[i])),
    )
    expect(hasDiff).toBe(true)
  })

  for (const field of ['config', 'pendingConfig'] as const) {
    for (const key of CFG_KEYS) {
      it(`${field}.${key} 非 boolean ⇒ 整份丢弃（8 个开关全覆盖）`, () => {
        for (const v of BAD_VALUES) {
          const r = withTampered(field, key, v)
          expect(r.state, `${field}.${key} = ${JSON.stringify(v)} 应被拒绝`).toBeNull()
          expect(r.issue).toBe('corrupt')
        }
      })
    }

    it(`${field} 缺字段 ⇒ 整份丢弃`, () => {
      const s = playState(43)
      const cfg = { ...s[field] } as Record<string, unknown>
      for (const key of CFG_KEYS) {
        const missing = { ...cfg }
        delete missing[key]
        store.setItem(KEY_STATE, JSON.stringify({ ...s, [field]: missing }))
        expect(loadStateDetailed().state, `缺 ${key} 应被拒绝`).toBeNull()
      }
    })

    it(`${field} 不是对象 ⇒ 整份丢弃（原有 isObj 语义不回退）`, () => {
      const s = playState(44)
      for (const v of [null, 42, 'nope', []]) {
        store.setItem(KEY_STATE, JSON.stringify({ ...s, [field]: v }))
        expect(loadStateDetailed().state).toBeNull()
      }
    })
  }

  it('合法存档往返：config / pendingConfig 逐字段原样回来（不误杀）', () => {
    const s = playState(46)
    saveState(s)
    const back = loadStateDetailed().state
    expect(back).not.toBeNull()
    expect(back!.config).toEqual(s.config)
    expect(back!.pendingConfig).toEqual(s.pendingConfig)
  })

  it('玩家显式关掉的开关能正常往返（校验不能把 false 当非法）', () => {
    const s = playState(47)
    const custom: RuleConfig = {
      ...s.config,
      twoAsPermanent: false,
      allowCounterNT: true,
      guardJack: true,
      guardAce: false,
    }
    store.setItem(KEY_STATE, JSON.stringify({ ...s, config: custom, pendingConfig: custom }))
    const back = loadStateDetailed().state
    expect(back).not.toBeNull()
    expect(back!.config).toEqual(custom)
    expect(back!.pendingConfig).toEqual(custom)
  })
})
