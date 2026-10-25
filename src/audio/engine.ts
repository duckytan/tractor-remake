/**
 * 音频引擎：上下文生命周期 + 总线拓扑 + 音量。
 *
 * 总线是「洋葱」，加新总线时必须接对层：
 *
 *   乐器 → 分声道 pan → **musicBus**（BGM 总音量）→ dryBus / wetBus → master
 *                                                                     ↓
 *                                                        tone(8.5k 低通) → comp → destination
 *
 *   SFX  → sfxBus ─────────────────────────────→ dryBus / wetBus（**不经过** musicBus）
 *
 * 为什么 SFX 要绕开 musicBus：BGM 拉到 0 时音效还得听得见。
 * 为什么沙锤要经过 musicBus：它是 BGM 的一部分，BGM 静音时它也必须停。
 */

import { makeIR, makeNoise } from './synth'
import type { AudioEnv } from './synth'

export interface Volumes {
  /** 0..1 */
  readonly master: number
  /** 0..1 */
  readonly bgm: number
  /** 0..1 */
  readonly sfx: number
}

export interface AudioBuses {
  readonly ctx: AudioContext
  readonly env: AudioEnv
  readonly master: GainNode
  readonly tone: BiquadFilterNode
  readonly comp: DynamicsCompressorNode
  readonly dry: GainNode
  readonly wet: GainNode
  readonly wetGain: GainNode
  readonly musicBus: GainNode
  readonly sfxBus: GainNode
  /** 木吉他（偏左） */
  readonly gtrBus: GainNode
  /** 钢琴（偏右） */
  readonly pnoBus: GainNode
  /** 伴奏（网格分解 + 左手和弦） */
  readonly accBus: GainNode
  /** 主旋律 */
  readonly leadBus: GainNode
  /** 和声床 */
  readonly padBus: GainNode
  /** BGM 效果层（沙锤等）—— 走 musicBus */
  readonly fxBus: GainNode
}

/** 建整套总线。调用方负责确保这是「用户手势之后」 */
export function createBuses(vol: Volumes): AudioBuses {
  const ctx = new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)()

  const master = ctx.createGain()
  master.gain.value = vol.master

  // 音色闸门：压掉 8.5kHz 以上的毛刺，比每个音色各加一次低通省事
  const tone = ctx.createBiquadFilter()
  tone.type = 'lowpass'
  tone.frequency.value = 8500
  tone.Q.value = 0.5

  const comp = ctx.createDynamicsCompressor()
  comp.threshold.value = -20
  comp.knee.value = 22
  comp.ratio.value = 2.6
  comp.attack.value = 0.012
  comp.release.value = 0.28

  master.connect(tone)
  tone.connect(comp)
  comp.connect(ctx.destination)

  const dry = ctx.createGain()
  dry.gain.value = 1.0
  dry.connect(master)

  const conv = ctx.createConvolver()
  conv.buffer = makeIR(ctx, 2.0, 5.0, 0.22)
  const wetGain = ctx.createGain()
  wetGain.gain.value = 0.36
  const wet = ctx.createGain()
  wet.gain.value = 1.0
  wet.connect(conv)
  conv.connect(wetGain)
  wetGain.connect(master)

  // BGM 总音量：所有乐器总线必须**经过它**再进 dry/wet，
  // 否则 musicBus.gain 调的是一个空节点 —— BGM 滑杆会完全失效。
  const musicBus = ctx.createGain()
  musicBus.gain.value = vol.bgm
  musicBus.connect(dry)
  musicBus.connect(wet)

  /** 一条「带声道定位」的乐器总线，统一接进 musicBus */
  const panned = (gain: number, pan: number): GainNode => {
    const g = ctx.createGain()
    g.gain.value = gain
    const p = ctx.createStereoPanner()
    p.pan.value = pan
    g.connect(p)
    p.connect(musicBus)
    return g
  }

  const gtrBus = panned(0.78, -0.28)
  const pnoBus = panned(0.8, 0.22)
  const accBus = panned(0.78, -0.12)
  const leadBus = panned(0.8, 0.06)

  const padBus = ctx.createGain()
  padBus.gain.value = 0.2
  padBus.connect(musicBus)

  // BGM 效果层（沙锤）—— 要经过 musicBus，否则 BGM 静音了还有沙沙声
  const fxBus = ctx.createGain()
  fxBus.gain.value = 1.0
  fxBus.connect(musicBus)

  // 音效总线：**不经过 musicBus** —— BGM 静音时音效还得听得见
  const sfxBus = ctx.createGain()
  sfxBus.gain.value = vol.sfx
  sfxBus.connect(dry)
  sfxBus.connect(wet)

  const noise = makeNoise(ctx, 2.0)

  return {
    ctx,
    env: { ctx, noise },
    master,
    tone,
    comp,
    dry,
    wet,
    wetGain,
    musicBus,
    sfxBus,
    gtrBus,
    pnoBus,
    accBus,
    leadBus,
    padBus,
    fxBus,
  }
}

/** 音量：平滑过渡，避免拖动滑条时「咔」 */
export function applyVolumes(b: AudioBuses, vol: Volumes): void {
  const now = b.ctx.currentTime
  b.master.gain.setTargetAtTime(vol.master, now, 0.05)
  b.musicBus.gain.setTargetAtTime(vol.bgm, now, 0.05)
  b.sfxBus.gain.setTargetAtTime(vol.sfx, now, 0.05)
}

/** 浏览器要求用户手势后才能出声；suspended 时恢复 */
export async function resume(b: AudioBuses): Promise<void> {
  if (b.ctx.state === 'suspended') {
    try {
      await b.ctx.resume()
    } catch {
      /* 自动播放被拦：交给上层提示 */
    }
  }
}

export function suspend(b: AudioBuses): void {
  if (b.ctx.state === 'running') {
    try {
      void b.ctx.suspend()
    } catch {
      /* 忽略 */
    }
  }
}

export function close(b: AudioBuses): void {
  try {
    void b.ctx.close()
  } catch {
    /* 忽略 */
  }
}
