/**
 * 作弊开关「查看别人手牌」（`showOppHands`）。
 *
 * 这个开关是**纯展示项**：只决定 `render` 把三家画成牌背还是牌面。
 * 因此本文件锁住三件事：
 *   ① 开关只翻转自己那一个字段，对局状态（手牌 / 出牌 / 阶段 / 轮次）一个字都不能动；
 *   ② 与 `aiPeekHands`（AI 能不能看你）完全独立，互不影响；
 *   ③ 存档口径：老档没有这个字段 ⇒ **必须默认关**（不能升级后突然把三家手牌摊开）。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_RULE_CONFIG } from '@core'
import { newGame, reduce } from '@app/game'
import { loadPrefs, savePrefs } from '@app/persist'
import { emptyState } from '@app/state'
import type { GameState } from '@app/state'

class MemoryStorage {
  private readonly map = new Map<string, string>()
  getItem(k: string): string | null {
    return this.map.get(k) ?? null
  }
  setItem(k: string, v: string): void {
    this.map.set(k, v)
  }
  removeItem(k: string): void {
    this.map.delete(k)
  }
}

let store: MemoryStorage

beforeEach(() => {
  store = new MemoryStorage()
  vi.stubGlobal('localStorage', store)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

/** 造一个已经打到出牌阶段的状态（用固定 seed，便于复现） */
const toPlay = (): GameState => {
  const s = newGame(DEFAULT_RULE_CONFIG, 3, 0, 20261027)
  return { ...s, phase: 'play' }
}

describe('showOppHands · 开关本身', () => {
  it('默认关（emptyState）', () => {
    expect(emptyState().showOppHands).toBe(false)
  })

  it('toggleShowOppHands 两次回到原值', () => {
    const s = toPlay()
    const on = reduce(s, { type: 'toggleShowOppHands' })
    expect(on.showOppHands).toBe(true)
    expect(reduce(on, { type: 'toggleShowOppHands' }).showOppHands).toBe(false)
  })

  it('只翻转 showOppHands：手牌 / 出牌 / 阶段 / 轮次一字不动', () => {
    const s = toPlay()
    const on = reduce(s, { type: 'toggleShowOppHands' })
    const { showOppHands: a, ...rest } = on
    const { showOppHands: b, ...restBefore } = s
    expect(a).toBe(true)
    expect(b).toBe(false)
    expect(rest).toEqual(restBefore)
  })

  it('与 aiPeekHands 互不影响（两个开关是两件事）', () => {
    const s = toPlay()
    const peekOff = reduce(s, { type: 'toggleAiPeek' })
    expect(peekOff.aiPeekHands).toBe(false)
    expect(peekOff.showOppHands).toBe(false)

    const both = reduce(peekOff, { type: 'toggleShowOppHands' })
    expect(both.showOppHands).toBe(true)
    // 打开「我看 AI」不会顺手把「AI 看我」也打开
    expect(both.aiPeekHands).toBe(false)
  })

  it('重开一局保留（属于 PREF_FIELDS 契约）', () => {
    const s = { ...toPlay(), showOppHands: true }
    const next = newGame(DEFAULT_RULE_CONFIG, 3, 420, 7, s)
    expect(next.showOppHands).toBe(true)
  })
})

describe('showOppHands · 存档口径', () => {
  it('老档没有这个字段 ⇒ 默认关', () => {
    store.setItem(
      'tractor.prefs.v1',
      JSON.stringify({
        prefsVersion: 3,
        aiLevelPartner: 3,
        aiLevelOpponent: 3,
        aiSpeedMs: 420,
        fourColor: false,
        cardSize: 'M',
        animation: true,
        animSpeed: 'normal',
        showHistory: true,
        hintSelects: false,
        showCounter: false,
        aiPeekHands: true,
      }),
    )
    expect(loadPrefs().showOppHands).toBe(false)
  })

  it('存档里是 true 才认 true（字符串 / 数字一律不算）', () => {
    savePrefs({ ...loadPrefs(), showOppHands: true })
    expect(loadPrefs().showOppHands).toBe(true)

    store.setItem('tractor.prefs.v1', JSON.stringify({ prefsVersion: 3, showOppHands: 'true' }))
    expect(loadPrefs().showOppHands).toBe(false)

    store.setItem('tractor.prefs.v1', JSON.stringify({ prefsVersion: 3, showOppHands: 1 }))
    expect(loadPrefs().showOppHands).toBe(false)
  })
})
