/**
 * 音色库。每种音色都是「一个函数 + 一组参数」，没有采样文件。
 *
 * 全部签名统一为 `(env, dest, when, midi, vel, dur, bright)`，
 * 方便按名字查表调用（见文件末尾的 VOICE / COMBO）。
 */

import { addPartial, mtof, noiseHit, renderPluck, PLUCK_SEC } from './synth'
import type { AudioEnv } from './synth'

/** 统一的发声签名 */
export type VoiceFn = (
  env: AudioEnv,
  dest: AudioNode,
  when: number,
  midi: number,
  vel: number,
  dur: number,
  bright: number,
) => void

/* ============================================================
   钢琴（加法合成，7 层泛音）
   ============================================================ */

/**
 * 7 层泛音 + 每层独立的衰减倍率。
 * **泛音层数就是「像不像真钢琴」的分水岭** —— 4 层听起来发「电子」。
 */
const PIANO_PARTIALS: readonly (readonly [number, number, number])[] = [
  [1, 1.0, 1.0],
  [2, 0.44, 0.74],
  [3, 0.24, 0.58],
  [4, 0.13, 0.45],
  [5, 0.07, 0.35],
  [6, 0.04, 0.28],
  [8, 0.02, 0.2],
]

function pianoImpl(soft: boolean): VoiceFn {
  return (env, dest, when, midi, vel, dur, _bright) => {
    const { ctx, noise } = env
    const f = mtof(midi)
    const out = ctx.createGain()
    out.gain.value = vel * 0.2
    out.connect(dest)

    // 低音衰减更长：钢琴的低音弦就是这么物理行为的
    const baseDecay = 1.6 + Math.max(0, 72 - midi) * 0.1
    const br = soft ? 0.55 : 1.0

    for (let i = 0; i < PIANO_PARTIALS.length; i++) {
      const part = PIANO_PARTIALS[i] as readonly [number, number, number]
      const h = part[0]
      if (h > 4 && br < 0.8 && i > 4) break // soft 模式砍掉最高的几层
      const amp = part[1] * (h > 2 ? br : 1)
      const dm = part[2]
      const o = ctx.createOscillator()
      o.type = 'sine'
      // 微微拉伸泛音，非理想弦
      o.frequency.value = f * h * (1 + 0.0004 * h * h)
      const g = ctx.createGain()
      const end = when + baseDecay * dm + dur * 0.35
      g.gain.setValueAtTime(0, when)
      g.gain.linearRampToValueAtTime(amp, when + 0.006)
      g.gain.exponentialRampToValueAtTime(amp * 0.25, when + 0.22)
      g.gain.exponentialRampToValueAtTime(0.0001, end)
      o.connect(g)
      g.connect(out)
      o.start(when)
      o.stop(end + 0.1)
    }

    // 击槌噪声
    const ns = ctx.createBufferSource()
    ns.buffer = noise
    ns.loop = true
    const nf = ctx.createBiquadFilter()
    nf.type = 'bandpass'
    nf.frequency.value = 2400
    nf.Q.value = 0.8
    const ng = ctx.createGain()
    ng.gain.setValueAtTime(0, when)
    ng.gain.linearRampToValueAtTime(0.09 * vel * br, when + 0.003)
    ng.gain.exponentialRampToValueAtTime(0.0001, when + 0.09)
    ns.connect(nf)
    nf.connect(ng)
    ng.connect(out)
    ns.start(when)
    ns.stop(when + 0.12)
  }
}

export const vPiano = pianoImpl(false)
export const vPianoSoft = pianoImpl(true)

/* ============================================================
   木吉他（Karplus-Strong 缓冲 + 两处琴身峰值）
   ============================================================ */

export function vGuitar(env: AudioEnv, dest: AudioNode, when: number, midi: number, vel: number, _dur: number, bright: number): void {
  const { ctx } = env
  const buf = pluckBuf(env, midi)
  const src = ctx.createBufferSource()
  src.buffer = buf
  src.playbackRate.value = 1 + (Math.random() - 0.5) * 0.002

  const lp = ctx.createBiquadFilter()
  lp.type = 'lowpass'
  lp.frequency.value = 1800 + bright * 4200
  lp.Q.value = 0.6
  // 两处峰值模拟琴身共鸣：128Hz 给厚度，420Hz 给木头的「膛」
  const body = ctx.createBiquadFilter()
  body.type = 'peaking'
  body.frequency.value = 128
  body.Q.value = 1.1
  body.gain.value = 4.5
  const body2 = ctx.createBiquadFilter()
  body2.type = 'peaking'
  body2.frequency.value = 420
  body2.Q.value = 1.4
  body2.gain.value = 2.6

  const g = ctx.createGain()
  g.gain.setValueAtTime(0, when)
  g.gain.linearRampToValueAtTime(vel * 0.34, when + 0.004)
  g.gain.exponentialRampToValueAtTime(0.0001, when + 2.6)

  src.connect(lp)
  lp.connect(body)
  body.connect(body2)
  body2.connect(g)
  g.connect(dest)
  src.start(when)
  src.stop(when + PLUCK_SEC)
}

