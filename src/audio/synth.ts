/**
 * 底层合成原语。所有音色都只靠这几个函数拼出来 —— 没有一个采样文件。
 *
 * 每个函数都显式接收 `AudioEnv`（上下文 + 预生成的噪声缓冲），
 * 不读任何模块级可变状态 ⇒ 可单测、可多实例。
 */

/** 一次合成都需要的两样东西 */
export interface AudioEnv {
  readonly ctx: AudioContext
  /** 2 秒白噪声缓冲，所有「打击感 / 气声 / 木槌」都从它取样 */
  readonly noise: AudioBuffer
}

/** MIDI → 频率 */
export function mtof(m: number): number {
  return 440 * Math.pow(2, (m - 69) / 12)
}

export function clamp(x: number, a: number, b: number): number {
  return Math.max(a, Math.min(b, x))
}

/**
 * 确定性伪随机（xorshift32）。
 * 同一个小节每次生成的抖动完全一致 ⇒ 听感可复现，不会越听越乱。
 */
export function makeRng(seed: number): () => number {
  let s = (seed >>> 0) || 1
  return () => {
    s ^= s << 13
    s >>>= 0
    s ^= s >> 17
    s ^= s << 5
    s >>>= 0
    return s / 4294967296
  }
}

/* ============================================================
   缓冲生成
   ============================================================ */

/** 合成混响 IR：指数衰减噪声 + 一阶低通（逐采样递推，避免大量 Math.pow） */
export function makeIR(c: BaseAudioContext, sec: number, decay: number, lp: number): AudioBuffer {
  const len = Math.floor(c.sampleRate * sec)
  const buf = c.createBuffer(2, len, c.sampleRate)
  const step = Math.exp(-decay / len)
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch)
    let z = 0
    let env = 1
    for (let i = 0; i < len; i++) {
      const w = Math.random() * 2 - 1
      z += lp * (w - z)
      d[i] = z * env
      env *= step
    }
    // 前 20ms 压一下，避免起音爆点
    const fade = Math.floor(c.sampleRate * 0.02)
    for (let i = 0; i < fade; i++) (d[i] as number) && (d[i] = (d[i] as number) * 0.4)
  }
  return buf
}

/** 预生成噪声缓冲 */
export function makeNoise(c: BaseAudioContext, sec: number): AudioBuffer {
  const len = Math.floor(c.sampleRate * sec)
  const b = c.createBuffer(1, len, c.sampleRate)
  const d = b.getChannelData(0)
  let z = 0
  for (let i = 0; i < len; i++) {
    z += 0.4 * (Math.random() * 2 - 1 - z)
    d[i] = z
  }
  return b
}

/* ============================================================
   Karplus-Strong 拨弦
   ============================================================ */

/** 拨弦缓冲长度（低音弦需要更长） */
export const PLUCK_SEC = 2.8

/**
 * 把 Karplus-Strong 直接渲进 buffer 的 channelData ——
 * 省掉一次等长 Float32Array 分配 + 整块拷贝。
 */
export function renderPluck(c: BaseAudioContext, buf: AudioBuffer, freq: number): void {
  const sr = c.sampleRate
  const out = buf.getChannelData(0)
  const D = sr / freq - 1.35
  const L = Math.ceil(D) + 4
  const line = new Float32Array(L)

  // 激励：低通白噪声
  let z = 0
  for (let i = 0; i < L; i++) {
    const w = Math.random() * 2 - 1
    z += 0.55 * (w - z)
    line[i] = z
  }
  // 梳状预滤波，去掉过亮的毛刺
  const P = Math.max(1, Math.round(D * 0.16))
  for (let i = L - 1; i >= P; i--) line[i] = (line[i] as number) - (line[i - P] as number) * 0.72

  // 延迟线 + 一阶低通反馈
  const R = 0.9965
  let w = 0
  let lp = 0
  const n = out.length
  for (let i = 0; i < n; i++) {
    const idx = i % L
    const v = line[idx] as number
    const y = v
    w = R * (y * 0.5 + lp * 0.5)
    lp = y
    line[idx] = w
    out[i] = y
  }
  // 尾部淡出，避免缓冲截断产生「啪」
  const tail = Math.min(n, Math.floor(sr * 0.05))
  for (let i = 0; i < tail; i++) out[n - 1 - i] = (out[n - 1 - i] as number) * (i / tail)
}

