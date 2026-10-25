/**
 * 音效表与触发。
 *
 * 三档：
 *   P0 规则反馈（甩牌被压回 / 非法出牌 / 结算级数 / 上台 / 必打截断 / 终局胜负）
 *   P1 过程提示（摸到级牌 / 选够 8 张 / 最后一墩 / 得分悬崖 / 悔牌）
 *   基础操作（发牌 / 选牌 / 出牌 / 赢墩 / 输墩 / 亮主 / 反主 / 加固 / 埋底 / 按钮）
 *
 * 设计约定：
 *   · 音高跟当前调（`host.pitch`），只有**非法出牌**故意固定音高 —— 它不该像音乐
 *   · 失败音必须短（≤0.16s），长了会拖节奏
 *   · 撤回类动作用**反向扫频**（出牌 700→3200，悔牌 3600→500）
 *   · 数量用**音数**表达（升级 3 级就响 3 个音）
 */

import type { Seat } from '@core'
import { noiseHit, ping, sweep } from './synth'
import type { AudioEnv } from './synth'
import { SCALE } from './scenes'

/** 音效发声所需的外部环境（由 index.ts 注入） */
export interface SfxHost {
  readonly env: AudioEnv
  /** 中心出口（sfxBus） */
  readonly out: AudioNode
  /** 按座位取出口（内部缓存 StereoPanner） */
  seatOut(seat: Seat | undefined): AudioNode
  /** 音效音高 = C 大调高两个八度 + 音级 + 张力降调 + 段位移调 */
  pitch(name: string, degree?: number): number
}

export interface SfxOptions {
  readonly force?: boolean
  readonly seat?: Seat
  /** 参数化音效的数值（如 settleUp 的升级级数） */
  readonly n?: number
}

interface SfxDef {
  readonly label: string
  readonly play: (host: SfxHost, when: number, o: SfxOptions) => void
}

/* ============================================================
   音效表
   ============================================================ */

