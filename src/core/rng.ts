/**
 * 随机源 —— 显式注入。
 * core 里禁止直接调用全局随机函数，否则「同种子可复现」无法保证（NFR-06）。
 * 对应 docs/04 §10、ADR-004。
 */

export interface Rng {
  /** [0, 1) */
  next(): number
  /** [0, n) 的整数 */
  int(n: number): number
}

/**
 * mulberry32 —— 32 位种子，周期 2^32，分布足够好，实现 6 行。
 * 选它的理由：无依赖、可复现、速度快；本项目不需要密码学强度。
 */
export function mulberry32(seed: number): Rng {
  let a = seed >>> 0
  const next = (): number => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  return {
    next,
    int(n: number): number {
      if (!Number.isInteger(n) || n <= 0) throw new Error(`Rng.int: n 必须是正整数，收到 ${n}`)
      return Math.floor(next() * n)
    },
  }
}

/** Fisher-Yates，返回新数组，不修改入参 */
export function shuffle<T>(arr: readonly T[], rng: Rng): T[] {
  const out = arr.slice()
  for (let i = out.length - 1; i > 0; i--) {
    const j = rng.int(i + 1)
    const tmp = out[i] as T
    out[i] = out[j] as T
    out[j] = tmp
  }
  return out
}