/** 拨弦缓冲缓存（同一音高只渲一次） */
const pluckCache = new WeakMap<AudioEnv, Map<number, AudioBuffer>>()

function pluckBuf(env: AudioEnv, midi: number): AudioBuffer {
  let m = pluckCache.get(env)
  if (!m) {
    m = new Map()
    pluckCache.set(env, m)
  }
  const hit = m.get(midi)
  if (hit) return hit
  const buf = env.ctx.createBuffer(1, Math.ceil(PLUCK_SEC * env.ctx.sampleRate), env.ctx.sampleRate)
  renderPluck(env.ctx, buf, mtof(midi))
  if (m.size > 200) m.clear()
  m.set(midi, buf)
  return buf
}

/** 供引擎在 stop 时清缓存（WeakMap 里的键是 env，换 env 自然失效） */
export function clearVoiceCache(): void {
  // WeakMap 无法遍历，靠换 env 实例回收；这里保留函数以便将来加别的缓存
}

/* ============================================================
   电钢琴（Rhodes 风格：正弦载波 + FM，调制指数快速塌缩）
   ============================================================ */

export const vEPiano: VoiceFn = (env, dest, when, midi, vel, dur) => {
  const { ctx } = env
  const f = mtof(midi)
  const lp = ctx.createBiquadFilter()
  lp.type = 'lowpass'
  lp.frequency.value = 3600
  lp.Q.value = 0.4
  lp.connect(dest)

  const out = ctx.createGain()
  out.gain.value = vel * 0.26
  out.connect(lp)

  const car = ctx.createOscillator()
  car.type = 'sine'
  car.frequency.value = f
  const mod = ctx.createOscillator()
  mod.type = 'sine'
  mod.frequency.value = f * 2.0
  const mg = ctx.createGain()
  // 深度必须 < f，否则瞬时频率穿过 0 变负（频谱折叠，听感发浊）
  mg.gain.setValueAtTime(f * 0.85, when)
  mg.gain.exponentialRampToValueAtTime(f * 0.04, when + 0.32)
  mod.connect(mg)
  mg.connect(car.frequency)

  const tail = when + Math.max(dur, 0.45) + 0.75
  const cg = ctx.createGain()
  cg.gain.setValueAtTime(0.0001, when)
  cg.gain.linearRampToValueAtTime(1, when + 0.004)
  cg.gain.exponentialRampToValueAtTime(0.38, when + 0.28)
  cg.gain.exponentialRampToValueAtTime(0.0001, tail)
  car.connect(cg)
  cg.connect(out)

  // 音叉那声「叮」：短促高频分音，只负责颗粒感
  const tin = ctx.createOscillator()
  tin.type = 'sine'
  tin.frequency.value = f * 7.02
  const tg = ctx.createGain()
  tg.gain.setValueAtTime(0.0001, when)
  tg.gain.linearRampToValueAtTime(0.09 * vel, when + 0.002)
  tg.gain.exponentialRampToValueAtTime(0.0001, when + 0.13)
  tin.connect(tg)
  tg.connect(out)

  car.start(when)
  mod.start(when)
  tin.start(when)
  car.stop(tail + 0.05)
  mod.stop(tail + 0.05)
  tin.stop(when + 0.2)
}

/* ============================================================
   长笛（奇次谐波 + 气声 + 渐入抖音）
   ============================================================ */

