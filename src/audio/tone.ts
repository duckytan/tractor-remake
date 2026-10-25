/**
 * Tone.js 后端（设置项「增强音效」）。
 *
 * **刻意不做成构建依赖**：本项目的铁律是「零运行时依赖」，
 * 所以 Tone.js 走**运行时按需加载**（CDN / 本地副本三级回退），
 * `package.json` 里不出现它。加载失败就退回原生引擎，功能不受影响。
 *
 * 只接管 **BGM** 的发声：Tone 的优势在持续音与混响；
 * 事件音只有 20–200ms，走 Tone 的调度反而更容易延迟，所以仍用原生合成。
 *
 * 同接口：`MusicRenderer` 的 voice / pad / shaker 三个方法，
 * 与原生后端签名完全一致 ⇒ `music.ts` 不知道底下是谁。
 */

import type { AudioEnv } from './synth'
import type { MusicRenderer } from './voices'

/** 最小 Tone 类型声明（避免为一个可选依赖引整套 d.ts） */
interface ToneParam {
  rampTo(v: number, t?: number): void
  value: number
}
interface ToneNode {
  connect(n: unknown): ToneNode
  dispose(): void
}
interface ToneGain extends ToneNode {
  gain: ToneParam
}
interface TonePoly {
  triggerAttackRelease(note: number | string, dur: number, time?: number, vel?: number): void
  maxPolyphony: number
  connect(n: unknown): TonePoly
  dispose(): void
}
interface ToneLib {
  start(): Promise<void>
  Gain: new (v: number) => ToneGain
  Filter: new (f: number, type: string) => ToneNode
  Compressor: new (o: Record<string, number>) => ToneNode
  Limiter: new (v: number) => ToneNode & { toDestination(): ToneNode }
  Reverb: new (o: Record<string, number>) => ToneNode & { ready: Promise<void>; wet: ToneParam }
  Channel: new (o: Record<string, unknown>) => ToneNode & { volume: ToneParam }
  PolySynth: new (cls: unknown, o: Record<string, unknown>) => TonePoly
  Synth: unknown
  FMSynth: unknown
  MonoSynth: unknown
  NoiseSynth: new (o: Record<string, unknown>) => { triggerAttackRelease(d: number, t?: number, v?: number): void; connect(n: unknown): ToneNode; dispose(): void }
  gainToDb(g: number): number
  getContext(): { state: string; rawContext: AudioContext }
}

declare global {
  interface Window {
    Tone?: ToneLib
  }
}

const CDN_SOURCES = [
  './tone.min.js',
  'https://cdn.jsdelivr.net/npm/tone@14.8.49/build/Tone.js',
  'https://unpkg.com/tone@14.8.49/build/Tone.js',
]

let loadPromise: Promise<ToneLib> | null = null

function loadScript(src: string, ms: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const el = document.createElement('script')
    let done = false
    const tid = setTimeout(() => {
      if (done) return
      done = true
      el.onload = el.onerror = null
      el.remove()
      reject(new Error('超时 ' + ms + 'ms · ' + src))
    }, ms)
    el.onload = () => {
      if (done) return
      done = true
      clearTimeout(tid)
      resolve()
    }
    el.onerror = () => {
      if (done) return
      done = true
      clearTimeout(tid)
      reject(new Error('下载失败 · ' + src))
    }
    el.src = src
    document.head.appendChild(el)
  })
}

/** 三级回退加载 Tone.js；失败抛错，由上层退回原生引擎 */
export function loadTone(): Promise<ToneLib> {
  if (window.Tone) return Promise.resolve(window.Tone)
  if (loadPromise) return loadPromise
  loadPromise = (async () => {
    const errs: string[] = []
    for (const src of CDN_SOURCES) {
      try {
        await loadScript(src, 8000)
      } catch (e) {
        errs.push((e as Error).message)
        continue
      }
      if (window.Tone) return window.Tone
      errs.push('加载了但没有 window.Tone · ' + src)
    }
    loadPromise = null // 清掉失败缓存，下次还能重试
    throw new Error(errs.join(' ／ '))
  })()
  return loadPromise
}

