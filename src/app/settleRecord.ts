/**
 * 结算落库的唯一入口（v1.3.50）
 *
 * 为什么单独抽一个文件：结算要写**两处**（`stats` 战绩 + `roundLog` 复盘），
 * 原先这两次调用散落在 `main.ts` 的 `step()` 里、由「`phase` 刚跳到 settle/over」触发。
 * 那个触发条件漏掉了一整类路径 —— **刷新**：
 *
 *   · `saveState()` 每次状态变化都写存档，结算页当然也在存档里；
 *   · `loadStateDetailed()` 只拒绝 `contract` 阶段，`settle` / `over` 是**允许恢复**的；
 *   · 恢复出来的 `phase` 已经是 `settle`，`prev.phase !== 'settle'` 恒为假 ⇒
 *     `step()` 里那两条 `recordRound` / `finishRound` **一次都不会执行**。
 *
 * 后果不是「少一行日志」，而是：玩家在结算页刷新 / 关标签页 / 手机切后台被回收，
 * 这一局就**从未进过战绩与复盘导出**。而 `docs/44` §4 收集真人对局基线的做法正是
 * 「连打 20~30 局后导出」—— 结算页恰好是最常见的离开时机，丢的往往就是刚打完的那局。
 *
 * 修法：把「结算落库」收成一个入口，启动时对「落在结算页的存档」补记一次。
 * 两条记录本来就按 `(seed, round)` 幂等（`stats.ts` 的 `key`、`roundLog.ts` 的
 * `seed+round` 判重），所以补记与正常路径重复触发都安全 —— 幂等键当初就是为这个留的，
 * 只是此前没有任何路径在刷新后**再触发**过。
 */

import type { GameState } from './state'
import { recordRound } from './stats'
import { finishRound } from './roundLog'

/** 结算落库（战绩 + 复盘）。幂等：同一 `seed-round` 重复调用只记一条。 */
export function recordSettled(s: GameState): void {
  recordRound(s)
  finishRound(s)
}

/**
 * 启动时补记：存档落在结算页 ⇒ 这一局还没落库（见文件头）。
 *
 * @returns 是否真的补记（没有结算数据 / 不在结算页时返回 false，调用方可据此打点）
 */
export function backfillSettled(s: GameState): boolean {
  if (s.phase !== 'settle' && s.phase !== 'over') return false
  // 没有结算结果就没什么可记的（正常存档不会这样，防御畸形存档）
  if (!s.lastSettle) return false
  recordSettled(s)
  return true
}
