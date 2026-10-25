/**
 * 把「前后两帧的游戏状态」翻译成声音事件 —— **纯函数，零副作用**。
 *
 * 这是音频接入游戏的唯一入口：`core` / `app` 一行都不用改，音频纯粹是观察者。
 * 采用与 `ui/fxDiff.ts` 完全相同的思路（ADR-017：`prev` 是**上一次 paint 用的状态**）。
 *
 * 只依赖结构类型，不 import `@app` —— 保持 `audio` 的依赖面干净、可单测。
 */

/* ============================================================
   最小结构类型（`GameState` 结构上满足它）
   ============================================================ */

export interface PlayLike {
  readonly seat: number
  readonly cards: readonly unknown[]
}

export interface SettleLike {
  readonly levels: number
  readonly dealerChanged: boolean
  readonly guardLevel?: unknown
  readonly gameOver: boolean
  readonly winnerTeam?: number
}

export interface AudioStateLike {
  readonly phase: 'contract' | 'bury' | 'play' | 'settle' | 'over'
  readonly revealed: number
  readonly round: number
  /** 发牌暂停（人类第一次摸到级牌时置 true） */
  readonly dealPrompt: boolean
  readonly trumpDeclarer: number | null
  readonly trumpCount: number
  readonly guardBy: number | null
  readonly usedTrumps: readonly unknown[]
  readonly trick: { readonly plays: readonly PlayLike[] }
  readonly tricksDone: number
  readonly defenderScore: number
  readonly history: readonly { readonly winner: number }[]
  readonly hands: readonly (readonly unknown[])[]
  readonly lastReject: { readonly reason: string } | null
  readonly replayAt: number | null
  readonly lastSettle: SettleLike | null
  readonly selected: readonly number[]
}

/** 我方 = 队 0 = 座位 0 / 2 */
const MY_TEAM_SEATS: readonly number[] = [0, 2]
const teamOf = (seat: number): number => seat % 2

/* ============================================================
   场景与紧张度（纯函数，供 music.ts 与 UI 共用）
   ============================================================ */

export type Scene = 'calm' | 'play' | 'settle' | 'overWin' | 'overLose' | 'replay'

/** 当前该用哪个场景 */
export function sceneOf(s: AudioStateLike): Scene {
  if (s.replayAt !== null) return 'replay'
  switch (s.phase) {
    case 'contract':
    case 'bury':
      return 'calm'
    case 'settle':
      return 'settle'
    case 'over': {
      const w = s.lastSettle?.winnerTeam
      return w === undefined ? 'overWin' : w === 0 ? 'overWin' : 'overLose'
    }
    default:
      return 'play'
  }
}

/** 四道得分悬崖：40 / 80 / 120 / 160 */
export const SCORE_CLIFFS: readonly number[] = [40, 80, 120, 160]

/**
 * 紧张度 0..1。不是离散开关，是连续值 —— 音乐靠它平滑地「绷紧」而不是硬切。
 *   闲家得分越过悬崖 → 台阶式抬升
 *   牌局接近尾声     → 缓慢爬升
 *   最后一墩         → 再顶一下
 */
export function tensionOf(s: AudioStateLike): number {
  if (s.phase !== 'play') return 0
  let t = 0
  const d = s.defenderScore
  if (d >= 160) t = 0.9
  else if (d >= 120) t = 0.8
  else if (d >= 80) t = 0.68
  else if (d >= 40) t = 0.42
  else t = (d / 40) * 0.3

  const remain = remainingCards(s)
  // 牌越少越紧（剩 5 张以内开始明显）
  if (remain <= 5) t = Math.max(t, 0.55 + (5 - remain) * 0.07)
  if (isLastTrick(s)) t = Math.max(t, 0.85)
  return Math.min(1, t)
}

/** 四家手牌里最少的那家还剩几张（对子/拖拉机一墩耗多张，墩数不固定） */
export function remainingCards(s: AudioStateLike): number {
  let m = Infinity
  for (const h of s.hands) m = Math.min(m, h.length)
  return Number.isFinite(m) ? m : 0
}