/** 我们的音色名 → Tone 的合成器参数 */
const TONE_VOICE: Record<string, { V: 'FMSynth' | 'Synth'; o: Record<string, unknown> }> = {
  piano: {
    V: 'FMSynth',
    o: {
      harmonicity: 1,
      modulationIndex: 1.8,
      oscillator: { type: 'sine' },
      envelope: { attack: 0.004, decay: 1.6, sustain: 0.1, release: 1.2 },
      modulation: { type: 'sine' },
      modulationEnvelope: { attack: 0.004, decay: 0.5, sustain: 0.05, release: 0.6 },
    },
  },
  pianoSoft: {
    V: 'FMSynth',
    o: {
      harmonicity: 1,
      modulationIndex: 1.2,
      oscillator: { type: 'sine' },
      envelope: { attack: 0.008, decay: 1.4, sustain: 0.08, release: 1.2 },
      modulation: { type: 'sine' },
      modulationEnvelope: { attack: 0.008, decay: 0.4, sustain: 0.03, release: 0.5 },
    },
  },
  epiano: {
    V: 'FMSynth',
    o: {
      harmonicity: 3,
      modulationIndex: 8,
      oscillator: { type: 'sine' },
      envelope: { attack: 0.002, decay: 1.5, sustain: 0.1, release: 1.2 },
      modulation: { type: 'sine' },
      modulationEnvelope: { attack: 0.002, decay: 0.25, sustain: 0, release: 0.3 },
    },
  },
  celesta: {
    V: 'FMSynth',
    o: {
      harmonicity: 5.7,
      modulationIndex: 12,
      oscillator: { type: 'sine' },
      envelope: { attack: 0.001, decay: 0.55, sustain: 0, release: 0.6 },
      modulation: { type: 'sine' },
      modulationEnvelope: { attack: 0.001, decay: 0.2, sustain: 0, release: 0.2 },
    },
  },
  musicbox: {
    V: 'FMSynth',
    o: {
      harmonicity: 8,
      modulationIndex: 16,
      oscillator: { type: 'sine' },
      envelope: { attack: 0.001, decay: 0.9, sustain: 0, release: 0.9 },
      modulation: { type: 'sine' },
      modulationEnvelope: { attack: 0.001, decay: 0.25, sustain: 0, release: 0.25 },
    },
  },
  vibes: {
    V: 'FMSynth',
    o: {
      harmonicity: 4,
      modulationIndex: 9,
      oscillator: { type: 'sine' },
      envelope: { attack: 0.002, decay: 1.6, sustain: 0.05, release: 1.5 },
      modulation: { type: 'sine' },
      modulationEnvelope: { attack: 0.002, decay: 0.3, sustain: 0.05, release: 0.4 },
    },
  },
  guitar: { V: 'Synth', o: { oscillator: { type: 'triangle' }, envelope: { attack: 0.003, decay: 0.9, sustain: 0, release: 0.3 } } },
  harp: { V: 'Synth', o: { oscillator: { type: 'triangle' }, envelope: { attack: 0.006, decay: 1.8, sustain: 0.02, release: 0.9 } } },
  flute: { V: 'Synth', o: { oscillator: { type: 'sine' }, envelope: { attack: 0.07, decay: 0.12, sustain: 0.85, release: 0.3 } } },
  marimba: {
    V: 'FMSynth',
    o: {
      harmonicity: 3.2,
      modulationIndex: 6,
      oscillator: { type: 'sine' },
      envelope: { attack: 0.002, decay: 0.42, sustain: 0, release: 0.42 },
      modulation: { type: 'sine' },
      modulationEnvelope: { attack: 0.002, decay: 0.15, sustain: 0, release: 0.15 },
    },
  },
}

const COMBO_MAP: Record<string, readonly (readonly [string, number])[]> = {
  pianoGuitar: [
    ['piano', 1.0],
    ['guitar', 0.72],
  ],
  flutePiano: [
    ['flute', 1.0],
    ['pianoSoft', 0.62],
  ],
}

interface Rack {
  trigger(midi: number, when: number, dur: number, vel: number): void
  dispose(): void
}

/** 四个角色：伴奏 / 主旋律 / 和声床 / 效果 */
export type ToneRole = 'acc' | 'lead' | 'pad' | 'fx'

/**
 * Tone 后端。
 *
 * **自带一整条输出链**（Limiter → Compressor → Filter → Gain → Reverb → 4 个 Channel），
 * 与原生总线完全独立 —— 两套引擎互不干扰，切回去时原生图原样还在。
 * 所以 `music.ts` 传进来的原生 `dest` 只用来**识别角色**，不参与发声。
 */
export class ToneRenderer implements MusicRenderer {
  private readonly racks = new Map<string, Rack>()
  private padSynth: TonePoly | null = null
  private shakerSynth: { triggerAttackRelease(d: number, t?: number, v?: number): void; dispose(): void } | null = null
  private readonly chans: Record<ToneRole, ToneNode & { volume: ToneParam }>
  private readonly roleOf: Map<AudioNode, ToneRole>
  private master!: ToneGain

