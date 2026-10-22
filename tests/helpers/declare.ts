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
 */

import { reduce } from '@app/game'
import type { GameState } from '@app/state'
import type { Trump } from '@core'

export function declareAndPass(s: GameState, trump: Trump): GameState {
  const firstDeclare = s.phase === 'contract' && s.usedTrumps.length === 0
  const wanted: Trump =
    firstDeclare && !s.declareOptions.includes(trump) ? (s.declareOptions[0] ?? 'NT') : trump

  let cur = reduce(s, { type: 'declareTrump', trump: wanted })
  // 反主最多换 5 次主，循环上界给 6 足够
  for (let i = 0; i < 6 && cur.phase === 'contract' && cur.counterPending; i++) {
    cur = reduce(cur, { type: 'passCounter' })
  }
  return cur
}
