/**
 * 对局日志档（`tractor.logs.v1`）的元素级校验（KN-29）
 *
 * 背景：`roundLog.ts :: initRoundLog` 读日志档时只做 `Array.isArray(o.rounds)`，
 * 数组里的每个 `RoundLog`（5 层嵌套：hands / tricks[].plays / human / aiNotes / settle）
 * 一个字段都没验。这与 KN-27（config）、KN-28（lastSettle）是同一条防线的最后一格 ——
 * 对局存档与偏好存档都已做字段级校验，唯独「记录」用的日志档还裸奔。
 *
 * 这不是「类型不整洁」而是**崩溃**：`ui/render.ts :: logPanel` 直接读
 * `prev.tricks.length` / `prev.settle.defenderScore`，`app/view.ts :: loggedTrickView`
 * 直接 `r.tricks.map(...)`。一份被篡改 / 损坏的日志档（尤其是网络传来的分析档）
 * 会让「对局记录」面板白屏。
 *
 * 修法照 KN-28：写逐层递归的 `isRoundLog` + 类型推导的完备校验表（加字段忘加校验器
 * ⇒ tsc 红），`initRoundLog` 里坏条目整条丢弃（同 stats.ts 口径），不让一条脏记录
 * 拖垮整个面板。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initRoundLog, loggedRounds } from '@app/roundLog'
import { loggedTrickView } from '@app/view'

const KEY = 'tractor.logs.v1'

class MemoryStorage {
  private readonly map = new Map<string, string>()
  getItem(k: string): string | null { return this.map.get(k) ?? null }
  setItem(k: string, v: string): void { this.map.set(k, v) }
  removeItem(k: string): void { this.map.delete(k) }
}

let store: MemoryStorage
beforeEach(() => {
  store = new MemoryStorage()
  vi.stubGlobal('localStorage', store)
})
afterEach(() => { vi.unstubAllGlobals() })

/** 一条字段全部合法的 RoundLog（照 finishRound 的产物形状） */
function validLog(): Record<string, unknown> {
  return {
    v: 1,
    app: '1.3.60',
    ts: 1700000000000,
    seed: 11,
    round: 1,
    config: {
      allowSelfCounter: true, twoAsPermanent: true, allowPartnerGuard: false,
      allowCounterNT: false, guardScoreLevels: true, guardJack: true,
      guardAce: true, guardKingLevel: true,
    },
    levelRank: 2,
    trump: 2,
    forcedNT: false,
    dealer: 1,
    ai: { partner: 3, opponent: 3, auto: 2, peek: true, hintStyle: 'ai' },
    hands: [[0, 1, 2], [13, 14, 15], [26, 27, 28], [39, 40, 41]],
    bottom: [52, 53],
    tricks: [
      { leader: 1, plays: [[1, [13]], [2, [26]]], winner: 1, score: 0 },
    ],
    human: [{ trick: 0, cards: [0], ai: [1], hint: true, hintCards: [1] }],
    aiNotes: [{ trick: 0, seat: 1, text: '压住', detail: '能压过当前最大' }],
    settle: {
      defenderScore: 75, levelUpTeam: 1, levels: 1, actualLevels: 1,
      dealerChanged: true, newDealer: 1, gameOver: false,
    },
  }
}

const write = (rounds: unknown): void => store.setItem(KEY, JSON.stringify({ rounds }))
/** 写入后走真实的 initRoundLog 路径，返回存活下来的条目 */
const load = (): readonly Record<string, unknown>[] => {
  initRoundLog()
  return loggedRounds() as unknown as readonly Record<string, unknown>[]
}

describe('日志档元素校验：危害证据（为什么必须拒）', () => {
  it('坏 tricks / settle 一旦进运行时，复盘视图直接抛异常', () => {
    const good = validLog()
    expect(() => loggedTrickView({ ...good, tricks: null } as never)).toThrow()
    // settle.defenderScore 被 logPanel 直接读；为 null 时同样会崩
    expect((good.settle as Record<string, unknown>).defenderScore).toBe(75)
  })
})

describe('日志档元素校验：合法条目保留', () => {
  it('字段全合法的条目原样读回', () => {
    const good = validLog()
    write([good])
    expect(load()).toEqual([good])
  })

  it('老日志没有 aiNotes 也能读（可选字段）', () => {
    const old = validLog()
    delete old.aiNotes
    write([old])
    expect(load()).toEqual([old])
  })

  it('老日志的 human 条目没有 hintCards 也能读（可选字段）', () => {
    const old = validLog()
    const h = (old.human as Record<string, unknown>[])[0]!
    delete h.hintCards
    write([old])
    expect(load()).toEqual([old])
  })

  it('没有开局快照的日志（hands 为空数组）合法', () => {
    const noSnap = validLog()
    noSnap.hands = []
    noSnap.human = []
    noSnap.aiNotes = []
    write([noSnap])
    expect(load()).toEqual([noSnap])
  })

  it('全部是空 rounds 时读成空', () => {
    store.setItem(KEY, JSON.stringify({ rounds: [] }))
    initRoundLog()
    expect(loggedRounds()).toHaveLength(0)
  })
})