/** 最后一墩 = 这一墩打完后四家手牌全空。**不能按「第 25 墩」判定** */
export function isLastTrick(s: AudioStateLike): boolean {
  if (s.phase !== 'play') return false
  const min = remainingCards(s)
  return min > 0 && min <= 4
}

/* ============================================================
   声音事件
   ============================================================ */

export type SoundEvent =
  | { readonly type: 'deal' }
  | { readonly type: 'levelCard' }
  | { readonly type: 'declare' }
  | { readonly type: 'grab' }
  | { readonly type: 'counter' }
  | { readonly type: 'guard' }
  | { readonly type: 'noDeclare' }
  | { readonly type: 'buryStart' }
  | { readonly type: 'bury' }
  | { readonly type: 'buryReady' }
  | { readonly type: 'select' }
  | { readonly type: 'deselect' }
  | { readonly type: 'play'; readonly seat: number; readonly multi: boolean }
  | { readonly type: 'bump' }
  | { readonly type: 'illegal' }
  | { readonly type: 'win' }
  | { readonly type: 'lose' }
  | { readonly type: 'lastTrick' }
  | { readonly type: 'cliff' }
  | { readonly type: 'undo' }
  | { readonly type: 'hint' }
  | { readonly type: 'settleUp'; readonly n: number }
  | { readonly type: 'promote' }
  | { readonly type: 'guardStop' }
  | { readonly type: 'overWin' }
  | { readonly type: 'overLose' }
  | { readonly type: 'replayStep' }

/** 发牌 tick 降频：33 张 × 55ms 逐张响会像机关枪 ⇒ 每 4 张一次 */
const DEAL_TICK_EVERY = 4

/**
 * 对比前后两帧，产出这一帧该响的声音。
 *
 * 判定优先级（同一帧可能同时发生多件事，按「信息量大的先说」排序）：
 *   终局 > 结算 > 非法/压回 > 一墩结果 > 出牌 > 定主 > 埋底 > 选牌 > 发牌
 */