export const SFX: Record<string, SfxDef> = {
  /* ---------------- 发牌阶段 ---------------- */

  /** 发牌 tick。实际 33 张 × 55ms，逐张响会像机关枪 ⇒ 调用方必须每 4 张一次 */
  deal: {
    label: '发牌 tick',
    play: (h, w) => noiseHit(h.env, h.out, w, 3000, 1.2, 0.02, 0.14),
  },

  /** 摸到级牌（发牌暂停问你要不要亮主）：比选牌亮一档 */
  levelCard: {
    label: '摸到级牌',
    play: (h, w) => {
      ping(h.env, h.out, w, h.pitch('levelCard', 5), 0.5, 0.12, 1, 'sine')
      ping(h.env, h.out, w + 0.06, h.pitch('levelCard', 4) + 12, 0.35, 0.06, 1, 'sine')
    },
  },

  declare: {
    label: '亮主',
    play: (h, w) => {
      for (const [i, d] of [0, 2, 4].entries()) ping(h.env, h.out, w + i * 0.06, h.pitch('declare', d), 0.24, 0.11, 0.9)
    },
  },

  /** 抢庄：亮主 + 上行三音（"抢到了"）。第一局谁先亮谁坐庄，比普通亮主更重 */
  grab: {
    label: '抢庄',
    play: (h, w) => {
      for (const [i, d] of [0, 2, 4].entries()) ping(h.env, h.out, w + i * 0.06, h.pitch('grab', d), 0.24, 0.11, 0.9)
      for (const [i, d] of [2, 3, 5].entries()) ping(h.env, h.out, w + 0.22 + i * 0.07, h.pitch('grab', d) + 2, 0.3, 0.12, 1)
    },
  },

  counter: {
    label: '反主',
    play: (h, w) => {
      for (const [i, d] of [0, 1, 2, 4].entries()) ping(h.env, h.out, w + i * 0.055, h.pitch('counter', d) + 1, 0.28, 0.12, 1)
      noiseHit(h.env, h.out, w + 0.2, 6000, 2, 0.12, 0.06)
    },
  },

  guard: {
    label: '加固',
    play: (h, w) => {
      noiseHit(h.env, h.out, w, 5200, 3, 0.06, 0.16)
      ping(h.env, h.out, w, 60, 0.18, 0.12, 0.2, 'sine')
      noiseHit(h.env, h.out, w + 0.01, 900, 1, 0.1, 0.08)
    },
  },

  /** 无人亮主流局：一个「空转」的低音 */
  noDeclare: {
    label: '无人亮主流局',
    play: (h, w) => {
      ping(h.env, h.out, w, 43, 0.5, 0.12, 0.1, 'sine')
      ping(h.env, h.out, w + 0.3, 41, 0.6, 0.1, 0.08, 'sine')
    },
  },

  /* ---------------- 埋底阶段 ---------------- */

  buryStart: {
    label: '进入埋底',
    play: (h, w) => {
      ping(h.env, h.out, w, 48, 0.4, 0.13, 0.15, 'sine')
      ping(h.env, h.out, w + 0.16, h.pitch('buryStart', 2), 0.3, 0.09, 0.5)
    },
  },

  bury: {
    label: '埋底',
    play: (h, w) => {
      ping(h.env, h.out, w, 48, 0.18, 0.16, 0.15, 'sine')
      noiseHit(h.env, h.out, w, 500, 0.8, 0.12, 0.08, 'lowpass')
    },
  },

  /** 选够 8 张（可以按确认了）：一个干脆的「嗒」 */
  buryReady: {
    label: '选够 8 张',
    play: (h, w) => {
      ping(h.env, h.out, w, h.pitch('buryReady', 2), 0.1, 0.11, 0.7)
      noiseHit(h.env, h.out, w, 2600, 2.2, 0.04, 0.09)
    },
  },

  /* ---------------- 出牌阶段 ---------------- */

  select: { label: '选牌', play: (h, w) => ping(h.env, h.out, w, h.pitch('select'), 0.03, 0.1, 0.5, 'square') },
  deselect: { label: '取消选牌', play: (h, w) => ping(h.env, h.out, w, h.pitch('deselect', 1), 0.03, 0.09, 0.4, 'square') },

  /** 我方出牌：噪声扫频 700→3200Hz（与 280ms 飞行动画同步）+ 根音 */
  play: {
    label: '我方出牌',
    play: (h, w) => {
      sweep(h.env, h.out, w, 700, 3200, 0.26, 0.2, 1.1)
      ping(h.env, h.out, w + 0.01, h.pitch('play', 0), 0.12, 0.07, 0.4)
    },
  },

  /** AI 出牌：更轻更短、按座位声像 —— 一墩四家连出才不会糊成一团 */
  playAi: {
    label: 'AI 出牌',
    play: (h, w, o) => {
      const out = h.seatOut(o.seat)
      sweep(h.env, out, w, 800, 2600, 0.2, 0.13, 1.1)
      ping(h.env, out, w + 0.01, h.pitch('playAi', 2) - 12, 0.1, 0.05, 0.3)
    },
  },

  /** 甩牌（多组同时出）：出牌 + 一层低八度厚度 */
  playMulti: {
    label: '甩牌',
    play: (h, w) => {
      sweep(h.env, h.out, w, 600, 3400, 0.3, 0.22, 1.0)
      ping(h.env, h.out, w + 0.01, h.pitch('playMulti', 0), 0.16, 0.1, 0.5)
      ping(h.env, h.out, w + 0.02, h.pitch('playMulti', 0) - 12, 0.22, 0.09, 0.2, 'sine')
    },
  },

  /** ★P0 甩牌被压回：下行小二度 = 挫败感，但不能长（0.16s），否则拖慢节奏 */
  bump: {
    label: '甩牌被压回',
    play: (h, w) => {
      const base = h.pitch('bump', 2)
      ping(h.env, h.out, w, base, 0.1, 0.13, 0.35)
      ping(h.env, h.out, w + 0.09, base - 1, 0.16, 0.15, 0.2)
      noiseHit(h.env, h.out, w, 900, 1.6, 0.1, 0.1, 'lowpass')
    },
  },

  /** ★P0 非法出牌：固定音高（不跟调）—— 机械感才对，跟调会像音乐 */
  illegal: {
    label: '非法出牌',
    play: (h, w) => {
      ping(h.env, h.out, w, 55, 0.07, 0.13, 0.9, 'square')
      ping(h.env, h.out, w + 0.11, 55, 0.09, 0.13, 0.9, 'square')
    },
  },

  /** ★P1 最后一墩：低频心跳两下 + 高音亮一下 */
  lastTrick: {
    label: '最后一墩',
    play: (h, w) => {
      ping(h.env, h.out, w, 43, 0.22, 0.18, 0.08, 'sine')
      ping(h.env, h.out, w + 0.24, 43, 0.22, 0.16, 0.08, 'sine')
      ping(h.env, h.out, w + 0.05, h.pitch('lastTrick', 5), 0.5, 0.09, 0.95)
    },
  },

  /** ★P1 得分悬崖（40/80/120/160）：全曲最有戏剧性的四个点 */
  cliff: {
    label: '得分悬崖',
    play: (h, w) => {
      ping(h.env, h.out, w, 36, 0.5, 0.2, 0.05, 'sine')
      noiseHit(h.env, h.out, w, 260, 0.7, 0.35, 0.14, 'lowpass')
      ping(h.env, h.out, w + 0.02, h.pitch('cliff', 4), 0.3, 0.08, 0.6)
    },
  },

  win: {
    label: '赢墩',
    play: (h, w) => {
      ping(h.env, h.out, w, h.pitch('win', 0), 0.16, 0.13, 0.75)
      ping(h.env, h.out, w + 0.085, h.pitch('win', 4), 0.22, 0.11, 0.85)
    },
  },

  lose: { label: '输墩', play: (h, w) => ping(h.env, h.out, w, h.pitch('lose', 3), 0.16, 0.1, 0.12, 'sine') },

  /** ★P1 悔牌撤回：反相 whoosh（高→低），和出牌正好相反 */
  undo: { label: '悔牌撤回', play: (h, w) => sweep(h.env, h.out, w, 3600, 500, 0.24, 0.16, 1.3) },

  hint: { label: '提示', play: (h, w) => ping(h.env, h.out, w, h.pitch('hint', 3), 0.22, 0.08, 0.9, 'sine') },

  /* ---------------- 结算 / 终局 ---------------- */

  /** ★P0 升级 N 级：**用音数表达级数** —— 升 1 级一个音、2 级两个、3 级三个再补高音 */
  settleUp: {
    label: '升级 N 级',
    play: (h, w, o) => {
      const n = Math.max(1, Math.min(3, o.n ?? 1))
      const seq = [0, 1, 2]
      for (let i = 0; i < n; i++) ping(h.env, h.out, w + i * 0.11, h.pitch('settleUp', seq[i] as number), 0.34, 0.12, 0.85)
      if (n === 3) ping(h.env, h.out, w + 0.36, h.pitch('settleUp', 5), 0.5, 0.13, 1)
    },
  },

  /** ★P0 闲家上台：换和弦色彩（升两个半音）+ 亮一下，和「庄家升级」明确区分 */
  promote: {
    label: '闲家上台',
    play: (h, w) => {
      for (const [i, d] of [0, 2, 4, 5].entries()) ping(h.env, h.out, w + i * 0.08, h.pitch('promote', d) + 2, 0.3, 0.13, 1)
      noiseHit(h.env, h.out, w + 0.1, 7000, 2.5, 0.2, 0.06)
    },
  },

  /** ★P0 必打截断：上行到三音就停（不上五音），再补一个「卡住」的低音 */
  guardStop: {
    label: '必打截断',
    play: (h, w) => {
      ping(h.env, h.out, w, h.pitch('guardStop', 0), 0.14, 0.12, 0.7)
      ping(h.env, h.out, w + 0.12, h.pitch('guardStop', 2), 0.14, 0.12, 0.7)
      ping(h.env, h.out, w + 0.24, h.pitch('guardStop', 3), 0.1, 0.1, 0.5)
      noiseHit(h.env, h.out, w + 0.3, 400, 1.2, 0.12, 0.1, 'lowpass')
    },
  },

  /** ★P0 终局·胜：大调上行六音 + 长混响（释放感） */
  overWin: {
    label: '终局 · 胜',
    play: (h, w) => {
      for (const [i, d] of [0, 1, 2, 3, 4, 5].entries()) ping(h.env, h.out, w + i * 0.13, h.pitch('overWin', d), 0.7, 0.13, 0.95)
      ping(h.env, h.out, w + 0.8, h.pitch('overWin', 5) + 12, 1.2, 0.1, 1, 'sine')
    },
  },

  /** ★P0 终局·负：小调下行 + 渐弱（落幕） */
  overLose: {
    label: '终局 · 负',
    play: (h, w) => {
      const seq = [4, 3, 2, 0]
      for (const [i, d] of seq.entries()) ping(h.env, h.out, w + i * 0.17, h.pitch('overLose', d) - 2, 0.8, 0.12 - i * 0.015, 0.35, 'sine')
      ping(h.env, h.out, w + 0.7, 36, 1.4, 0.09, 0.05, 'sine')
    },
  },

  /* ---------------- 回放 ---------------- */

  replayStep: { label: '回放翻墩', play: (h, w) => noiseHit(h.env, h.out, w, 4200, 1.8, 0.03, 0.06) },

  /* ---------------- 通用 ---------------- */

  ui: { label: '按钮', play: (h, w) => ping(h.env, h.out, w, 84, 0.012, 0.05, 0.5, 'square') },
}

