/**
 * 悔牌（undo）的边界（v1.3.29 · docs/35 F7）
 *
 *   - C5-01 快照是整个 `GameState`，所以「出牌 → 改设置 → 悔牌」会把设置一起退回，
 *           而 `afterChange()` 还会把回退后的值写回 localStorage ⇒ 用户设置被永久抹掉。
 *           修法：悔牌恢复时用**当前**偏好字段覆盖快照里的旧值。
 *   - C5-02 `canUndo` 不看 `replayAt`，回放中悔牌会静默退出回放。
 */

import { describe, expect, it } from 'vitest'
import { DEFAULT_RULE_CONFIG } from '@core'
import type { Card } from '@core'
import { newGame, pickPrefs, reduce } from '@app/game'
import { canUndo, emptyUndo, pushUndo, shouldPush } from '@app/undo'
import type { GameState } from '@app/state'
import { declareAndPass } from '../helpers/declare'

function toPlay(seed = 70): GameState {
  let s = newGame(DEFAULT_RULE_CONFIG, 1, 420, seed)
  s = declareAndPass(s, 0)
  if (s.phase === 'bury') {
    const hand = s.hands[s.dealer] as readonly Card[]
    s = reduce(s, { type: 'bury', ids: hand.slice(0, 8).map((c) => c.id) })
  }
  return s
}

describe('F7 · 悔牌不吞掉设置（C5-01）', () => {
  it('pickPrefs 覆盖后，偏好取当前值、对局字段取快照值', () => {
    const base = toPlay()
    // 快照 = 改设置之前（四色关、音量 75）
    const snapshot: GameState = { ...base, fourColor: false, volumeMaster: 75, musicTheme: 'spring' }
    // 当前 = 改设置之后（四色开、音量 11、冬主题）
    const current: GameState = {
      ...base,
      fourColor: true,
      volumeMaster: 11,
      musicTheme: 'winter',
      step: base.step + 7,
    }

    // 模拟 undoMove 的合并顺序
    const restored: GameState = { ...snapshot, ...pickPrefs(current) }

    expect(restored.fourColor).toBe(true)
    expect(restored.volumeMaster).toBe(11)
    expect(restored.musicTheme).toBe('winter')
    // 对局字段必须来自快照（step 是「回到本墩开始前」的标志）
    expect(restored.step).toBe(snapshot.step)
  })

  it('pickPrefs 覆盖的字段清单与 PREF_FIELDS 一致（含 16 项）', () => {
    const s = toPlay()
    const picked = pickPrefs(s)
    expect(Object.keys(picked).sort()).toEqual(
      [
        'aiPeekHands',
        'animation',
        'animSpeed',
        'autoVariation',
        'cardSize',
        'fourColor',
        'hintSelects',
        'hintStyle',
        'musicTheme',
        'showCounter',
        'showHistory',
        'showOppHands',
        'soundEnhanced',
        'volumeBgm',
        'volumeMaster',
        'volumeSfx',
      ].sort(),
    )
  })
})

describe('F7 · 回放中不能悔牌（C5-02）', () => {
  it('replayAt 非 null 时 canUndo 返回 false', () => {
    const s = toPlay()
    const store = pushUndo(emptyUndo(), s)
    expect(canUndo(s, store)).toBe(true)
    expect(canUndo({ ...s, replayAt: 0 }, store)).toBe(false)
  })

  it('空栈时永远不能悔牌', () => {
    const s = toPlay()
    expect(canUndo(s, emptyUndo())).toBe(false)
  })
})

describe('F7 · shouldPush 语义（回归）', () => {
  it('一墩的第一张牌打出时才压栈', () => {
    const s = toPlay()
    const first: GameState = {
      ...s,
      trick: { leader: 0, plays: [{ seat: 0, cards: [s.hands[0]![0]!], analysis: s.trick.plays[0]?.analysis ?? ({} as never) }], winner: null },
    }
    // 只要 prev 本墩为空、next 本墩有 1 手，就该压栈（analysis 不参与判定）
    expect(shouldPush(s, first)).toBe(true)
    // 本墩已有牌 → 不压
    expect(shouldPush(first, first)).toBe(false)
  })
})
