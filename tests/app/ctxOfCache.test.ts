/**
 * `ctxOf` 缓存键必须覆盖整个 config（KN-31）
 *
 * 背景：v1.3.57 给 ctxOf 加了模块级缓存，v1.3.58 把键从字符串拼接改成 4 个字段
 * （twoAsPermanent / levelRank / trump / forcedNT）。但 `RuleContext.config` 里还有
 * `allowSelfCounter` / `allowCounterNT` / `allowPartnerGuard` 三个规则开关，它们**不进键**。
 *
 * 危害：`counter.ts` 的 canCounter/canGuard 读 `ctx.config.<开关>`。缓存命中时返回的是
 * 上一次的 `RuleContext` 对象，其 `config` 引用也是旧的。规则开关改动走
 * `updateConfig → pendingConfig → nextRound → startRound`，下一局 `config` 换成了新对象；
 * 若新局的 (two, levelRank, trump, forcedNT) 恰好与上局末相同 —— 打王级 forcedNT=true、
 * trump='NT'、levelRank=18 且庄家级别没变时正是如此 —— 键全同 ⇒ 命中旧缓存 ⇒
 * 新局的三个开关仍是旧值，玩家的规则设置**静默失效**。
 */
import { describe, expect, it } from 'vitest'
import { ctxOf, emptyState } from '@app/state'
import type { GameState } from '@app/state'
import { DEFAULT_RULE_CONFIG } from '@core'
import type { RuleConfig } from '@core'

/** 用指定 config / 4 个键字段造一个最小状态 */
function ctxState(config: RuleConfig, levelRank: GameState['levelRank'], trump: GameState['trump'], forcedNT: boolean): GameState {
  return { ...emptyState(), config, levelRank, trump, forcedNT }
}

describe('ctxOf 缓存键覆盖整个 config', () => {
  it('4 键相同但 config 引用变化 ⇒ 必须返回新 config（不得命中旧缓存）', () => {
    const oldConfig = { ...DEFAULT_RULE_CONFIG, allowCounterNT: false, allowSelfCounter: true }
    const newConfig = { ...DEFAULT_RULE_CONFIG, allowCounterNT: true, allowSelfCounter: false }

    // 第一次：占住键 (two=true, levelRank=18, trump='NT', forcedNT=true)
    const first = ctxOf(ctxState(oldConfig, 18, 'NT', true))
    expect(first.config.allowCounterNT).toBe(false)

    // 第二次：4 个键字段完全一致，只有 config 引用变了（换局生效新规则）
    const second = ctxOf(ctxState(newConfig, 18, 'NT', true))
    expect(second.config).toBe(newConfig)
    expect(second.config.allowCounterNT).toBe(true)
    expect(second.config.allowSelfCounter).toBe(false)
  })

  it('config 引用变化后 canCounter 读到的是新开关', () => {
    // 直接证伪「缓存返回的 config 引用陈旧」这一步即可 —— counter 只是它的下游读者。
    const a = { ...DEFAULT_RULE_CONFIG, allowCounterNT: false }
    const b = { ...DEFAULT_RULE_CONFIG, allowCounterNT: true }
    ctxOf(ctxState(a, 18, 'NT', true))
    const ctx = ctxOf(ctxState(b, 18, 'NT', true))
    expect(ctx.config.allowCounterNT).toBe(true)
  })

  it('config 引用不变时仍命中缓存（同一 RuleContext 对象，零重建）', () => {
    const config = { ...DEFAULT_RULE_CONFIG }
    const s = ctxState(config, 18, 'NT', true)
    const a = ctxOf(s)
    const b = ctxOf(s)
    expect(b).toBe(a)
  })
})
