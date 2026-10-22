import { describe, it, expect } from 'vitest'

/**
 * M1 冒烟测试：只验证测试链路通。
 * M2 开始后，这里的用例会被 tests/core/*.test.ts 取代。
 */
describe('M1 工程骨架', () => {
  it('vitest 能跑通', () => {
    expect(1 + 1).toBe(2)
  })

  it('ES2022 语法可用', () => {
    const o = { a: 1 }
    expect(o?.a ?? 0).toBe(1)
  })
})