export const vFlute: VoiceFn = (env, dest, when, midi, vel, dur) => {
  const { ctx, noise } = env
  const f = mtof(midi)
  const sus = vel * 0.2

  const o1 = ctx.createOscillator()
  o1.type = 'sine'
  o1.frequency.value = f
  const o2 = ctx.createOscillator()
  o2.type = 'sine'
  o2.frequency.value = f * 2.002
  const o3 = ctx.createOscillator()
  o3.type = 'triangle'
  o3.frequency.value = f * 3.004

  const g1 = ctx.createGain()
  g1.gain.value = 1.0
  const g2 = ctx.createGain()
  g2.gain.value = 0.15
  const g3 = ctx.createGain()
  g3.gain.value = 0.045

  // 气声：窄带噪声，进气那一瞬最明显
  const ns = ctx.createBufferSource()
  ns.buffer = noise
  ns.loop = true
  const nf = ctx.createBiquadFilter()
  nf.type = 'bandpass'
  nf.frequency.value = 2300 + f * 0.4
  nf.Q.value = 1.4
  const ng = ctx.createGain()

  // 抖音：起音后才渐入，深度随音高走
  const lfo = ctx.createOscillator()
  lfo.type = 'sine'
  lfo.frequency.value = 5.1 + Math.random() * 0.5
  const lfoG = ctx.createGain()
  const vibDepth = f * 0.0065

  const envG = ctx.createGain()
  const body = ctx.createBiquadFilter()
  body.type = 'lowpass'
  body.frequency.value = Math.min(9000, f * 6 + 1800)

  const attack = Math.min(0.055, dur * 0.35 + 0.012)
  const rel = Math.min(0.16, dur * 0.5 + 0.03)
  const endT = when + Math.max(dur, attack + 0.06)

  envG.gain.setValueAtTime(0, when)
  envG.gain.linearRampToValueAtTime(sus * 1.18, when + attack)
  envG.gain.linearRampToValueAtTime(sus, when + Math.min(attack + 0.1, dur * 0.7 + 0.02))
  envG.gain.setTargetAtTime(0.0001, when + Math.max(attack + 0.02, dur * 0.94), rel * 0.4)

  ng.gain.setValueAtTime(0, when)
  ng.gain.linearRampToValueAtTime(sus * 0.42, when + 0.012)
  ng.gain.exponentialRampToValueAtTime(0.0001, when + Math.max(0.09, dur * 0.85))

  lfoG.gain.setValueAtTime(0, when)
  lfoG.gain.linearRampToValueAtTime(vibDepth, when + Math.min(0.42, dur * 0.8 + 0.1))
  lfo.connect(lfoG)
  lfoG.connect(o1.frequency)
  lfoG.connect(o2.frequency)
  lfoG.connect(o3.frequency)

  o1.connect(g1)
  o2.connect(g2)
  o3.connect(g3)
  g1.connect(body)
  g2.connect(body)
  g3.connect(body)
  body.connect(envG)
  ns.connect(nf)
  nf.connect(ng)
  ng.connect(envG)
  envG.connect(dest)

  const stopT = endT + rel + 0.12
  o1.start(when)
  o2.start(when)
  o3.start(when)
  lfo.start(when)
  ns.start(when)
  o1.stop(stopT)
  o2.stop(stopT)
  o3.stop(stopT)
  lfo.stop(stopT)
  ns.stop(stopT)
}

/* ============================================================
   打击 / 键盘类
   ============================================================ */

/** 马林巴：泛音比 1 : 4 : 9（木琴类乐器的物理特征），起音带木槌闷响 */
export const vMarimba: VoiceFn = (env, dest, when, midi, vel, bright) => {
  const { ctx } = env
  const f = mtof(midi)
  const out = ctx.createGain()
  out.gain.value = vel * 0.2
  out.connect(dest)

  const decay = Math.max(0.22, 0.46 - Math.max(0, midi - 55) * 0.006)
  const PARTS: readonly (readonly [number, number, number])[] = [
    [1, 1.0, 1.0],
    [4, 0.14 + 0.18 * bright, 0.42],
    [9, 0.02 + 0.07 * bright, 0.22],
  ]
  for (const [h, amp, dm] of PARTS) {
    if (f * h > 13000) continue
    const end = when + decay * dm
    const o = ctx.createOscillator()
    o.type = 'sine'
    o.frequency.value = f * h
    const g = ctx.createGain()
    g.gain.setValueAtTime(0.0001, when)
    g.gain.linearRampToValueAtTime(amp, when + 0.004)
    g.gain.exponentialRampToValueAtTime(0.0001, end)
    o.connect(g)
    g.connect(out)
    o.start(when)
    o.stop(end + 0.05)
  }
  noiseHit(env, out, when, 700 + bright * 900, 0.7, 0.035, 0.1 * vel, 'lowpass')
}

