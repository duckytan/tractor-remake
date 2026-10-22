import { describe, it, expect } from 'vitest'
import { mulberry32, shuffle } from '@core/rng'

describe('mulberry32', () => {
  it('同种子产生同一序列（可复现，NFR-06）', () => {
    const a = mulberry32(12345)
    const b = mulberry32(12345)
    const seqA = Array.from({ length: 20 }, () => a.next())
    const seqB = Array.from({ length: 20 }, () => b.next())
    expect(seqA).toEqual(seqB)
  })

  it('不同种子产生不同序列', () => {
    const a = mulberry32(1)
    const b = mulberry32(2)
    const seqA = Array.from({ length: 20 }, () => a.next())
    const seqB = Array.from({ length: 20 }, () => b.next())
    expect(seqA).not.toEqual(seqB)
  })

  it('next() 落在 [0, 1)', () => {
    const r = mulberry32(7)
    for (let i = 0; i < 5000; i++) {
      const x = r.next()
      expect(x).toBeGreaterThanOrEqual(0)
      expect(x).toBeLessThan(1)
    }
  })

  it('int(n) 落在 [0, n) 且是整数', () => {
    const r = mulberry32(99)
    for (let i = 0; i < 5000; i++) {
      const x = r.int(6)
      expect(Number.isInteger(x)).toBe(true)
      expect(x).toBeGreaterThanOrEqual(0)
      expect(x).toBeLessThan(6)
    }
  })

  it('int(n) 覆盖全部取值（不偏科）', () => {
    const r = mulberry32(2024)
    const hits = new Array(6).fill(0)
    const N = 6000
    for (let i = 0; i < N; i++) hits[r.int(6)]! += 1
    for (const h of hits) {
      // 期望 1000，允许 ±25%
      expect(h).toBeGreaterThan(N / 6 * 0.75)
      expect(h).toBeLessThan(N / 6 * 1.25)
    }
  })

  it('int(0) 与非法参数抛错', () => {
    const r = mulberry32(1)
    expect(() => r.int(0)).toThrow()
    expect(() => r.int(-3)).toThrow()
    expect(() => r.int(1.5)).toThrow()
  })
})

describe('shuffle', () => {
  it('同种子得到同一排列', () => {
    const arr = Array.from({ length: 108 }, (_, i) => i)
    expect(shuffle(arr, mulberry32(42))).toEqual(shuffle(arr, mulberry32(42)))
  })

  it('是一个排列：元素不重不漏', () => {
    const arr = Array.from({ length: 108 }, (_, i) => i)
    const out = shuffle(arr, mulberry32(7))
    expect(out).toHaveLength(108)
    expect([...out].sort((a, b) => a - b)).toEqual(arr)
  })

  it('不修改入参', () => {
    const arr = Object.freeze([1, 2, 3, 4, 5]) as readonly number[]
    expect(() => shuffle(arr, mulberry32(1))).not.toThrow()
    expect(arr).toEqual([1, 2, 3, 4, 5])
  })

  it('空数组与单元素不出错', () => {
    expect(shuffle([], mulberry32(1))).toEqual([])
    expect(shuffle([9], mulberry32(1))).toEqual([9])
  })

  it('洗牌确实打乱了（首元素不完全固定）', () => {
    const arr = Array.from({ length: 20 }, (_, i) => i)
    const firsts = new Set<number>()
    for (let s = 0; s < 50; s++) firsts.add(shuffle(arr, mulberry32(s))[0] as number)
    expect(firsts.size).toBeGreaterThan(5)
  })
})
