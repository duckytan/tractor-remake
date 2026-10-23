/**
 * 测试辅助：把「亮主 + 放弃反主」压成一步。
 *
 * 反主功能上线后，`declareTrump` 不再一定立刻进入出牌：
 * AI 可能反主，然后人类有机会反回来 —— 此时 phase 仍是 'contract'、counterPending=true。
 * 只关心「主已定好」的测试用这个函数，省得每处都写一遍 passCounter。
 *
 * 亮主校验上线后（首次亮主必须持该门级牌），调用方给的 trump 未必可选。
 * 这时退回清单里的第一项，保证「测试只关心定约完成」的语义不被花色合法性打断。
 *
 * v1.2.8：无将不再是「永远可选的兜底」—— 需要一对王（smallnest `Algorithm.cs:211`）。
 * 所以清单必须用**完整手牌**重算（`humanDeclareOptions`）：`newGame` 开动画时
 * `declareOptions` 还是空的，直接拿它当清单会误判「什么都没得选」。
 *
 * v1.2：亮主持牌校验改用「已揭示前缀」，而 `newGame` 默认开动画（revealed=0）。
 * 这些用例不关心发牌动画，直接把 revealed 补满 = 「假装已经发完」，
 * 否则会在 revealed=0 时被「这张级牌还没发到手」拒掉。
 */

import { humanDeclareOptions, reduce } from '@app/game'
import type { Card } from '@core'
import type { GameState } from '@app/state'
import type { Trump } from '@core'

export function declareAndPass(s: GameState, trump: Trump): GameState {
  // 发牌动画没跑完 ⇒ 先当作已发满（这些用例只关心定约结果）。
  // 「满」= 人类手牌全长：庄家 33 张、旁家 25 张（底牌不单独分离，见 core/deal.ts）。
  const humanTotal = (s.hands[0] as readonly Card[]).length
  const ready: GameState =
    s.phase === 'contract' && s.revealed < humanTotal ? { ...s, revealed: humanTotal } : s

  const firstDeclare = ready.phase === 'contract' && ready.usedTrumps.length === 0
  const opts = humanDeclareOptions(ready)
  const wanted: Trump = firstDeclare && !opts.includes(trump) ? (opts[0] ?? 'NT') : trump

  let cur = reduce(ready, { type: 'declareTrump', trump: wanted })
  // 反主最多换 5 次主，循环上界给 6 足够
  for (let i = 0; i < 6 && cur.phase === 'contract' && cur.counterPending; i++) {
    cur = reduce(cur, { type: 'passCounter' })
  }
  return cur
}
