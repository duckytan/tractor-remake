/**
 * 反主 / 加固判定（纯函数）
 *
 * 对齐原版 `FUN_004163A2`（规则书 §3.3）：
 *   ① 必须持有「新花色的级牌」
 *   ② 打王级（强制无将）时主牌固定，不可被花色覆盖（§3.5）
 *   ③ 不能反成当前同一个主
 *   ④ 同队反主需开「允许自反」
 *   ⑤ 主动亮无将（非打王级）默认不可被花色反，需开「允许反无将」
 *
 * ── ⑤ 与 ② 的区别（容易搞混，务必分清）───────────────────────────
 * 两条都出现在「当前主是无将」的场合，但语义完全不同：
 *   - ② 管的是**打王级**：`forcedNT` 为真 ⇒ 主牌由级牌强制锁定，
 *     开关怎么开都反不了（规则书 §3.5「不可被花色覆盖」）；
 *   - ⑤ 管的是**主动亮无将**：有人主动选了无将 ⇒ 默认也反不了，
 *     但开 `allowCounterNT` 后可以（原版 `engine[0x8c]` 默认 0 = 关）。
 * 实现上 ② 在前、⑤ 在后：先被 `forcedNT` 硬挡掉，剩下的才是「主动无将」，
 * 这样开关就不可能绕过打王级的锁定。
 *
 * 另外用 `usedTrumps` 记录本局已用过的定主，保证同一门花色不会被反复来回反（必然终止）。
 *
 * ── v1.2 张数阶梯 ────────────────────────────────────────────────
 * 反主必须**比当前定主投入更多张级牌**：
 *   首次亮主 = 1 张 → 反主需 2 张 → 再反需 3 张（不可达）
 *
 * **张数上限推论（写死在实现里，UI 不许出现第三级）**：
 * 2 副牌每门级牌**只有 2 张** ⇒ `trumpCount` 只能取 `1` 或 `2`。
 * `counterNeed(2) = 3` **永远不可达** ⇒ 实际只有两级：1 张 → 2 张 → 锁死。
 * 加固（`canGuard`）就是「抬门槛」这条通用规则的实例：
 * 把张数从 1 抬到 2 ⇒ 门槛 2 → 3 ⇒ 数值上等价于锁死。
 */

import { RANKS_PER_SUIT, levelRankToRankIndex } from './cards'
import { teamOf } from './settle'
import type { Card, RuleContext, Seat, Trump } from './types'

export interface CanCounterOptions {
  /** 反主者的手牌 */
  readonly hand: readonly Card[]
  readonly ctx: RuleContext
  /** 当前主 */
  readonly currentTrump: Trump
  /** 想反成的主 */
  readonly newTrump: Trump
  /** 反主者与当前定主人是否同队（决定「允许自反」是否生效） */
  readonly sameTeamAsDeclarer: boolean
  /** 本局已用过的定主（含首次亮主） */
  readonly usedTrumps: readonly Trump[]
  /**
   * 当前定主已投入的张数。
   *
   * 缺省 `0` ⇒ 门槛 `counterNeed(0) = 1` ⇒ **等价于旧语义「持 1 张即可反」**，
   * 因此所有既有调用点（尚未传张数的 app 层 / 既有用例）行为不变。
   */
  readonly currentCount?: number
}

/**
 * 手里某门级牌的张数（0..2）。
 *
 * 无将 / 打王级没有「级牌」可依 ⇒ 恒为 0（与原版算式 `0x10 * 13 + lv` 永不命中等价）。
 */
export function levelCardCount(o: {
  readonly hand: readonly Card[]
  readonly ctx: RuleContext
  readonly trump: Trump
}): number {
  const { hand, ctx, trump } = o
  if (trump === 'NT') return 0
  const lvRank = levelRankToRankIndex(ctx.levelRank)
  if (lvRank === null) return 0
  const levelValue = trump * RANKS_PER_SUIT + lvRank
  let n = 0
  for (const c of hand) if (c.value === levelValue) n += 1
  return n
}

/**
 * 反主 / 加固门槛：当前定主用了 `currentCount` 张，就要 `currentCount + 1` 张。
 *
 * 上限说明：每门级牌只有 2 张 ⇒ `counterNeed(2) = 3` 不可达（= 锁死）。
 */
export function counterNeed(currentCount: number): number {
  const n = Number.isFinite(currentCount) ? Math.floor(currentCount) : 0
  return Math.max(0, n) + 1
}

