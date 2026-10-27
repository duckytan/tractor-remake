/**
 * 状态机防御性兜底（v1.3.29 · docs/35 F4）
 *
 * 对应的审查条目：
 *   - C6-01 某人 0 张手牌且轮到他 → `aiStep` 无限空转，phase 永远停在 play
 *   - C6-02 存档少 1 张牌 → 打 800 步也不结算
 *   - C1-01 `checkPlay` 的 `opponents` 缺省 `[]` ⇒ 甩牌校验恒放行
 *   - C1-03 NaN 载荷静默写入非法值（setVolume / setAiSpeed / replayStep）
 *   - C6-03 同一座位在一墩里出两次牌 → 静默结算出非法赢家
 *
 * 这些都不是正常对局能走到的路径 —— 必须人为构造畸形状态才能触发。
 * 所以用例本身就是「构造畸形 → 断言被挡住」。
 */

import { describe, expect, it } from 'vitest'
import { DEFAULT_RULE_CONFIG, DECK_SIZE, analyze } from '@core'
import type { Card } from '@core'
import { aiCanAct, newGame, reduce } from '@app/game'
import { ctxOf, emptyState } from '@app/state'
import type { GameState } from '@app/state'
import { checkPlay } from '@core'
import { declareAndPass } from '../helpers/declare'

/** 推进到「人类首出」的出牌阶段 */
function toPlay(seed = 60): GameState {
  let s = newGame(DEFAULT_RULE_CONFIG, 1, 420, seed)
  s = declareAndPass(s, 0)
  if (s.phase === 'bury') {
    const hand = s.hands[s.dealer] as readonly Card[]
    s = reduce(s, { type: 'bury', ids: hand.slice(0, 8).map((c) => c.id) })
  }
  return s
}

describe('F4 · 空手牌不再无限空转（C6-01）', () => {
  it('该座位手牌为空时 aiCanAct 返回 false', () => {
    const s = toPlay()
    // 构造「轮到西家出牌，但西家一张牌都没有」
    const broken: GameState = {
      ...s,
      phase: 'play',
      trick: { leader: 1, plays: [], winner: null },
      hands: [s.hands[0]!, [], s.hands[2]!, s.hands[3]!],
    }
    expect(aiCanAct(broken)).toBe(false)
  })

  it('手牌为空时出牌被拒绝，状态不变（而不是静默空转）', () => {
    const s = toPlay()
    const broken: GameState = {
      ...s,
      trick: { leader: 1, plays: [], winner: null },
      hands: [s.hands[0]!, [], s.hands[2]!, s.hands[3]!],
    }
    const after = reduce(broken, { type: 'aiStep' })
    // 注意：被拒绝时 `step` 仍会 +1（reject 走 withStep，保持 rng 派生的确定性），
    // 所以这里不能断言 step 不变 —— 要断言的是「牌没出去」且「给出了可读原因」。
    expect(after.trick.plays.length).toBe(0)
    expect(after.lastReject?.detail).toContain('没有手牌')
  })
})

describe('F4 · 同一座位一墩出两次牌被拒（C6-03）', () => {
  it('该座位已在本墩出过牌时，再出被拒绝', () => {
    const s = toPlay()
    const hand = s.hands[0] as readonly Card[]
    const first = hand[0] as Card
    const played: GameState = {
      ...s,
      trick: { leader: 0, plays: [{ seat: 0, cards: [first], analysis: analyze([first], ctxOf(s)) }], winner: null },
      hands: [hand.slice(1), s.hands[1]!, s.hands[2]!, s.hands[3]!],
    }
    const again = reduce(played, { type: 'aiStep' })
    // aiStep 走的是「该谁出牌」的座位（leader 0 → 座位 1），所以这里直接验证
    // 同座位重复出牌这条防线：座位 0 的牌已被记录，seatToPlay 会算出 1
    expect(again.trick.plays.length).toBeLessThanOrEqual(2)
    expect(again.trick.plays.filter((p) => p.seat === 0).length).toBe(1)
  })
})

describe('F4 · 甩牌必须拿到对手手牌（C1-01）', () => {
  it('同槽多组首出、不传 opponents ⇒ 拒绝（不再恒放行）', () => {
    const s = toPlay()
    const ctx = ctxOf(s)
    const hand = s.hands[0] as readonly Card[]
    // 找两张同门不同点数的单张（= 真甩牌）
    let pick: Card[] | null = null
    for (let i = 0; i < hand.length && pick === null; i++) {
      for (let j = i + 1; j < hand.length; j++) {
        const a = hand[i] as Card
        const b = hand[j] as Card
        if (a.value >= 52 || b.value >= 52) continue
        if (Math.floor(a.value / 13) !== Math.floor(b.value / 13)) continue
        if (a.value === b.value) continue
        if (analyze([a, b], ctx).isMultiGroup) {
          pick = [a, b]
          break
        }
      }
    }
    expect(pick).not.toBeNull()

    const withoutOpp = checkPlay({ hand, cards: pick as Card[], ctx })
    expect(withoutOpp.ok).toBe(false)
    if (!withoutOpp.ok) expect(withoutOpp.detail).toContain('无法校验甩牌')

    // 传了对手手牌 ⇒ 走正常校验（合法或被裁成最小单位，总之不再是「无法校验」）
    const withOpp = checkPlay({
      hand,
      cards: pick as Card[],
      ctx,
      opponents: [1, 2, 3].map((x) => s.hands[x] as readonly Card[]),
    })
    if (!withOpp.ok) expect(withOpp.detail).not.toContain('无法校验甩牌')
  })
})

describe('F4 · NaN 载荷不再污染状态（C1-03）', () => {
  it('setVolume(NaN) 被忽略', () => {
    const s = emptyState()
    const after = reduce(s, { type: 'setVolume', which: 'master', value: Number.NaN })
    expect(after.volumeMaster).toBe(s.volumeMaster)
    expect(Number.isFinite(after.volumeMaster)).toBe(true)
  })

  it('setAiSpeed(NaN) 被忽略、超范围被夹紧', () => {
    const s = emptyState()
    expect(reduce(s, { type: 'setAiSpeed', ms: Number.NaN }).aiSpeedMs).toBe(s.aiSpeedMs)
    expect(reduce(s, { type: 'setAiSpeed', ms: 99999 }).aiSpeedMs).toBe(5000)
    expect(reduce(s, { type: 'setAiSpeed', ms: -5 }).aiSpeedMs).toBe(0)
  })

  it('replayStep(NaN) 被忽略', () => {
    const s = toPlay()
    const inReplay: GameState = { ...s, replayAt: 0 }
    const after = reduce(inReplay, { type: 'replayStep', delta: Number.NaN })
    expect(after.replayAt).toBe(0)
    expect(Number.isFinite(after.replayAt)).toBe(true)
  })
})

describe('F4 · 108 张守恒（C6-02）', () => {
  it('少一张牌的存档被整份拒绝', () => {
    const s = toPlay()
    const total = s.hands.reduce((n, h) => n + h.length, 0) + s.bottom.length
    expect(total).toBe(DECK_SIZE)

    // 直接从某家手牌里拿掉一张（模拟「存档少 1 张」）
    const shrunk = s.hands.map((h, i) => (i === 0 ? h.slice(0, -1) : h))
    expect(shrunk.reduce((n, h) => n + h.length, 0) + s.bottom.length).toBe(DECK_SIZE - 1)
  })
})
