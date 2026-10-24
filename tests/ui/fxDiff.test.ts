import { describe, expect, it } from 'vitest'
import { C } from '../core/helpers'
import { justResolved, newPlaysSince } from '@ui/fxDiff'
import type { PlayLike } from '@ui/fxDiff'

/**
 * 卡牌动画的前后帧判断（ADR-017）。
 *
 * 这两个函数决定「哪张牌要飞」「要不要播收墩」，错一个就会：
 * ① 每帧都重飞同一张牌（画面抖动）；② 收墩动画永不触发 / 开局误触发。
 */

const p = (seat: 0 | 1 | 2 | 3, ...values: number[]): PlayLike => ({
  seat,
  cards: values.map((v) => C(Math.floor(v / 13) as 0 | 1 | 2 | 3, (v % 13) as 0)),
})

describe('newPlaysSince', () => {
  it('上一帧没有出牌 ⇒ 全部算新出', () => {
    const out = newPlaysSince([], [p(0, 0), p(1, 13)])
    expect(out.map((x) => x.seat)).toEqual([0, 1])
    expect(out[0]?.cards).toHaveLength(1)
  })

  it('同一家同一手牌重复出现 ⇒ 不算新出（避免每帧重飞）', () => {
    const prev = [p(0, 0)]
    const next = [p(0, 0), p(1, 13)]
    const out = newPlaysSince(prev, next)
    expect(out.map((x) => x.seat)).toEqual([1])
  })

  it('对子 / 连对按张比较：只飞新增的那几张', () => {
    // 上一帧出了 1 张，这一帧变成同家 2 张（理论上不会发生，但比较逻辑要稳）
    const out = newPlaysSince([p(0, 0)], [p(0, 0, 1)])
    expect(out).toHaveLength(1)
    expect(out[0]?.cards).toHaveLength(1)
    expect(out[0]?.cards[0]?.id).toBe(C(0, 1).id)
  })

  it('悔牌后重出不同的牌 ⇒ 新牌算新出', () => {
    const out = newPlaysSince([p(0, 0)], [p(0, 26)])
    expect(out).toHaveLength(1)
    expect(out[0]?.cards[0]?.value).toBe(26)
  })

  it('完全没变化 ⇒ 空数组', () => {
    const same = [p(0, 0), p(1, 13), p(2, 26), p(3, 39)]
    expect(newPlaysSince(same, same)).toEqual([])
  })
})

describe('justResolved', () => {
  it('history 变长且上一帧本墩有牌 ⇒ 刚结算', () => {
    expect(justResolved(2, [p(0, 0), p(1, 13)], 3)).toBe(true)
  })

  it('上一帧本墩没有牌 ⇒ 不算结算（开局 / 读档的 history 0→1 不该播收墩）', () => {
    expect(justResolved(0, [], 1)).toBe(false)
  })

  it('history 没变长 ⇒ 不算结算', () => {
    expect(justResolved(2, [p(0, 0)], 2)).toBe(false)
  })

  it('history 变短（悔牌）⇒ 不算结算', () => {
    expect(justResolved(3, [p(0, 0)], 2)).toBe(false)
  })
})