/** 反主能力判定。纯函数，不读写任何全局状态。 */
export function canCounter(o: CanCounterOptions): boolean {
  const { hand, ctx, currentTrump, newTrump, sameTeamAsDeclarer, usedTrumps } = o

  // ② 打王级强制无将：主牌固定，任何花色都覆盖不了它（§3.5「不可被花色覆盖」）
  if (ctx.forcedNT) return false

  // ③ 不能反成同一个主；同一门花色也不能被反第二次（保证终止）
  if (newTrump === currentTrump) return false
  if (usedTrumps.includes(newTrump)) return false

  // ④ 同队反主需开「允许自反」
  if (sameTeamAsDeclarer && !ctx.config.allowSelfCounter) return false

  // ⑤ 主动亮无将（非打王级）：默认不可被花色反，需开「允许反无将」。
  //    打王级已在 ② 被挡掉，所以走到这里的 `currentTrump === 'NT'` 一定是主动无将。
  //    默认值 false ⇒ 与原版 `engine[0x8c]` 默认 0 一致（见 CHANGELOG v1.2.2 / KN-6）。
  if (currentTrump === 'NT' && !ctx.config.allowCounterNT) return false

  // 反成无将：无将没有「级牌」可依（原版算式 `0x10 * 13 + lv` 永不命中）⇒ 不允许
  if (newTrump === 'NT') return false

  // ① 必须持有新花色的级牌，且张数达到门槛（缺省 0 ⇒ 门槛 1 ⇒ 旧语义）
  if (levelRankToRankIndex(ctx.levelRank) === null) return false
  const need = counterNeed(o.currentCount ?? 0)
  return levelCardCount({ hand, ctx, trump: newTrump }) >= need
}

export interface CanGuardOptions {
  /** 加固者的手牌（定主人的队友） */
  readonly hand: readonly Card[]
  readonly ctx: RuleContext
  /** 当前主（加固必须同花色，所以只能用这一门的级牌） */
  readonly currentTrump: Trump
  /** 当前定主人 */
  readonly declarer: Seat
  /** 想加固的人 */
  readonly seat: Seat
  /** 当前定主已投入的张数 */
  readonly currentCount: number
}

/**
 * 加固：定主人的**队友**用「同花色的另一张级牌」再亮一次，把张数从 1 抬到 2。
 *
 * 语义：
 *   - 还没人亮主（`currentCount < 1`）时无主可加
 *   - 已经加固过（`currentCount >= 2`）⇒ 门槛 3 张已不可达，没有再加的余地
 *   - 必须持**当前主花色**的级牌 **≥ 1 张**
 *   - 只能队友加固（`teamOf` 相同），且要开 `allowPartnerGuard`
 *   - 定主人自己不能给自己加固（那不是加固，是重复声明）
 *   - 无将 / 打王级没有花色可加固
 *
 * **为什么门槛是 1 张、不是 `counterNeed(currentCount)`（= 2 张）**
 *
 * 2 副牌里**每门级牌总共只有 2 张**，而：
 *   ① 定主人一定是**持该门级牌**才亮得成的（`declareTrump` / `aiGrabPick` / `canCounter` 都要求持牌）
 *   ② ⇒ 定主人已占走 ≥1 张 ⇒ **队友手里最多只剩 1 张**
 *   ③ 若门槛取 2 张 ⇒ 2 > 1 ⇒ `canGuard` 对任何队友**恒为 false**（结构性不可达）
 *
 * 所以加固的本质是「队友手里**另一张**同花色级牌」，门槛必须是 1。
 * 加固后 `currentCount` 仍从 1 抬到 2 ⇒ 反主门槛升到 3 ⇒ 事实上锁死，
 * 与「加固只抬高门槛、不直接锁死」的语义一致。
 */
/**
 * 加固需要的同花色级牌张数。
 *
 * 定主人已占走该门 1 张 ⇒ 队友手里最多剩 1 张 ⇒ 门槛只能是 1。
 * 导出成常量是为了让 UI 的文案和规则判定用同一个来源（UI 不许自己算规则）。
 */
export const GUARD_NEED = 1

export function canGuard(o: CanGuardOptions): boolean {
  const { hand, ctx, currentTrump, declarer, seat, currentCount } = o

  // 打王级：主牌固定，没有任何「抬高门槛」的余地
  if (ctx.forcedNT) return false
  if (!ctx.config.allowPartnerGuard) return false

  // 无将没有花色级牌可依
  if (currentTrump === 'NT') return false

  // 只能队友加固；定主人自己不算
  if (seat === declarer) return false
  if (teamOf(seat) !== teamOf(declarer)) return false

  // 还没人亮主 ⇒ 无主可加
  if (currentCount < 1) return false
  // 已加固过 ⇒ 门槛 3 张已不可达，再加没有意义
  if (currentCount >= 2) return false

  return levelCardCount({ hand, ctx, trump: currentTrump }) >= GUARD_NEED
}
