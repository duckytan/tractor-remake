/**
 * BGM 调度器：40ms 轮询 + 0.45s 前瞻 + 卡顿保护 + 每小节编排。
 *
 * 核心思想（来自参考实现）：
 *   **场景是参数集，不是曲目。** 同一份谱子、同一个伴奏网格，
 *   只换速度 / 亮度 / 力度 / 混响，音乐永远不会因为分数跳动而硬切。
 *
 * 变奏周期固定 8 小节，**不跟着循环长度走**：
 *   8 小节主题 + 8 小节变奏 = 第一遍纯主题、第二遍加装饰（A A′）。
 *   若跟着循环走（4 小节换一次），等于每十几秒换一副面孔，反而听不出主题。
 *
 * `autoVariation = false` 时：锁死成一套 —— 永远用 `play` 场景参数、
 * 变奏全部关闭、不转调。就是「永远是同一个调」。
 */

import type { Seat } from '@core'
import { makeRng } from './synth'
import type { AudioEnv } from './synth'
import type { MusicRenderer } from './voices'
import {
  ACC_GRID,
  ARP_PATTERNS,
  BARS_PER_SECTION,
  CHORDS,
  FILL_SCALE,
  REPLAY_MUTE,
  ROW_VEL,
  SECTIONS,
  THEMES,
  VAR_PERIOD,
  phraseAccent,
  sceneParams,
  sectionAt,
} from './scenes'
import type { SceneKey, ThemeKey } from './scenes'

export interface MusicOptions {
  /** 主题（四季） */
  theme: ThemeKey
  /** 场景（游戏阶段） */
  scene: SceneKey
  /** 紧张度 0..1 */
  tension: number
  /** 编排变奏开关（设置项「根据剧情自动变奏」） */
  autoVariation: boolean
}

export interface MusicBuses {
  readonly env: AudioEnv
  readonly accBus: AudioNode
  readonly leadBus: AudioNode
  readonly padBus: AudioNode
  readonly fxBus: AudioNode
  /** 发声实现：原生合成 / Tone.js，二选一 */
  readonly render: MusicRenderer
}

interface VarFlags {
  oct: boolean
  grace: boolean
  fill: boolean
  counter: boolean
  arp: number
}

const NO_VAR: VarFlags = { oct: false, grace: false, fill: false, counter: false, arp: 0 }

/** 回放时抽掉旋律与左手和弦，让「复盘」听得清 */
function applyReplay<T extends { mel: 0 | 1; rows: number; lh: 0 | 1; shk: number }>(sec: T): T {
  return { ...sec, ...REPLAY_MUTE }
}

export class MusicEngine {
  private barIndex = 0
  private nextBarTime = 0
  private timer: ReturnType<typeof setInterval> | null = null
  private varFlags: VarFlags = NO_VAR
  private seed = (Date.now() % 100000) | 0
  /** 调度时的移调量，音效要跟着它才能和 BGM 待在同一个调上 */
  keyShift = 0
  /** 最近一次实际使用的紧张度（平滑后） */
  private tensionCur = 0

  /** 发声实现：可热切换（原生 ↔ Tone），调度器本身不动 */
  private renderer: MusicRenderer

  constructor(
    private readonly buses: MusicBuses,
    private opts: MusicOptions,
  ) {
    this.renderer = buses.render
  }

  /** 热切换后端（增强音效开关） */
  setRenderer(r: MusicRenderer): void {
    this.renderer = r
  }

  get running(): boolean {
    return this.timer !== null
  }

  get bars(): number {
    return this.barIndex
  }

  get tension(): number {
    return this.tensionCur
  }

  setOptions(o: Partial<MusicOptions>): void {
    this.opts = { ...this.opts, ...o }
  }