/** 钢片琴：基频主导 + 4 倍频金属分音，全正弦、零噪声 */
export const vCelesta: VoiceFn = (env, dest, when, midi, vel) => {
  const { ctx } = env
  const f = mtof(midi)
  const out = ctx.createGain()
  out.gain.value = vel * 0.24
  out.connect(dest)
  const base = Math.max(0.6, 1.35 - Math.max(0, midi - 60) * 0.012)
  const PARTS: readonly (readonly [number, number, number])[] = [
    [1, 1.0, 1.0],
    [2, 0.16, 0.62],
    [4, 0.22, 0.4],
  ]
  for (const [h, amp, dm] of PARTS) {
    if (f * h > 13000) continue
    const end = when + Math.max(0.5, base * dm * 1.3)
    const o = ctx.createOscillator()
    o.type = 'sine'
    o.frequency.value = f * h
    const g = ctx.createGain()
    g.gain.setValueAtTime(0.0001, when)
    g.gain.linearRampToValueAtTime(amp, when + 0.003)
    g.gain.exponentialRampToValueAtTime(0.0001, end)
    o.connect(g)
    g.connect(out)
    o.start(when)
    o.stop(end + 0.05)
  }
}

/** 八音盒：梳齿的非谐泛音 1 : 3.01 : 5.42 : 8.93，起音极短、衰减快 */
export const vMusicBox: VoiceFn = (env, dest, when, midi, vel) => {
  const { ctx } = env
  const f = mtof(midi)
  const out = ctx.createGain()
  out.gain.value = vel * 0.22
  out.connect(dest)
  const base = Math.max(0.55, 0.98 - Math.max(0, midi - 60) * 0.008)
  const P: readonly (readonly [number, number, number])[] = [
    [1, 1.0, 1.0],
    [3.01, 0.26, 0.55],
    [5.42, 0.1, 0.34],
    [8.93, 0.04, 0.2],
  ]
  for (const [ratio, amp, dm] of P) addPartial(env, out, when, f, ratio, amp, dm, base, 0.002)
}

/** 颤音琴：1 : 4 泛音 + 4.6Hz 振幅摆动（±16%） */
export const vVibes: VoiceFn = (env, dest, when, midi, vel) => {
  const { ctx } = env
  const f = mtof(midi)
  const out = ctx.createGain()
  out.gain.value = vel * 0.24
  out.connect(dest)
  const base = Math.max(1.2, 2.6 - Math.max(0, midi - 55) * 0.016)
  addPartial(env, out, when, f, 1, 1.0, 1.0, base, 0.004)
  addPartial(env, out, when, f, 4.0, 0.12, 0.5, base, 0.004)
  const lfo = ctx.createOscillator()
  lfo.type = 'sine'
  lfo.frequency.value = 4.6 + Math.random() * 0.5
  const lg = ctx.createGain()
  lg.gain.value = vel * 0.24 * 0.16
  lfo.connect(lg)
  lg.connect(out.gain)
  lfo.start(when)
  lfo.stop(when + base + 0.2)
}

/** 竖琴：整数谐波、柔和起音、长衰减，比钢弦吉他少一层拨子噪声 */
export const vHarp: VoiceFn = (env, dest, when, midi, vel) => {
  const { ctx } = env
  const f = mtof(midi)
  const out = ctx.createGain()
  out.gain.value = vel * 0.19
  out.connect(dest)
  const base = Math.max(1.2, 2.2 - Math.max(0, midi - 55) * 0.012)
  const P: readonly (readonly [number, number, number])[] = [
    [1, 1.0, 1.0],
    [2, 0.42, 0.7],
    [3, 0.2, 0.52],
    [4, 0.1, 0.4],
    [5, 0.05, 0.3],
  ]
  for (const [ratio, amp, dm] of P) addPartial(env, out, when, f, ratio, amp, dm, base, 0.005)
}

/* ============================================================
   和声床 / 打击垫
   ============================================================ */

/** 和声床：正弦 + 微失谐三角，慢起慢落 */
export function vPad(env: AudioEnv, dest: AudioNode, when: number, midi: number, dur: number, vel: number): void {
  const { ctx } = env
  const o1 = ctx.createOscillator()
  o1.type = 'sine'
  o1.frequency.value = mtof(midi)
  const o2 = ctx.createOscillator()
  o2.type = 'triangle'
  o2.frequency.value = mtof(midi) * 1.003
  const lp = ctx.createBiquadFilter()
  lp.type = 'lowpass'
  lp.frequency.value = 1100
  const g = ctx.createGain()
  g.gain.setValueAtTime(0, when)
  g.gain.linearRampToValueAtTime(vel, when + dur * 0.35)
  g.gain.linearRampToValueAtTime(vel * 0.7, when + dur * 0.75)
  g.gain.linearRampToValueAtTime(0, when + dur)
  o1.connect(lp)
  o2.connect(lp)
  lp.connect(g)
  g.connect(dest)
  o1.start(when)
  o2.start(when)
  o1.stop(when + dur + 0.1)
  o2.stop(when + dur + 0.1)
}