export const SFX_ORDER: readonly string[] = Object.keys(SFX)

/* ============================================================
   触发（密度抑制 + 并发上限 + 音级轮转）
   ============================================================ */

/** 同一事件 70ms 内不重复（防连点） */
const DENSITY_MS = 70
/** 全局同时最多几个事件音（一墩四家连出会叠） */
const MAX_LIVE = 5
/** 粗估最长的事件音时长，用于归还并发名额 */
const LIVE_MS = 1500

export interface SfxRuntime {
  readonly lastAt: Map<string, number>
  readonly rr: Map<string, number>
  live: number
}

export function createSfxRuntime(): SfxRuntime {
  return { lastAt: new Map(), rr: new Map(), live: 0 }
}

/**
 * 触发一个音效。
 *
 * 三层保护：
 *  ① 同事件 70ms 内不重复；
 *  ② 全局同时最多 5 个事件音 —— **满了直接丢，不排队**（排队会整体滞后，比丢一个更糟）；
 *  ③ 没在跑就直接返回。
 */
export function playSfx(rt: SfxRuntime, host: SfxHost, name: string, opts: SfxOptions = {}): void {
  const def = SFX[name]
  if (!def) return
  const t = typeof performance !== 'undefined' ? performance.now() : Date.now()
  const last = rt.lastAt.get(name)
  if (!opts.force && last !== undefined && t - last < DENSITY_MS) return
  if (rt.live >= MAX_LIVE && !opts.force) return
  rt.lastAt.set(name, t)

  rt.live++
  try {
    def.play(host, host.env.ctx.currentTime + 0.004, opts)
  } catch {
    /* 单个音效失败不该影响游戏 */
  }
  if (typeof setTimeout === 'function') {
    setTimeout(() => {
      rt.live = Math.max(0, rt.live - 1)
    }, LIVE_MS)
  }
}

/** 音效音高：C 大调高两个八度 + 音级轮转 + 张力降调 + 段位移调 */
export function nextPitch(rt: SfxRuntime, name: string, degree: number | undefined, tension: number, keyShift: number): number {
  const deg = degree ?? ((rt.rr.get(name) ?? 0) + 1) % 5
  if (degree === undefined) rt.rr.set(name, deg)
  return 72 + (SCALE[deg % SCALE.length] as number) + Math.round(-2 * tension) + keyShift
}
