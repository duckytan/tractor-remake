import { describe, expect, it } from 'vitest'

import {
  SCORE_CLIFFS,
  crossedCliff,
  isLastTrick,
  isMyTeamWin,
  remainingCards,
  sceneOf,
  soundEventsOf,
  tensionOf,
} from '@audio/observe'
import type { AudioStateLike, SoundEvent } from '@audio/observe'

/** 造一个「出牌阶段、四家各 10 张、还没出牌」的基准状态 */
function base(over: Partial<AudioStateLike> = {}): AudioStateLike {
  return {
    phase: 'play',
    revealed: 33,
    round: 1,
    dealPrompt: false,
    trumpDeclarer: 0,
    trumpCount: 1,
    guardBy: null,
    usedTrumps: [0],
    trick: { plays: [] },
    tricksDone: 0,
    defenderScore: 0,
    history: [],
    hands: [Array(10).fill(0), Array(10).fill(0), Array(10).fill(0), Array(10).fill(0)],
    lastReject: null,
    replayAt: null,
    lastSettle: null,
    selected: [],
    ...over,
  }
}

const types = (evs: SoundEvent[]): string[] => evs.map((e) => e.type)

describe('observe / sceneOf', () => {
  it('定主与埋底都用 calm', () => {
    expect(sceneOf(base({ phase: 'contract' }))).toBe('calm')
    expect(sceneOf(base({ phase: 'bury' }))).toBe('calm')
  })

  it('出牌用 play', () => {
    expect(sceneOf(base())).toBe('play')
  })

  it('结算用 settle', () => {
    expect(sceneOf(base({ phase: 'settle' }))).toBe('settle')
  })

  it('终局按 winnerTeam 分胜负两版', () => {
    const st = (winnerTeam?: number) => ({ levels: 1, dealerChanged: false, gameOver: true, winnerTeam })
    expect(sceneOf(base({ phase: 'over', lastSettle: st(0) }))).toBe('overWin')
    expect(sceneOf(base({ phase: 'over', lastSettle: st(1) }))).toBe('overLose')
    // 缺 winnerTeam 时按胜处理（不能崩）
    expect(sceneOf(base({ phase: 'over', lastSettle: st(undefined) }))).toBe('overWin')
    expect(sceneOf(base({ phase: 'over', lastSettle: null }))).toBe('overWin')
  })

  it('回放优先级最高', () => {
    expect(sceneOf(base({ replayAt: 3, phase: 'settle' }))).toBe('replay')
  })
})

describe('observe / 紧张度', () => {
  it('非出牌阶段一律 0', () => {
    for (const phase of ['contract', 'bury', 'settle', 'over'] as const) {
      expect(tensionOf(base({ phase }))).toBe(0)
    }
  })

  it('闲家得分越高越紧，且单调不减', () => {
    let prev = -1
    for (const d of [0, 10, 39, 40, 79, 80, 119, 120, 159, 160, 200]) {
      const t = tensionOf(base({ defenderScore: d }))
      expect(t).toBeGreaterThanOrEqual(prev)
      prev = t
    }
    expect(tensionOf(base({ defenderScore: 200 }))).toBeGreaterThan(tensionOf(base({ defenderScore: 0 })))
  })

  it('手牌将空时明显变紧，最后一墩最紧', () => {
    const many = tensionOf(base())
    const few = tensionOf(base({ hands: [Array(4).fill(0), Array(4).fill(0), Array(4).fill(0), Array(4).fill(0)] }))
    const last = tensionOf(base({ hands: [Array(1).fill(0), Array(1).fill(0), Array(1).fill(0), Array(1).fill(0)] }))
    expect(few).toBeGreaterThan(many)
    expect(last).toBeGreaterThanOrEqual(few)
    expect(last).toBeLessThanOrEqual(1)
  })
})

describe('observe / 余量与最后一墩', () => {
  it('取四家里最少的那家', () => {
    expect(remainingCards(base({ hands: [[5], [3], [9], [7]] as never }))).toBe(1)
  })

  it('手牌为空时返回 0，不返回 Infinity', () => {
    expect(remainingCards(base({ hands: [[], [], [], []] as never }))).toBe(0)
  })

  it('最后一墩 = 每家剩 1..4 张，而不是固定第 25 墩', () => {
    const mk = (n: number) => base({ hands: [Array(n).fill(0), Array(n).fill(0), Array(n).fill(0), Array(n).fill(0)] })
    expect(isLastTrick(mk(1))).toBe(true)
    expect(isLastTrick(mk(4))).toBe(true)
    expect(isLastTrick(mk(5))).toBe(false)
    expect(isLastTrick(mk(0))).toBe(false)
    // 非出牌阶段不算
    expect(isLastTrick(base({ phase: 'settle', hands: [Array(1).fill(0)] as never }))).toBe(false)
  })
})