/** 沙锤：高通 + 带通噪声，极短 */
export function shaker(env: AudioEnv, dest: AudioNode, when: number, vel: number): void {
  const { ctx, noise } = env
  const s = ctx.createBufferSource()
  s.buffer = noise
  s.loop = true
  const hp = ctx.createBiquadFilter()
  hp.type = 'highpass'
  hp.frequency.value = 5200
  const bp = ctx.createBiquadFilter()
  bp.type = 'bandpass'
  bp.frequency.value = 8200
  bp.Q.value = 1.2
  const g = ctx.createGain()
  g.gain.setValueAtTime(0, when)
  g.gain.linearRampToValueAtTime(vel * 0.095, when + 0.005)
  g.gain.exponentialRampToValueAtTime(0.0001, when + 0.09)
  s.connect(hp)
  hp.connect(bp)
  bp.connect(g)
  g.connect(dest)
  s.start(when)
  s.stop(when + 0.12)
}

/* ============================================================
   音色表
   ============================================================ */

/** 单音色：`fn` 统一签名 */
export const VOICE: Record<string, { name: string; fn: VoiceFn }> = {
  piano: { name: '原声钢琴', fn: vPiano },
  pianoSoft: { name: '柔钢琴', fn: vPianoSoft },
  epiano: { name: '电钢琴', fn: vEPiano },
  celesta: { name: '钢片琴', fn: vCelesta },
  musicbox: { name: '八音盒', fn: vMusicBox },
  vibes: { name: '颤音琴', fn: vVibes },
  guitar: { name: '钢弦吉他', fn: vGuitar },
  harp: { name: '竖琴', fn: vHarp },
  flute: { name: '长笛', fn: vFlute },
  marimba: { name: '马林巴', fn: vMarimba },
}

/** 叠加音色：只在主旋律下拉里出现，伴奏用会太厚 */
export const COMBO: Record<string, { name: string; fn: VoiceFn }> = {
  pianoGuitar: {
    name: '钢琴 + 吉他',
    fn: (env, dest, when, midi, vel, dur, bright) => {
      vPiano(env, dest, when, midi, vel, dur, bright)
      vGuitar(env, dest, when, midi, vel * 0.72, dur, bright)
    },
  },
  flutePiano: {
    name: '长笛 + 钢琴',
    fn: (env, dest, when, midi, vel, dur, bright) => {
      vFlute(env, dest, when, midi, vel, dur, bright)
      vPianoSoft(env, dest, when, midi, vel * 0.62, dur, bright)
    },
  },
}

/** 音色名表（设置面板与调试用） */
export const INST_LABEL: Record<string, string> = (() => {
  const o: Record<string, string> = {}
  for (const k of Object.keys(VOICE)) o[k] = (VOICE[k] as { name: string }).name
  for (const k of Object.keys(COMBO)) o[k] = (COMBO[k] as { name: string }).name
  return o
})()

/** 按名字发声；未知名字退回原声钢琴 */
export function playVoice(
  kind: string,
  env: AudioEnv,
  dest: AudioNode,
  when: number,
  midi: number,
  vel: number,
  dur: number,
  bright: number,
): void {
  const e = VOICE[kind] ?? COMBO[kind] ?? (VOICE.piano as { fn: VoiceFn })
  e.fn(env, dest, when, midi, vel, dur, bright)
}

/* ============================================================
   渲染器接口：让 BGM 可以在「原生合成」与「Tone.js」之间切换
   ============================================================ */

export interface MusicRenderer {
  voice(env: AudioEnv, dest: AudioNode, when: number, midi: number, vel: number, dur: number, bright: number, kind: string): void
  pad(env: AudioEnv, dest: AudioNode, when: number, midi: number, dur: number, vel: number): void
  shaker(env: AudioEnv, dest: AudioNode, when: number, vel: number): void
}

/** 原生后端：手写加法/FM/Karplus 合成 */
export const nativeRenderer: MusicRenderer = {
  voice: (env, dest, when, midi, vel, dur, bright, kind) => playVoice(kind, env, dest, when, midi, vel, dur, bright),
  pad: (env, dest, when, midi, dur, vel) => vPad(env, dest, when, midi, dur, vel),
  shaker: (env, dest, when, vel) => shaker(env, dest, when, vel),
}
