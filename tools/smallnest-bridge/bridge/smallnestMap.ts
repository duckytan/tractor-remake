/**
 * smallnest id ↔ 本项目牌值 的映射（离线工具，不进运行时）
 *
 * 依据 `reference/smallnest-Tractor/Tractor.net/CurrentPoker.cs` 的 `getAllCards()`：
 *   · id 空间 0..53：0-12 红心 / 13-25 黑桃 / 26-38 方片 / 39-51 梅花 / 52 小王 / 53 大王
 *   · 每个 id 在一副牌里唯一；**两副牌时同一 id 出现两次**（`hearts[i]==2` → 输出 `i,i`）
 *   · 花色参数 `suit`：1 红心 / 2 黑桃 / 3 方片 / 4 梅花 / 5 无主
 *
 * 本项目编码（见 docs/07）：
 *   · value = suit*13 + rank，suit 0=♠ 1=♥ 2=♣ 3=♦；rank 0='2' … 12='A'
 *   · 小王 52 / 大王 53；**id = value*2 + copy**（copy 0/1 区分两副牌）
 *
 * 所以两边并不是同一个 id 空间，必须显式映射；且「两张同牌」在 smallnest 侧是
 * **重复 id**，在我们要还原成 value + copy 序号。
 */

import type { Card } from '@core'

/** smallnest 花色块 → 本项目 suit */
const THEIR_SUIT_TO_OURS = [1, 0, 3, 2] as const // ♥ ♠ ♦ ♣ → ♥ ♠ ♦ ♣
/** smallnest 的 suit 参数（1..5）→ 本项目 trump */
export const theirSuitToTrump = (suit: number): 0 | 1 | 2 | 3 | 'NT' => {
  if (suit === 1) return 1 // 红心
  if (suit === 2) return 0 // 黑桃
  if (suit === 3) return 3 // 方片
  if (suit === 4) return 2 // 梅花
  return 'NT'
}
/** 本项目 suit → smallnest 花色块（0-3），用于回写 */
const OUR_SUIT_TO_BLOCK: readonly number[] = [1, 0, 3, 2] // ♠→黑桃块 ♥→红心块 ♣→梅花块 ♦→方片块

/**
 * smallnest 的一手牌字符串（`"3,3,17,52,"`）→ 本项目 `Card[]`。
 *
 * 重复 id 按出现顺序给 `copy = 0,1`，所以 `id = value*2 + copy` 在整局里唯一。
 * 返回的 `Card[]` 可直接喂给 `enumeratePlays` / `checkPlay`。
 */
export function parseTheirCards(s: string | null | undefined): Card[] {
  if (!s) return []
  const seen = new Map<number, number>() // theirId → 已出现次数
  const out: Card[] = []
  for (const part of s.split(',')) {
    const t = part.trim()
    if (t === '') continue
    const theirId = Number(t)
    if (!Number.isInteger(theirId) || theirId < 0 || theirId > 53) continue
    const copy = seen.get(theirId) ?? 0
    seen.set(theirId, copy + 1)
    const value = theirIdToValue(theirId)
    out.push({ id: value * 2 + Math.min(copy, 1), value })
  }
  return out
}

/** smallnest id → 本项目 value（0..53） */
export function theirIdToValue(theirId: number): number {
  if (theirId >= 52) return theirId // 52 小王 / 53 大王（两边一致）
  const block = Math.floor(theirId / 13) // 0 ♥ / 1 ♠ / 2 ♦ / 3 ♣
  const rank = theirId % 13 // 0='2' … 12='A'
  return (THEIR_SUIT_TO_OURS[block] as number) * 13 + rank
}

/** 本项目 value → smallnest id */
export function ourValueToTheirId(value: number): number {
  if (value >= 52) return value
  const suit = Math.floor(value / 13) as 0 | 1 | 2 | 3
  const rank = value % 13
  return (OUR_SUIT_TO_BLOCK[suit] as number) * 13 + rank
}

/** 本项目 `Card` → smallnest id（copy 忽略：smallnest 用重复 id 表示两副牌） */
export const ourCardToTheirId = (c: Card): number => ourValueToTheirId(c.value)

/**
 * 把 smallnest 的「本墩已出的牌」按座位拼成出牌顺序。
 *
 * @param firstSeat  首家（1 基）
 * @param perSeat    每家的牌串（下标 0..3 对应座位 1..4，可空）
 * @returns 按出牌先后排列的 [{ seat(0 基), cards }]
 */
export function trickOrder(
  firstSeat: number,
  perSeat: readonly (string | null | undefined)[],
): { seat: number; cards: Card[] }[] {
  const out: { seat: number; cards: Card[] }[] = []
  for (let k = 0; k < 4; k++) {
    const seat1 = ((firstSeat - 1 + k) % 4) + 1 // 1 基
    const cards = parseTheirCards(perSeat[seat1 - 1])
    if (cards.length > 0) out.push({ seat: seat1 - 1, cards })
  }
  return out
}
