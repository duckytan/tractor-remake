/**
 * 悔牌（undo）—— 快照栈
 *
 * 规则依据：docs/14-需求增量设计-v1.2.md §2.3
 *
 * 语义：
 *   - 只在出牌阶段可用；撤销到「当前这一墩开始前」，
 *     如果当前墩还没出牌（刚结算完），就等于撤销到「上一墩开始前」。
 *   - 四家的牌一起回退（快照是整个 GameState）。
 *
 * **为什么栈不进 GameState**：`GameState` 要 JSON 序列化进存档，
 * 把 20 份历史状态塞进去会让存档膨胀，而且「悔牌历史」不该跨会话恢复。
 * 所以栈放在 main.ts 的模块作用域，`GameState` 保持 immutable ⇒ 快照只存引用。
 */

import type { GameState } from './state'

/** 最多能悔多少墩 */
export const UNDO_LIMIT = 20

export interface UndoStore {
  readonly frames: readonly GameState[]
}

export const emptyUndo = (): UndoStore => ({ frames: [] })

/** 压栈（超出上限丢最旧的） */
export function pushUndo(u: UndoStore, s: GameState): UndoStore {
  const frames = [...u.frames, s]
  return { frames: frames.length > UNDO_LIMIT ? frames.slice(frames.length - UNDO_LIMIT) : frames }
}

/** 弹栈。栈空时 target 为 null，原栈原样返回 */
export function popUndo(u: UndoStore): { store: UndoStore; target: GameState | null } {
  if (u.frames.length === 0) return { store: u, target: null }
  const target = u.frames[u.frames.length - 1] as GameState
  return { store: { frames: u.frames.slice(0, -1) }, target }
}

/**
 * 什么时候压栈：**一墩的第一张牌打出之前**。
 *
 * 这样栈顶永远等于「本墩开始前」：
 *   - 当前墩已有出牌 ⇒ 恢复到栈顶 = 本墩开始前；
 *   - 当前墩还没出牌（上一墩刚结算）⇒ 栈顶是上一墩的开始，恢复它 = 退回上一墩。
 * 比「每次墩开始时压栈」更省事，也不会出现「按了没反应」的空撤销。
 */
export function shouldPush(prev: GameState, next: GameState): boolean {
  return next.phase === 'play' && prev.trick.plays.length === 0 && next.trick.plays.length === 1
}

/** 现在能不能悔牌（出牌阶段 + 栈非空） */
export function canUndo(s: GameState, u: UndoStore): boolean {
  return s.phase === 'play' && u.frames.length > 0
}