describe('日志档元素校验：坏条目整条丢弃', () => {
  const BAD: readonly [string, (r: Record<string, unknown>) => unknown][] = [
    ['元素是 null', () => null],
    ['元素是字符串', () => 'garbage'],
    ['元素是数字', () => 42],
    ['v 不是 1', (r) => ({ ...r, v: 2 })],
    ['seed 非有限数', (r) => ({ ...r, seed: '11' })],
    ['round 负数', (r) => ({ ...r, round: -1 })],
    ['config 为 null', (r) => ({ ...r, config: null })],
    ['config 缺一个开关', (r) => {
      const c = { ...(r.config as Record<string, unknown>) }
      delete c.guardAce
      return { ...r, config: c }
    }],
    ['config 开关是字符串', (r) => ({ ...r, config: { ...(r.config as object), guardAce: 'true' } })],
    ['levelRank=99（非法级牌）', (r) => ({ ...r, levelRank: 99 })],
    ['trump=5（非法花色）', (r) => ({ ...r, trump: 5 })],
    ['forcedNT 是数字', (r) => ({ ...r, forcedNT: 1 })],
    ['dealer=9（非法座位）', (r) => ({ ...r, dealer: 9 })],
    ['ai.partner 是字符串', (r) => ({ ...r, ai: { ...(r.ai as object), partner: '3' } })],
    ['ai.peek 是数字', (r) => ({ ...r, ai: { ...(r.ai as object), peek: 1 } })],
    ['hands 为 null（复盘视图直接崩）', (r) => ({ ...r, hands: null })],
    ['hands 元素非数组', (r) => ({ ...r, hands: [[0, 1], 'bad'] })],
    ['hands 牌值越界（99）', (r) => ({ ...r, hands: [[99]] })],
    ['bottom 牌值越界', (r) => ({ ...r, bottom: [-1] })],
    ['tricks 为 null（logPanel 直接读 .length）', (r) => ({ ...r, tricks: null })],
    ['tricks 元素为 null', (r) => ({ ...r, tricks: [null] })],
    ['tricks[].plays 为 null', (r) => ({
      ...r, tricks: [{ ...(r.tricks as Record<string, unknown>[])[0]!, plays: null }],
    })],
    ['tricks[].plays 元素不是 [座位,牌数组]', (r) => ({
      ...r, tricks: [{ ...(r.tricks as Record<string, unknown>[])[0]!, plays: ['bad'] }],
    })],
    ['tricks[].plays[].牌数组为 null', (r) => ({
      ...r, tricks: [{ ...(r.tricks as Record<string, unknown>[])[0]!, plays: [[1, null]] }],
    })],
    ['tricks[].winner=9（非法座位）', (r) => ({
      ...r, tricks: [{ ...(r.tricks as Record<string, unknown>[])[0]!, winner: 9 }],
    })],
    ['tricks[].score 是字符串', (r) => ({
      ...r, tricks: [{ ...(r.tricks as Record<string, unknown>[])[0]!, score: '0' }],
    })],
    ['human 为 null', (r) => ({ ...r, human: null })],
    ['human[].cards 为 null', (r) => ({
      ...r, human: [{ ...(r.human as Record<string, unknown>[])[0]!, cards: null }],
    })],
    ['human[].hint 是字符串', (r) => ({
      ...r, human: [{ ...(r.human as Record<string, unknown>[])[0]!, hint: 'true' }],
    })],
    ['human[].hintCards 出现但非法', (r) => ({
      ...r, human: [{ ...(r.human as Record<string, unknown>[])[0]!, hintCards: 7 }],
    })],
    ['aiNotes 为 null（可选字段出现却坏）', (r) => ({ ...r, aiNotes: null })],
    ['aiNotes 元素为 null', (r) => ({ ...r, aiNotes: [null] })],
    ['aiNotes[].seat=9', (r) => ({
      ...r, aiNotes: [{ ...(r.aiNotes as Record<string, unknown>[])[0]!, seat: 9 }],
    })],
    ['aiNotes[].detail 是数字', (r) => ({
      ...r, aiNotes: [{ ...(r.aiNotes as Record<string, unknown>[])[0]!, detail: 5 }],
    })],
    ['settle 为 null（logPanel 直接读 .defenderScore）', (r) => ({ ...r, settle: null })],
    ['settle.defenderScore 是字符串', (r) => ({
      ...r, settle: { ...(r.settle as object), defenderScore: '75' },
    })],
    ['settle.newDealer=9', (r) => ({
      ...r, settle: { ...(r.settle as object), newDealer: 9 },
    })],
    ['settle.gameOver 是数字', (r) => ({
      ...r, settle: { ...(r.settle as object), gameOver: 1 },
    })],
  ]

  for (const [label, make] of BAD) {
    it(`${label} ⇒ 整条丢弃`, () => {
      write([make(validLog())])
      expect(load(), label).toHaveLength(0)
    })
  }

  it('好坏混合：只留合法条目，坏条目整条丢弃不拖垮好条目', () => {
    const good = validLog()
    write([makeBad(), good, null, makeBad()])
    const survived = load()
    expect(survived).toHaveLength(1)
    expect(survived[0]).toEqual(good)
  })
})

/** 造一条坏条目（tricks=null，复盘视图会崩） */
function makeBad(): Record<string, unknown> {
  return { ...validLog(), tricks: null }
}
