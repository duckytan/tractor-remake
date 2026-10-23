/**
 * 实时合法性徽标（`ui/render.ts` 的 `legalityBadgeOf`）
 *
 * 覆盖 PlayResult 的三个形态 → 徽标 HTML 的映射：
 *   ① 直接合法            → is-ok「✓ 可以出」
 *   ② 甩牌失败被裁剪      → is-warn「⚠ …（将只出 N 张）」—— v1.3.1 修复：
 *      以前 adjusted 也走 is-ok，玩家选 6 张甩牌看到「可以出」，
 *      点下去只掉最小的 2 张，观感像 bug。
 *   ③ 不合法              → is-bad「✕ 原因」
 *
 * 直接构造 PlayResult 对象即可，不需要 GameState —— 这正是把它抽成
 * 导出纯函数的目的。
 */

import { describe, expect, it } from 'vitest'
import type { Card, PlayResult } from '@core'
import { legalityBadgeOf } from '@ui/render'

/** 造几张占位牌（映射函数只看 cards.length，牌值无所谓） */
const cards = (n: number): readonly Card[] =>
  Array.from({ length: n }, (_, i) => ({ id: i + 1, value: 10 + i }))

describe('legalityBadgeOf', () => {
  it('直接合法：绿色「✓ 可以出」', () => {
    const result: PlayResult = { ok: true, cards: cards(3) }
    const html = legalityBadgeOf(result)
    expect(html).toContain('legality is-ok')
    expect(html).toContain('✓ 可以出')
    expect(html).not.toContain('is-warn')
    expect(html).not.toContain('is-bad')
  })

  it('甩牌失败被裁剪：琥珀色警告，且明确「将只出 N 张」', () => {
    // 与 core 的 describeFailure 真实文案一致（throw-failed）
    const result: PlayResult = {
      ok: true,
      cards: cards(2),
      adjusted: true,
      reason: 'throw-failed',
      detail: '甩牌失败：有对子不是最大，只能出最小的那一对',
    }
    const html = legalityBadgeOf(result)
    expect(html).toContain('legality is-warn')
    expect(html).toContain('⚠')
    expect(html).toContain('甩牌失败：有对子不是最大，只能出最小的那一对')
    expect(html).toContain('将只出 2 张')
    expect(html).not.toContain('is-ok')
    expect(html).not.toContain('is-bad')
  })

  it('不合法：红色「✕ 原因」，detail 原样出现', () => {
    const result: PlayResult = {
      ok: false,
      reason: 'must-follow-suit',
      detail: '有该花色时必须跟满 3 张（你出了 2 张）',
    }
    const html = legalityBadgeOf(result)
    expect(html).toContain('legality is-bad')
    expect(html).toContain('✕')
    expect(html).toContain('有该花色时必须跟满 3 张（你出了 2 张）')
    expect(html).not.toContain('is-ok')
    expect(html).not.toContain('is-warn')
  })

  it('不合法且 detail 含 HTML 特殊字符时转义，不注入标签', () => {
    const result: PlayResult = {
      ok: false,
      reason: 'cards-not-in-hand',
      detail: '<script>alert(1)</script>',
    }
    const html = legalityBadgeOf(result)
    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script&gt;')
  })
})