  constructor(
    private readonly tone: ToneLib,
    roleOf: Map<AudioNode, ToneRole>,
  ) {
    this.roleOf = roleOf
    const t = tone
    const lim = new t.Limiter(-1).toDestination()
    const comp = new t.Compressor({ threshold: -20, ratio: 2.6, attack: 0.012, release: 0.28 })
    comp.connect(lim)
    const filt = new t.Filter(8500, 'lowpass')
    filt.connect(comp)
    this.master = new t.Gain(1)
    this.master.connect(filt)
    const dry = new t.Gain(1)
    dry.connect(this.master)
    const rev = new t.Reverb({ decay: 2.0, preDelay: 0.02 })
    rev.wet.value = 1
    const wetGain = new t.Gain(0.36)
    const wet = new t.Gain(1)
    wet.connect(rev)
    rev.connect(wetGain)
    wetGain.connect(this.master)

    const mk = (gain: number, pan: number): ToneNode & { volume: ToneParam } => {
      const c = new t.Channel({ volume: t.gainToDb(gain), pan })
      c.connect(dry)
      c.connect(wet)
      return c
    }
    this.chans = {
      acc: mk(0.78, -0.12),
      lead: mk(0.8, 0.06),
      pad: mk(0.2, 0),
      fx: mk(1.0, 0),
    }
  }

  /** BGM 总音量（0..1） */
  setVolume(v: number): void {
    try {
      this.master.gain.rampTo(v, 0.05)
    } catch {
      /* 忽略 */
    }
  }

  private role(dest: AudioNode): ToneRole {
    return this.roleOf.get(dest) ?? 'acc'
  }

  private rack(kind: string, role: ToneRole): Rack | null {
    const key = kind + '|' + role
    const hit = this.racks.get(key)
    if (hit) return hit
    const def = TONE_VOICE[kind]
    if (!def) return null
    const Cls = def.V === 'FMSynth' ? this.tone.FMSynth : this.tone.Synth
    const node = new this.tone.PolySynth(Cls, def.o)
    try {
      node.maxPolyphony = 16
    } catch {
      /* 老版本没有这个属性 */
    }
    node.connect(this.chans[role])
    let lastT = -1
    const r: Rack = {
      trigger: (midi, when, dur, vel) => {
        // Tone 的时间轴必须单调，否则抛 Start time must be strictly greater than previous
        const t = when < lastT ? lastT + 0.0005 : when
        lastT = t
        try {
          node.triggerAttackRelease(midi, Math.max(0.05, dur), t, Math.min(1, vel))
        } catch {
          /* 单个音失败不该带走整小节 */
        }
      },
      dispose: () => {
        try {
          node.dispose()
        } catch {
          /* 忽略 */
        }
      },
    }
    this.racks.set(key, r)
    return r
  }

  voice(_env: AudioEnv, dest: AudioNode, when: number, midi: number, vel: number, dur: number, _bright: number, kind: string): void {
    const role = this.role(dest)
    const combo = COMBO_MAP[kind]
    if (combo) {
      for (const [k, mul] of combo) this.rack(k, role)?.trigger(midi, when, dur, vel * mul)
      return
    }
    this.rack(kind, role)?.trigger(midi, when, dur, vel)
  }

  pad(_env: AudioEnv, _dest: AudioNode, when: number, midi: number, dur: number, vel: number): void {
    if (!this.padSynth) {
      this.padSynth = new this.tone.PolySynth(this.tone.Synth, {
        oscillator: { type: 'sine' },
        envelope: { attack: 0.35, decay: 0.2, sustain: 0.75, release: 0.6 },
      })
      this.padSynth.connect(this.chans.pad)
    }
    try {
      this.padSynth.triggerAttackRelease(midi, Math.max(0.2, dur), when, Math.min(1, vel * 3.2))
    } catch {
      /* 忽略 */
    }
  }

  shaker(_env: AudioEnv, _dest: AudioNode, when: number, vel: number): void {
    if (!this.shakerSynth) {
      const n = new this.tone.NoiseSynth({
        noise: { type: 'white' },
        envelope: { attack: 0.006, decay: 0.09, sustain: 0, release: 0.02 },
      })
      n.connect(this.chans.fx)
      this.shakerSynth = n
    }
    try {
      this.shakerSynth.triggerAttackRelease(0.09, when, Math.min(1, vel * 1.5))
    } catch {
      /* 忽略 */
    }
  }

  dispose(): void {
    this.racks.forEach((r) => r.dispose())
    this.racks.clear()
    try {
      this.padSynth?.dispose()
    } catch {
      /* 忽略 */
    }
    try {
      this.shakerSynth?.dispose()
    } catch {
      /* 忽略 */
    }
    this.padSynth = null
    this.shakerSynth = null
  }
}
