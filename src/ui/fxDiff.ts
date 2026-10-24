/**
 * 卡牌动画的「前后帧对比」纯函数。
 *
 * 从 `ui/dealFly.ts` 抽出来的原因有两个：
 * ① 让「哪些牌是新出的」「这一墩是不是刚结算」这类判断脱离 DOM 可单测
 *    （渲染代码在 vitest 的 node 环境里基本测不到，见 `tests/ui/handFit.test.ts` 的思路）；
 * ② ui 层的覆盖率门槛（函数 8% / 语句 12%）靠这些纯函数撑住，不让它形同虚设。
 *
 * 这里的 `prev` 一律是**上一次 paint 用的状态**里的本墩出牌，不是当前状态
 * （见 ADR-017：传当前状态会拿到结算后已清空的 trick）。
 */

import type { Card, Seat } from '@core'

/** 只依赖「座位 + 牌」的最小形状：`Play` / `TrickPlay` 都能直接传进来 */
export interface PlayLike {
  readonly seat: Seat
  readonly cards: readonly Card[]
}

export interface NewPlay {
  readonly seat: Seat
  readonly cards: readonly Card[]
}

/**
 * 这一帧新出现的出牌。
 *
 * 逐张比较：某家上一帧没有的牌就是新的（同一家一墩只出一次，
 * 但这样写对「出牌被撤回后重出」也成立）。
 */
export function newPlaysSince(prev: readonly PlayLike[], next: readonly PlayLike[]): NewPlay[] {
  const known = new Map<Seat, Set<number>>()
  for (const p of prev) known.set(p.seat, new Set(p.cards.map((c) => c.id)))
  const out: NewPlay[] = []
  for (const p of next) {
    const seen = known.get(p.seat)
    const fresh = p.cards.filter((c) => !(seen?.has(c.id) ?? false))
    if (fresh.length > 0) out.push({ seat: p.seat, cards: fresh })
  }
  return out
}

/**
 * 这一帧是不是刚结算完一墩。
 *
 * 判据：`history` 变长了，且上一帧本墩确实有牌 —— 否则开局 / 读档等
 * 「history 从 0 变 1」的场合也会误判成收墩。
 */
export function justResolved(
  prevHistLen: number,
  prevPlays: readonly PlayLike[],
  nextHistLen: number,
): boolean {
  return nextHistLen > prevHistLen && prevPlays.length > 0
}