  start(): void {
    if (this.timer !== null) return
    this.barIndex = 0
    this.tensionCur = 0
    this.nextBarTime = this.buses.env.ctx.currentTime + 0.25
    this.timer = setInterval(() => this.tick(), 40)
    this.tick()
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer)
      this.timer = null
    }
    // 不关上下文：已排出去的音（≤0.45s 前瞻）自然收尾，比硬切干净
  }

  /** 当前实际使用的场景：关掉自动变奏时永远锁在 play */
  private sceneOf(): SceneKey {
    return this.opts.autoVariation ? this.opts.scene : 'play'
  }

  private tick(): void {
    const { ctx } = this.buses.env
    const now = ctx.currentTime
    // 紧张度平滑（约 0.7 秒收敛）；关掉自动变奏时不跟剧情走
    const target = this.opts.autoVariation ? this.opts.tension : 0
    this.tensionCur += (target - this.tensionCur) * 0.06

    const sc = sceneParams(this.sceneOf())
    const barDur = (60 / (sc.bpm * (1 + 0.08 * this.tensionCur))) * 4

    // 卡顿保护：主线程被卡过就把欠的小节跳过，绝不补播
    if (this.nextBarTime < now) {
      const skip = Math.ceil((now - this.nextBarTime) / barDur)
      this.barIndex += skip
      this.nextBarTime += skip * barDur
    }
    let guard = 0
    while (this.nextBarTime < now + 0.45 && guard++ < 6) {
      this.scheduleBar(this.barIndex, this.nextBarTime)
      this.nextBarTime += barDur
      this.barIndex++
    }
  }

  private refreshVariation(): void {
    if (!this.opts.autoVariation) {
      this.varFlags = NO_VAR
      return
    }
    const epoch = Math.floor(this.barIndex / VAR_PERIOD)
    const r = makeRng(this.seed * 7919 + epoch * 104729 + 12345)
    this.varFlags = {
      oct: r() < 0.38,
      grace: r() < 0.45,
      fill: r() < 0.42,
      counter: r() < 0.3,
      arp: Math.floor(r() * ARP_PATTERNS.length) % ARP_PATTERNS.length,
    }
  }

  private scheduleBar(bi: number, when: number): void {
    const { env, accBus, leadBus, padBus, fxBus } = this.buses
    const render = this.renderer
    const sc = sceneParams(this.sceneOf())
    const theme = THEMES[this.opts.theme]
    const t = this.tensionCur
    const beat = 60 / (sc.bpm * (1 + 0.08 * t))
    const bright = Math.max(0, Math.min(1, sc.bright + 0.3 * t))

    const loopBar = bi % theme.loopBars
    const ci = loopBar % 4
    const chord = CHORDS[ci] ?? CHORDS[0]!
    const tr = sc.tp + Math.round(-2 * t)
    this.keyShift = sc.tp

    let sec = sectionAt(bi)
    if (this.opts.scene === 'replay' && this.opts.autoVariation) sec = applyReplay(sec)
    if (loopBar === 0) this.refreshVariation()

    const r = makeRng(this.seed * 31 + bi * 7717)

    // ① 伴奏分解：网格驱动
    if (sc.gtr > 0.02) {
      const gtrAmt = Math.min(1.4, Math.max(0, sc.gtr))
      const densP = Math.max(0, (sc.dens - 0.75) * 0.34)
      const base = ci * 8
      for (let i = 0; i < 8; i++) {
        let bits = (ACC_GRID[base + i] ?? 0) | 0
        // 紧张度补空拍（加密而不是加响）
        if (!bits && t > 0.5 && i % 2 === 1) {
          bits = 1 << 0
          if (t > 0.75) bits |= 1 << 3
        }
        bits &= sec.rows
        if (!bits) continue
        const idxs: number[] = []
        for (let k = 0; k < 6; k++) if (bits & (1 << k)) idxs.push(k)
        if (!idxs.length) continue
        const w = when + i * beat * 0.5 + (r() - 0.5) * 0.012
        const vel =
          (i % 2 === 0 ? 0.95 : 0.72) *
          (0.85 + r() * 0.25) *
          (idxs.length > 1 ? 1 / Math.sqrt(idxs.length) : 1) *
          gtrAmt
        for (const k of idxs) {
          // 高三行再 +12：正弦泛音的 4×/9× 次泛音就落进 3.5–5kHz 的「空气」频段
          const pitch = (chord.p[k] ?? 0) + tr + (k === 5 ? 12 : 0)
          render.voice(env, accBus, w, pitch, vel * (ROW_VEL[k] ?? 0.8), beat * 0.9, bright, 'marimba')
        }
        if (r() < densP) {
          render.voice(env, accBus, w + beat * 0.25, (chord.p[idxs[0] as number] ?? 0) + tr + 12, vel * 0.45, beat * 0.5, bright, 'marimba')
        }
      }
    }

    // ② 左手和弦：根音 + 五音长音，铺厚度
    if (sec.lh && sc.pno > 0.02) {
      const amt = Math.min(1.4, Math.max(0, sc.pno))
      render.voice(env, accBus, when, (chord.p[1] ?? 0) + tr, 0.42 * amt, beat * 1.6, bright, 'pianoSoft')
      render.voice(env, accBus, when, (chord.p[3] ?? 0) + tr, 0.34 * amt, beat * 1.6, bright, 'pianoSoft')
      if (sc.dens > 0.7 && ci % 2 === 1) {
        render.voice(env, accBus, when + beat * 2, (chord.p[2] ?? 0) + tr, 0.28 * amt, beat * 1.2, bright, 'pianoSoft')
      }
    }

    // ③ 和声床
    if (sec.pad && sc.pad > 0.01) {
      render.pad(env, padBus, when, (chord.p[0] ?? 0) + 12 + tr, beat * 4, sc.pad * 0.1)
      render.pad(env, padBus, when, (chord.p[2] ?? 0) + tr, beat * 4, sc.pad * 0.07)
    }

    // ④ 主旋律 + 三种变奏
    if (sec.mel) {
      const b0 = loopBar * 4
      const b1 = b0 + 4
      const evs = theme.melody.filter((e) => e[0] >= b0 && e[0] < b1)
      evs.forEach((e, k) => {
        const local = e[0] - b0
        const dur = e[2] * beat
        const midi = e[1] + tr
        const w = when + local * beat + (r() - 0.5) * 0.014
        const vel = (0.93 + r() * 0.07) * sc.melV * phraseAccent(e[0], e[1], theme.loopBars)
        render.voice(env, leadBus, w, midi, vel, dur, bright, theme.inst)
        // 变奏 1：低八度叠音，旋律立刻「厚」
        if (this.varFlags.oct) render.voice(env, leadBus, w, midi - 12, vel * 0.28, dur, bright, theme.inst)
        // 变奏 2：下行四度的对位音，隔一个音来一次
        if (this.varFlags.counter && k % 2 === 0) render.voice(env, leadBus, w + 0.02, midi - 4, vel * 0.2, dur, bright, theme.inst)
        // 变奏 3：装饰音，提前 0.22 拍、低二度
        if (this.varFlags.grace && k % 3 === 0) {
          render.voice(env, leadBus, w - beat * 0.22, midi - 2, vel * 0.32, beat * 0.2, bright, theme.inst)
        }
      })
    }

    // ⑤ 尾句加花：只在第 4 小节最后三拍半插三个上行音
    if (this.varFlags.fill && ci === 3 && sc.pno > 0.02) {
      for (let i = 0; i < 3; i++) {
        render.voice(env, accBus, when + beat * (3.25 + i * 0.25), (FILL_SCALE[i + 3] ?? 72) + tr, 0.34, beat * 0.3, bright, 'marimba')
      }
    }

    // ⑥ 沙锤：八分音符连续，正拍轻、反拍重
    if (sc.shaker > 0) {
      for (let i = 0; i < 8; i++) {
        render.shaker(env, fxBus, when + i * beat * 0.5, sc.shaker * sec.shk * (i % 2 ? 1 : 0.5) * (1 + 0.5 * t))
      }
    }
  }
}

/** 供调试：某一小节属于哪一段 */
export function sectionTagAt(barIndex: number): string {
  return (SECTIONS[Math.floor(barIndex / BARS_PER_SECTION) % SECTIONS.length] as { tag: string }).tag
}

/** 供调试：座位声像（音乐侧不用，音效侧用） */
export type { Seat }