describe('observe / 得分悬崖', () => {
  it('四道悬崖都在', () => {
    expect(SCORE_CLIFFS).toEqual([40, 80, 120, 160])
  })

  it('跨过才算，停在原地不算', () => {
    expect(crossedCliff(39, 40)).toBe(true)
    expect(crossedCliff(40, 41)).toBe(false)
    expect(crossedCliff(79, 120)).toBe(true)
    expect(crossedCliff(0, 39)).toBe(false)
  })
})

describe('observe / 终局判定', () => {
  it('队 0 是我方；缺省也按我方胜处理', () => {
    expect(isMyTeamWin(0)).toBe(true)
    expect(isMyTeamWin(1)).toBe(false)
    expect(isMyTeamWin(undefined)).toBe(true)
  })
})

describe('observe / 声音事件', () => {
  it('出牌：出牌数 +1 就响一次，并带座位号', () => {
    const prev = base()
    const next = base({ trick: { plays: [{ seat: 1, cards: [0] }] } })
    const evs = soundEventsOf(prev, next)
    expect(types(evs)).toContain('play')
    const e = evs.find((x) => x.type === 'play') as { seat: number; multi: boolean }
    expect(e.seat).toBe(1)
    expect(e.multi).toBe(false)
  })

  it('甩牌（一手 ≥4 张）标记为 multi', () => {
    const prev = base()
    const next = base({ trick: { plays: [{ seat: 0, cards: [0, 1, 2, 3] }] } })
    const e = soundEventsOf(prev, next).find((x) => x.type === 'play') as { multi: boolean }
    expect(e.multi).toBe(true)
  })

  it('赢墩 / 输墩按队别区分（座位 0/2 是我方）', () => {
    const prev = base({ history: [] })
    const win = soundEventsOf(prev, base({ history: [{ winner: 2 }] }))
    expect(types(win)).toContain('win')
    const lose = soundEventsOf(prev, base({ history: [{ winner: 3 }] }))
    expect(types(lose)).toContain('lose')
  })

  it('一墩打完同时跨过悬崖 → 赢墩 + 悬崖两个音', () => {
    const prev = base({ defenderScore: 30 })
    const next = base({ defenderScore: 45, history: [{ winner: 1 }] })
    expect(types(soundEventsOf(prev, next))).toEqual(expect.arrayContaining(['lose', 'cliff']))
  })

  it('打完最后一墩：结算音与「赢墩 + lastTrick」都要有（不能只有结算音）', () => {
    const prev = base({ hands: [Array(1).fill(0), Array(1).fill(0), Array(1).fill(0), Array(1).fill(0)] as never })
    const next = base({
      hands: [[], [], [], []] as never,
      history: [{ winner: 0 }],
      phase: 'settle',
    })
    const evs = types(soundEventsOf(prev, next))
    expect(evs).toContain('settleUp')
    expect(evs).toContain('win')
    expect(evs).toContain('lastTrick')
  })

  it('非法出牌：新的 lastReject 才响，重复同一原因不再响', () => {
    const prev = base()
    const next = base({ lastReject: { reason: 'COUNT_MISMATCH' } })
    expect(types(soundEventsOf(prev, next))).toContain('illegal')
    // 同一个 reason 再来一帧不重复
    expect(types(soundEventsOf(next, next))).not.toContain('illegal')
  })

  it('甩牌被压回：手牌少了但出牌数没变', () => {
    const prev = base({ hands: [Array(10).fill(0), Array(10).fill(0), Array(10).fill(0), Array(10).fill(0)] as never })
    const next = base({ hands: [Array(8).fill(0), Array(10).fill(0), Array(10).fill(0), Array(10).fill(0)] as never })
    expect(types(soundEventsOf(prev, next))).toContain('bump')
  })

  it('亮主 / 抢庄 / 反主 / 加固 各自一个音', () => {
    // 亮主只发生在定主阶段（phase 还是 contract）
    const none = base({ phase: 'contract', trumpDeclarer: null, usedTrumps: [] })
    expect(
      types(soundEventsOf(none, base({ phase: 'contract', round: 2, trumpDeclarer: 0, usedTrumps: [0] }))),
    ).toContain('declare')
    // 第一局首次亮主 = 抢庄（谁先亮谁坐庄）
    expect(types(soundEventsOf(none, base({ phase: 'contract', trumpDeclarer: 0, usedTrumps: [0], round: 1 })))).toContain(
      'grab',
    )
    // 第 2 局起就只是普通亮主
    expect(types(soundEventsOf(none, base({ phase: 'contract', trumpDeclarer: 0, usedTrumps: [0], round: 2 })))).toContain(
      'declare',
    )
    // 反主：已有人亮主，usedTrumps 变长
    const before = base({ trumpDeclarer: 0, usedTrumps: [0] })
    expect(types(soundEventsOf(before, base({ trumpDeclarer: 1, usedTrumps: [0, 1] })))).toContain('counter')
    // 加固：guardBy 从 null 变有
    expect(types(soundEventsOf(before, base({ trumpDeclarer: 0, usedTrumps: [0], guardBy: 2 })))).toContain('guard')
  })

  it('埋底：contract→bury 响 buryStart，bury→play 响 bury', () => {
    expect(types(soundEventsOf(base({ phase: 'contract' }), base({ phase: 'bury' })))).toContain('buryStart')
    expect(types(soundEventsOf(base({ phase: 'bury' }), base({ phase: 'play' })))).toContain('bury')
  })

  it('埋底选够 8 张响 buryReady，其余选牌响 select', () => {
    const bury = base({ phase: 'bury', selected: [] })
    expect(types(soundEventsOf(bury, base({ phase: 'bury', selected: [1] })))).toContain('select')
    const seven = base({ phase: 'bury', selected: [1, 2, 3, 4, 5, 6, 7] })
    expect(types(soundEventsOf(seven, base({ phase: 'bury', selected: [1, 2, 3, 4, 5, 6, 7, 8] })))).toContain('buryReady')
  })

  it('取消选牌响 deselect；但出牌后清空 selected 不响', () => {
    expect(types(soundEventsOf(base({ selected: [1, 2] }), base({ selected: [] })))).toContain('deselect')
    // 出牌同时清空 selected：出牌数变了，不该再响 deselect
    const evs = types(soundEventsOf(base({ selected: [1] }), base({ selected: [], trick: { plays: [{ seat: 0, cards: [1] }] } })))
    expect(evs).toContain('play')
    expect(evs).not.toContain('deselect')
  })

  it('悔牌（出牌数减少）响 undo', () => {
    const prev = base({ trick: { plays: [{ seat: 0, cards: [1] }] } })
    expect(types(soundEventsOf(prev, base()))).toContain('undo')
  })

  it('发牌 tick 每 4 张一次，不是逐张', () => {
    const at = (n: number) => base({ phase: 'contract', revealed: n })
    expect(types(soundEventsOf(at(0), at(1)))).not.toContain('deal')
    expect(types(soundEventsOf(at(0), at(4)))).toContain('deal')
    expect(types(soundEventsOf(at(4), at(7)))).not.toContain('deal')
    expect(types(soundEventsOf(at(4), at(8)))).toContain('deal')
  })

  it('摸到级牌（发牌暂停）响 levelCard，只响一次', () => {
    const prev = base({ phase: 'contract', dealPrompt: false })
    const next = base({ phase: 'contract', dealPrompt: true })
    expect(types(soundEventsOf(prev, next))).toContain('levelCard')
    expect(types(soundEventsOf(next, next))).not.toContain('levelCard')
  })

  it('结算：升 N 级带级数；闲家上台与必打截断各有专音', () => {
    const prev = base()
    const up = soundEventsOf(
      prev,
      base({ phase: 'settle', lastSettle: { levels: 3, dealerChanged: false, gameOver: false } }),
    )
    const e = up.find((x) => x.type === 'settleUp') as { n: number }
    expect(e.n).toBe(3)

    const promote = soundEventsOf(
      prev,
      base({ phase: 'settle', lastSettle: { levels: 1, dealerChanged: true, gameOver: false } }),
    )
    expect(types(promote)).toContain('promote')

    const guard = soundEventsOf(
      prev,
      base({ phase: 'settle', lastSettle: { levels: 2, dealerChanged: false, guardLevel: 11, gameOver: false } }),
    )
    expect(types(guard)).toContain('guardStop')
  })

  it('结算级数夹在 1..3', () => {
    const e = soundEventsOf(
      base(),
      base({ phase: 'settle', lastSettle: { levels: 9, dealerChanged: false, gameOver: false } }),
    ).find((x) => x.type === 'settleUp') as { n: number }
    expect(e.n).toBe(3)
  })

  it('终局：胜 / 负各一个音，且不再叠加结算音', () => {
    const prev = base({ phase: 'settle' })
    const win = soundEventsOf(
      prev,
      base({ phase: 'over', lastSettle: { levels: 2, dealerChanged: false, gameOver: true, winnerTeam: 0 } }),
    )
    expect(types(win)).toEqual(['overWin'])
    const lose = soundEventsOf(
      prev,
      base({ phase: 'over', lastSettle: { levels: 2, dealerChanged: false, gameOver: true, winnerTeam: 1 } }),
    )
    expect(types(lose)).toEqual(['overLose'])
  })

  it('回放翻墩响 replayStep', () => {
    expect(types(soundEventsOf(base({ replayAt: null }), base({ replayAt: 0 })))).toContain('replayStep')
    expect(types(soundEventsOf(base({ replayAt: 0 }), base({ replayAt: 1 })))).toContain('replayStep')
  })

  it('同一帧状态不变 → 不出任何声音', () => {
    const s = base()
    expect(soundEventsOf(s, s)).toEqual([])
  })
})
