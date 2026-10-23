/**
 * 测试辅助：把「亮主 + 放弃反主」压成一步。
 *
 * 反主功能上线后，`declareTrump` 不再一定立刻进入出牌：
 * AI 可能反主，然后人类有机会反回来 —— 此时 phase 仍是 'contract'、counterPending=true。
 * 只关心「主已定好」的测试用这个函数，省得每处都写一遍 passCounter。
 *
 * 亮主校验上线后（首次亮主必须持该门级牌），调用方给的 trump 未必可选。
 * 这时退回清单里的第一项（`humanDeclareOptions` 末尾永远有无将兜底），
 * 保证「测试只关心定约完成」的语义不被花色合法性打断。
 *
 * v1.2：亮主持牌校验改用「已揭示前缀」，而 `newGame` 默认开动画（revealed=0）。
 * 这些用例不关心发牌动画，直接把 revealed 补满 = 「假装已经发完」，
 * 否则会在 revealed=0 时被「这张级牌还没发到手」拒掉。
 */

import { reduce } from '@app/game'
import { HAND_SIZE } from '@core'
import type { GameState } from '@app/state'
import type { Trump } from '@core'

export function declareAndPass(s: GameState, trump: Trump): GameState {
  // 发牌动画没跑完 ⇒ 先当作已发满（这些用例只关心定约结果）
  const ready: GameState =
    s.phase === 'contract' && s.revealed < HAND_SIZE ? { ...s, revealed: HAND_SIZE } : s

  const firstDeclare = ready.phase === 'contract' && ready.usedTrumps.length === 0
  const wanted: Trump =
    firstDeclare && !ready.declareOptions.includes(trump) ? (ready.declareOptions[0] ?? 'NT') : trump

  let cur = reduce(ready, { type: 'declareTrump', trump: wanted })
  // 反主最多换 5 次主，循环上界给 6 足够
  for (let i = 0; i < 6 && cur.phase === 'contract' && cur.counterPending; i++) {
    cur = reduce(cur, { type: 'passCounter' })
  }
  return cur
}