export function soundEventsOf(prev: AudioStateLike, next: AudioStateLike): SoundEvent[] {
  const out: SoundEvent[] = []
  const push = (e: SoundEvent): void => {
    out.push(e)
  }

  /* ---------- 终局 ---------- */
  if (prev.phase !== 'over' && next.phase === 'over') {
    const sc = sceneOf(next)
    push({ type: sc === 'overLose' ? 'overLose' : 'overWin' })
    return out
  }

  /* ---------- 结算 ----------
     注意：**不能在这里 return**。`play → settle` 是同一步转移 ——
     这一墩刚打完、同时本局结束。提前返回会把「最后一墩的赢墩/输墩 + lastTrick」
     整个吞掉，最后一墩就没有任何声音反馈了（这是真实存在过的 bug）。
     结算音先入列，后面的「一墩结果」照常追加。 */
  const enteringSettle = prev.phase !== 'settle' && next.phase === 'settle'
  if (enteringSettle) {
    const st = next.lastSettle
    if (st) {
      if (st.guardLevel !== undefined) push({ type: 'guardStop' })
      if (st.dealerChanged) push({ type: 'promote' })
      else push({ type: 'settleUp', n: Math.max(1, Math.min(3, st.levels)) })
    } else {
      push({ type: 'settleUp', n: 1 })
    }
  }

  /* ---------- 回放翻墩 ---------- */
  if (next.replayAt !== null && prev.replayAt !== next.replayAt) {
    push({ type: 'replayStep' })
  }

  /* ---------- 非法出牌 / 甩牌被压回 ---------- */
  // 新的 reject（换了 reason 或从无到有）
  if (next.lastReject && (!prev.lastReject || prev.lastReject.reason !== next.lastReject.reason)) {
    push({ type: 'illegal' })
  }
  // 出牌被规则压回：play 数没变，但手牌少了（甩牌只出了最小单位）
  const prevPlayCount = prev.trick.plays.length
  const nextPlayCount = next.trick.plays.length
  if (nextPlayCount === prevPlayCount && next.hands.length === prev.hands.length) {
    const lost = prev.hands.reduce<number>((acc, h, i) => acc + h.length - (next.hands[i]?.length ?? h.length), 0)
    if (lost > 0 && next.phase === 'play' && prev.phase === 'play') push({ type: 'bump' })
  }

  /* ---------- 一墩结果 ---------- */
  if (next.history.length > prev.history.length) {
    const rec = next.history[next.history.length - 1]
    if (rec) push({ type: teamOf(rec.winner) === 0 ? 'win' : 'lose' })
    // 得分越过悬崖
    if (crossedCliff(prev.defenderScore, next.defenderScore)) push({ type: 'cliff' })
    // 打完这一墩之后四家全空 ⇒ 这是最后一墩
    if (next.phase !== 'play' && next.hands.every((h) => h.length === 0)) push({ type: 'lastTrick' })
  }

  /* ---------- 出牌 ---------- */
  if (nextPlayCount > prevPlayCount) {
    const p = next.trick.plays[nextPlayCount - 1]
    if (p) {
      // 甩牌 = 这一手是多组（对子/连对混着出）。这里只看牌数够不够多，
      // 真正的「是否甩牌」由 UI 的 analysis 决定；音频只需要区分「重」与「轻」。
      const multi = p.cards.length >= 4
      push({ type: 'play', seat: p.seat, multi })
    }
    // 这一墩开始前若已是最后一墩，先响一下提示
    if (prevPlayCount === 0 && isLastTrick(next)) push({ type: 'lastTrick' })
  }

  /* ---------- 定主 ---------- */
  const declared = prev.trumpDeclarer === null && next.trumpDeclarer !== null
  const countered = next.usedTrumps.length > prev.usedTrumps.length && !declared
  const guarded = prev.guardBy === null && next.guardBy !== null
  if (guarded) push({ type: 'guard' })
  else if (countered) push({ type: 'counter' })
  else if (declared) {
    // 第一局首次亮主 ⇒ 抢庄
    const grab = next.round === 1 && next.phase !== 'play'
    push({ type: grab ? 'grab' : 'declare' })
  }

  /* ---------- 埋底 ---------- */
  if (prev.phase === 'contract' && next.phase === 'bury') push({ type: 'buryStart' })
  if (prev.phase === 'bury' && next.phase === 'play') push({ type: 'bury' })

  /* ---------- 选牌 ---------- */
  if (next.phase === 'bury' && next.selected.length > prev.selected.length) {
    // 埋底选够 8 张时给一个「可以确认了」的提示
    if (next.selected.length === 8) push({ type: 'buryReady' })
    else push({ type: 'select' })
  } else if (next.selected.length > prev.selected.length) {
    push({ type: 'select' })
  } else if (next.selected.length < prev.selected.length) {
    // 出牌后清空 selected 属于正常流程，不响
    if (next.trick.plays.length === prev.trick.plays.length) push({ type: 'deselect' })
  }

  /* ---------- 悔牌（出牌数减少） ---------- */
  if (nextPlayCount < prevPlayCount) push({ type: 'undo' })

  /* ---------- 发牌 ---------- */
  if (next.revealed > prev.revealed && next.phase === 'contract') {
    // 每 4 张一次
    if (Math.floor(next.revealed / DEAL_TICK_EVERY) > Math.floor(prev.revealed / DEAL_TICK_EVERY)) {
      push({ type: 'deal' })
    }
  }
  // 摸到级牌：发牌暂停提示打开的那一刻
  if (!prev.dealPrompt && next.dealPrompt) push({ type: 'levelCard' })

  return out
}

/** 闲家得分是否跨过了某道悬崖（40/80/120/160） */
export function crossedCliff(before: number, after: number): boolean {
  for (const c of SCORE_CLIFFS) if (before < c && after >= c) return true
  return false
}

/** 我方是不是赢家（UI 展示用） */
export function isMyTeamWin(winnerTeam: number | undefined): boolean {
  return winnerTeam === 0 || winnerTeam === undefined ? true : false
}

export { MY_TEAM_SEATS }