/* ============================================================
   通用发声积木
   ============================================================ */

/** 一根正弦分音：线性起音 + 指数衰减 */
export function addPartial(
  env: AudioEnv,
  out: AudioNode,
  when: number,
  f: number,
  ratio: number,
  amp: number,
  decayMul: number,
  base: number,
  attack: number,
): void {
  if (f * ratio > 14000) return
  const { ctx } = env
  const end = when + Math.max(0.22, base * decayMul)
  const o = ctx.createOscillator()
  o.type = 'sine'
  o.frequency.value = f * ratio
  const g = ctx.createGain()
  g.gain.setValueAtTime(0.0001, when)
  g.gain.linearRampToValueAtTime(amp, when + attack)
  g.gain.exponentialRampToValueAtTime(0.0001, end)
  o.connect(g)
  g.connect(out)
  o.start(when)
  o.stop(end + 0.05)
}

/** 噪声打击：带通/低通 + 极短包络 */
export function noiseHit(
  env: AudioEnv,
  dest: AudioNode,
  when: number,
  freq: number,
  q: number,
  dur: number,
  vel: number,
  type: BiquadFilterType = 'bandpass',
): void {
  const { ctx, noise } = env
  const s = ctx.createBufferSource()
  s.buffer = noise
  s.loop = true
  const f = ctx.createBiquadFilter()
  f.type = type
  f.frequency.value = freq
  f.Q.value = q
  const g = ctx.createGain()
  g.gain.setValueAtTime(0, when)
  g.gain.linearRampToValueAtTime(vel, when + 0.003)
  g.gain.exponentialRampToValueAtTime(0.0001, when + dur)
  s.connect(f)
  f.connect(g)
  g.connect(dest)
  s.start(when)
  s.stop(when + dur + 0.02)
}

/** 单个音高的短音（音效主力） */
export function ping(
  env: AudioEnv,
  dest: AudioNode,
  when: number,
  midi: number,
  dur: number,
  vel: number,
  bright: number,
  type: OscillatorType = 'triangle',
): void {
  const { ctx } = env
  const o = ctx.createOscillator()
  o.type = type
  o.frequency.value = mtof(midi)
  const lp = ctx.createBiquadFilter()
  lp.type = 'lowpass'
  lp.frequency.value = 1200 + bright * 7000
  const g = ctx.createGain()
  g.gain.setValueAtTime(0, when)
  g.gain.linearRampToValueAtTime(vel, when + 0.004)
  g.gain.exponentialRampToValueAtTime(0.0001, when + dur)
  o.connect(lp)
  lp.connect(g)
  g.connect(dest)
  o.start(when)
  o.stop(when + dur + 0.05)
}

/** 噪声扫频（出牌 / 悔牌共用，方向相反） */
export function sweep(
  env: AudioEnv,
  dest: AudioNode,
  when: number,
  f0: number,
  f1: number,
  dur: number,
  vel: number,
  q = 1.2,
): void {
  const { ctx, noise } = env
  const s = ctx.createBufferSource()
  s.buffer = noise
  s.loop = true
  const bp = ctx.createBiquadFilter()
  bp.type = 'bandpass'
  bp.Q.value = q
  bp.frequency.setValueAtTime(f0, when)
  bp.frequency.exponentialRampToValueAtTime(f1, when + dur * 0.7)
  const g = ctx.createGain()
  g.gain.setValueAtTime(0, when)
  g.gain.linearRampToValueAtTime(vel, when + 0.02)
  g.gain.exponentialRampToValueAtTime(0.0001, when + dur)
  s.connect(bp)
  bp.connect(g)
  g.connect(dest)
  s.start(when)
  s.stop(when + dur + 0.04)
}
