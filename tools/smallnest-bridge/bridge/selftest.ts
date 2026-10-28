/**
 * 映射自检：smallnest 的牌 id ↔ 本项目的 value。
 * 跑法：`npx vite-node tools/smallnest-bridge/bridge/selftest.ts`
 *
 * 这张表是整个桥的地基 —— 映射错一位，所有牌都会被 `TractorRules` 判非法，
 * 插件当场被踢（docs/42 F1）。所以先把它钉死。
 */

import {
  ourValueToTheirId,
  parseTheirCards,
  theirIdToValue,
  theirSuitToTrump,
  trickOrder,
} from './smallnestMap'

let fail = 0
const eq = (label: string, got: unknown, want: unknown): void => {
  const g = JSON.stringify(got)
  const w = JSON.stringify(want)
  const ok = g === w
  if (!ok) fail++
  console.log(`${ok ? '  OK  ' : ' FAIL '} ${label}  got=${g}${ok ? '' : ` want=${w}`}`)
}

/* 1. 花色块 → 我们的 value（♥=1 ♠=0 ♦=3 ♣=2，rank 0='2'） */
eq('他们的 0（♥2）→ 我们的 ♥2 = 13', theirIdToValue(0), 13)
eq('他们的 12（♥A）→ ♥A = 25', theirIdToValue(12), 25)
eq('他们的 13（♠2）→ ♠2 = 0', theirIdToValue(13), 0)
eq('他们的 25（♠A）→ ♠A = 12', theirIdToValue(25), 12)
eq('他们的 26（♦2）→ ♦2 = 39', theirIdToValue(26), 39)
eq('他们的 38（♦A）→ ♦A = 51', theirIdToValue(38), 51)
eq('他们的 39（♣2）→ ♣2 = 26', theirIdToValue(39), 26)
eq('他们的 51（♣A）→ ♣A = 38', theirIdToValue(51), 38)
eq('他们的 52（小王）→ 52', theirIdToValue(52), 52)
eq('他们的 53（大王）→ 53', theirIdToValue(53), 53)

/* 2. 往返一致：0..53 全部 */
let rt = 0
for (let id = 0; id <= 53; id++) {
  if (ourValueToTheirId(theirIdToValue(id)) === id) rt++
}
eq('往返映射 54/54 全等', rt, 54)

/* 3. 花色参数 → trump（1♥ 2♠ 3♦ 4♣ 5无主） */
eq('suit 1 → trump ♥(1)', theirSuitToTrump(1), 1)
eq('suit 2 → trump ♠(0)', theirSuitToTrump(2), 0)
eq('suit 3 → trump ♦(3)', theirSuitToTrump(3), 3)
eq('suit 4 → trump ♣(2)', theirSuitToTrump(4), 2)
eq('suit 5 → NT', theirSuitToTrump(5), 'NT')

/* 4. 同一点数两张（两副牌）：smallnest 用重复 id，我们必须给出不同的 our id */
const pair = parseTheirCards('3,3,')
eq('"3,3," → 两张', pair.length, 2)
eq('两张同 value', pair[0]!.value, pair[1]!.value)
eq('两张不同 id（区分两副牌）', pair[0]!.id !== pair[1]!.id, true)
eq('尾逗号/空串不产生空牌', parseTheirCards('3,,4,').length, 2)

/* 5. 本墩出牌顺序：从首家开始按座位轮转 */
const lead = trickOrder(3, ['12,', '', '5,', '7,'])
eq('首家=3（座位 2）→ 顺序 2,3,0', lead.map((x) => x.seat), [2, 3, 0])
eq('首批是座位 2 的那张', lead[0]!.cards[0]!.value, theirIdToValue(5))

console.log(fail === 0 ? '\n映射自检通过 ✅' : `\n映射自检失败 ${fail} 项 ❌`)
if (fail > 0) process.exit(1)
