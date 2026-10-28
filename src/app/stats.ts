/**
 * 战绩累计（v1.3.41）
 *
 * 为什么需要它：项目此前所有"AI 强不强"的结论都是**内部标定**（同档对打、座位互换配对），
 * 分母只有我们自己。要判断"AI 打不打得过真人"，只能靠真人对局累计 —— 这是唯一的外部锚。
 * 本文件只做最低限度的事：把每局结果攒起来，让玩家自己能看见胜率。
 *
 * 存储与 `persist.ts` 的存档分开（`tractor.stats.v1`）：
 *   · 战绩是**跨局累积**，不属于任何一局的 `GameState`
 *   · 存档损坏不能连带战绩一起丢，反之亦然
 *
 * 一局算「我方赢」的判据（只看庄位变化，不依赖升级数 —— 闲家上台也算赢）：
 *   · 我方是庄家队 ⇒ 没被换庄（`!dealerChanged`）就是守住
 *   · 我方是闲家队 ⇒ 换庄（`dealerChanged`）就是上台
 */

import { teamOf } from '@core'
import type { Seat } from '@core'
import { HUMAN_SEAT } from './state'
import type { GameState } from './state'

const KEY = 'tractor.stats.v1'
/** 只保留最近这么多局，避免 localStorage 无限增长 */
const KEEP = 200

export interface RoundStat {
  /** 幂等键：`seed-round`（每局唯一，重进结算页不会重复记） */
  readonly key: string
  readonly ts: number
  readonly round: number
  readonly dealer: Seat
  readonly myTeam: number
  readonly defenderScore: number
  readonly win: boolean
  /** 我方本局升了几级（闲家上台时是 0） */
  readonly levelDelta: number
}

export interface Stats {
  readonly rounds: readonly RoundStat[]
}

const EMPTY: Stats = { rounds: [] }

/** 模块级缓存：避免每次 render 都读 localStorage（render 里只读缓存，不做 IO） */
let cache: Stats = EMPTY

function readStorage(): Stats {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return EMPTY
    const o = JSON.parse(raw) as { rounds?: unknown }
    if (!Array.isArray(o.rounds)) return EMPTY
    // 逐条校验：坏数据整条丢弃，不让一条脏记录拖垮面板
    const rounds: RoundStat[] = []
    for (const r of o.rounds) {
      const it = r as Partial<RoundStat>
      if (
        typeof it.key === 'string' &&
        typeof it.ts === 'number' &&
        typeof it.defenderScore === 'number' &&
        typeof it.win === 'boolean'
      ) {
        rounds.push({
          key: it.key,
          ts: it.ts,
          round: typeof it.round === 'number' ? it.round : 0,
          dealer: (typeof it.dealer === 'number' ? it.dealer : 0) as Seat,
          myTeam: typeof it.myTeam === 'number' ? it.myTeam : 0,
          defenderScore: it.defenderScore,
          win: it.win,
          levelDelta: typeof it.levelDelta === 'number' ? it.levelDelta : 0,
        })
      }
    }
    return { rounds }
  } catch {
    return EMPTY
  }
}

/** 启动时读一次（main.ts 调），之后 render 只读缓存 */
export function initStats(): void {
  cache = readStorage()
}

export function getStats(): Stats {
  return cache
}

/**
 * 记录一局的结算结果（幂等：同一 `seed-round` 只记一次）。
 *
 * 只在 `phase` 刚进入 `settle` / `over` 时调用（main.ts 的 `step` 里判断前后 phase）。
 */
export function recordRound(s: GameState): void {
  const r = s.lastSettle
  if (!r) return
  const key = `${s.seed}-${s.round}`
  if (cache.rounds.some((x) => x.key === key)) return

  const myTeam = teamOf(HUMAN_SEAT)
  const wasDealerSide = teamOf(s.dealer) === myTeam
  const win = wasDealerSide ? !r.dealerChanged : r.dealerChanged
  const levelDelta = wasDealerSide && !r.dealerChanged ? r.actualLevels : 0

  const next: RoundStat = {
    key,
    ts: Date.now(),
    round: s.round,
    dealer: s.dealer,
    myTeam,
    defenderScore: r.defenderScore,
    win,
    levelDelta,
  }
  const rounds = [...cache.rounds, next].slice(-KEEP)
  cache = { rounds }
  try {
    localStorage.setItem(KEY, JSON.stringify(cache))
  } catch {
    /* 隐私模式写不进去：内存里仍然有效，不报错 */
  }
}

export interface StatsSummary {
  readonly total: number
  readonly wins: number
  readonly losses: number
  /** 0..1 */
  readonly rate: number
  /** 场均闲家得分（越低对我方越有利，但要看我们是庄还是闲，所以只作参考） */
  readonly avgScore: number
  /** 最近 N 局胜率，用来观察"是不是在变好" */
  readonly recent: { readonly n: number; readonly wins: number }
}

/** 累计战绩；没有记录返回 null（面板据此不显示这一行） */
export function statsSummary(recentN = 10): StatsSummary | null {
  const rounds = cache.rounds
  if (rounds.length === 0) return null
  let wins = 0
  let score = 0
  for (const r of rounds) {
    if (r.win) wins++
    score += r.defenderScore
  }
  const recent = rounds.slice(-recentN)
  return {
    total: rounds.length,
    wins,
    losses: rounds.length - wins,
    rate: wins / rounds.length,
    avgScore: Math.round(score / rounds.length),
    recent: { n: recent.length, wins: recent.filter((r) => r.win).length },
  }
}

/** 面板文案（一句话，塞进结算页） */
export function statsLine(): string | null {
  const s = statsSummary()
  if (s === null) return null
  const pct = (x: number): string => `${Math.round(x * 100)}%`
  return (
    `累计 ${s.total} 局 · 我方 ${s.wins} 胜 ${s.losses} 负（${pct(s.rate)}）` +
    ` · 近 ${s.recent.n} 局 ${s.recent.wins} 胜` +
    ` · 场均闲家 ${s.avgScore} 分`
  )
}

/** 清空战绩（测试 / 玩家手动重置用） */
export function clearStats(): void {
  cache = EMPTY
  try {
    localStorage.removeItem(KEY)
  } catch {
    /* 忽略 */
  }
}
