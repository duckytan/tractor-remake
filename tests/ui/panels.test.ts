import { describe, expect, it } from 'vitest'
import { DEFAULT_RULE_CONFIG } from '@core'
import type { SettleResult } from '@core'
import { newGame } from '@app/game'
import type { GameState } from '@app/state'
import { confirmNewPanel, settingsPanel, settlePanel } from '@ui/render'

/**
 * 结算 / 确认面板是纯字符串构建，可以直接断言内容
 * （思路同 `tests/ui/handFit.test.ts`：把可纯测的部分抽出来测，不引入 jsdom）。
 */

const base = (): GameState => newGame(DEFAULT_RULE_CONFIG, 1, 420, 7)

const settle = (patch: Partial<SettleResult> = {}): SettleResult => ({
  defenderScore: 50,
  levelUpTeam: 0,
  levels: 1,
  actualLevels: 1,
  newLevels: { a: 3, b: 2 },
  dealerChanged: false,
  newDealer: 2,
  gameOver: false,
  ...patch,
})

describe('confirmNewPanel', () => {
  it('出牌阶段：显示第几局 / 第几墩 + 两个按钮', () => {
    const s: GameState = { ...base(), phase: 'play', round: 2, tricksDone: 3, confirmNew: true }
    const html = confirmNewPanel(s)
    expect(html).toContain('重新开局？')
    expect(html).toContain('第 2 局')
    expect(html).toContain('第 4 墩')
    expect(html).toContain('data-act="cancelNew"')
    expect(html).toContain('data-act="confirmNew"')
  })

  it('埋底阶段：进度文案是「还没扣底」', () => {
    const s: GameState = { ...base(), phase: 'bury', confirmNew: true }
    expect(confirmNewPanel(s)).toContain('还没扣底')
  })
})

describe('settlePanel', () => {
  it('普通结算：标题 / 得分 / 下一局 / 查看记录入口', () => {
    const s: GameState = { ...base(), phase: 'settle', lastSettle: settle() }
    const html = settlePanel(s)
    expect(html).toContain('本局结算')
    expect(html).toContain('50')
    expect(html).toContain('下一局')
    expect(html).toContain('data-act="toggleLog"')
    expect(html).toContain('data-act="nextRound"')
  })

  it('必打截断时多一行说明', () => {
    const s: GameState = {
      ...base(),
      phase: 'settle',
      lastSettle: settle({ levels: 2, actualLevels: 1, guardLevel: 11 }),
    }
    expect(settlePanel(s)).toContain('必打截断')
  })

  it('已在打王时赢下：说明「终点级」而不是含糊的「实际升 0 级」', () => {
    const s: GameState = {
      ...base(),
      phase: 'settle',
      // 闲家（队 0）已在打王，赢下只上台不升级 ⇒ actualLevels 0、无 guardLevel
      lastSettle: settle({
        levels: 1,
        actualLevels: 0,
        newLevels: { a: 18, b: 5 },
        dealerChanged: true,
      }),
    }
    const html = settlePanel(s)
    expect(html).toContain('终点级')
    expect(html).toContain('坐庄赢下即通关')
    expect(html).not.toContain('必打截断')
  })

  it('终局：标题改成「游戏结束 · X 队获胜」+ 再来一局', () => {
    const s: GameState = {
      ...base(),
      phase: 'over',
      lastSettle: settle({ gameOver: true, winnerTeam: 1 }),
    }
    const html = settlePanel(s)
    expect(html).toContain('游戏结束')
    expect(html).toContain('队B 获胜')
    expect(html).toContain('再来一局')
  })

  it('没有结算数据时不渲染（防空）', () => {
    expect(settlePanel({ ...base(), lastSettle: null })).toBe('')
  })
})

describe('设置面板 · 声音分组', () => {
  it('音乐主题是下拉框，四个季节都在，默认选中春', () => {
    const html = settingsPanel(base())
    expect(html).toContain('音乐主题')
    expect(html).toContain('data-sound="theme"')
    for (const name of ['春 · 萌动', '夏 · 灼日', '秋 · 落叶', '冬 · 静雪']) expect(html).toContain(name)
    // 默认 spring 带 selected
    expect(html).toMatch(/<option value="spring"[^>]*selected/)
  })

  it('音量三项默认 75 / 40 / 80', () => {
    const html = settingsPanel(base())
    expect(html).toMatch(/data-vol="master"[^>]*value="75"|value="75"[^>]*data-vol="master"/)
    expect(html).toMatch(/data-vol="bgm"[^>]*value="40"|value="40"[^>]*data-vol="bgm"/)
    expect(html).toMatch(/data-vol="sfx"[^>]*value="80"|value="80"[^>]*data-vol="sfx"/)
  })

  /**
   * 取包含 marker 的那个 `<button ...>` 开标签（属性顺序无关）。
   *
   * v1.3.29 改成正则：开关的 `data-act` 现在**同时挂在整行和按钮上**
   * （点行文字也能切换，见 docs/37 E-3），旧实现用 `indexOf` 会先命中
   * `<div class="set-row" data-act=...>`，再 `lastIndexOf('<button')` 就串到上一行了。
   */
  const btnTag = (html: string, marker: string): string => {
    const escaped = marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const re = new RegExp(`<button[^>]*${escaped}[^>]*>`)
    return re.exec(html)?.[0] ?? ''
  }

  it('两个开关默认：增强音效关、自动变奏开', () => {
    const html = settingsPanel(base())
    expect(btnTag(html, 'data-act="toggleSoundEnhanced"')).toContain('aria-checked="false"')
    expect(btnTag(html, 'data-act="toggleAutoVariation"')).toContain('aria-checked="true"')
  })

  it('分组顺序：牌局 → 画面 → 声音 → 规则（顺序按改动频率）', () => {
    const html = settingsPanel(base())
    const at = (t: string): number => html.indexOf(`<h3>${t}<small>`)
    const order = ['牌局', '画面', '声音', '规则'].map(at)
    expect(order.every((i) => i > -1)).toBe(true)
    expect(order).toEqual([...order].sort((a, b) => a - b))
  })

  it('每组标题都写明「什么时候生效」', () => {
    const html = settingsPanel(base())
    expect(html).toContain('<h3>牌局<small>对手强度与节奏 · 立即生效</small>')
    expect(html).toContain('<h3>画面<small>视觉与操作辅助 · 立即生效</small>')
    expect(html).toContain('<h3>声音<small>BGM 与音效 · 立即生效</small>')
    expect(html).toContain('<h3>规则<small>改完下一局生效</small>')
  })

  it('标签页：4 个 tab，默认选中「牌局」，每组挂在对应 tab 下', () => {
    const html = settingsPanel(base())
    expect(html).toContain('role="tablist"')
    for (const [key, label] of [
      ['game', '牌局'],
      ['view', '画面'],
      ['sound', '声音'],
      ['rule', '规则'],
    ]) {
      expect(html).toContain(`data-act="settingsTab" data-val="${key}"`)
      expect(html).toContain(`>${label}</button>`)
      expect(html).toContain(`data-tab="${key}"`)
    }
    // 默认停在第一个 tab
    expect(html).toContain('data-settings-tab="game"')
    expect(html).toMatch(/data-val="game" aria-selected="true"/)
    expect(html).toMatch(/data-val="view" aria-selected="false"/)
  })

  it('组内有二级分类：音量 / 升级必打', () => {
    const html = settingsPanel(base())
    expect(html).toContain('<div class="set-sub">音量</div>')
    expect(html).toContain('升级必打')
    // 「升级必打」的就地说明取代了原来面板底部的 set-foot
    expect(html).toContain('升级时禁止跳级，与出牌无关')
    expect(html).not.toContain('class="set-foot"')
  })

  it('改了 state 后，下拉与滑条跟着变', () => {
    const s: GameState = { ...base(), musicTheme: 'winter', volumeMaster: 10, volumeBgm: 20, volumeSfx: 30 }
    const html = settingsPanel(s)
    expect(html).toMatch(/<option value="winter"[^>]*selected/)
    expect(html).toContain('value="10"')
    expect(html).toContain('value="20"')
    expect(html).toContain('value="30"')
  })
})

describe('设置面板 · 规则改动的「下一局生效」提示', () => {
  it('没有改动时不显示警告条（生效时机由各分组标题说明）', () => {
    const html = settingsPanel(base())
    expect(html).not.toContain('set-warn')
    // 规则分组的标题里已经写了「改完下一局生效」
    expect(html).toContain('改完下一局生效')
  })

  it('改了规则但本局未生效：列出改动项并说明本局仍按旧规则', () => {
    const s = base()
    const html = settingsPanel({
      ...s,
      pendingConfig: { ...s.pendingConfig, twoAsPermanent: !s.config.twoAsPermanent },
    })
    expect(html).toContain('set-warn')
    expect(html).toContain('2 为常主')
    expect(html).toContain('本局仍按旧规则')
  })

  it('多项改动会逐条列出', () => {
    const s = base()
    const html = settingsPanel({
      ...s,
      pendingConfig: {
        ...s.pendingConfig,
        twoAsPermanent: !s.config.twoAsPermanent,
        guardJack: !s.config.guardJack,
      },
    })
    expect(html).toContain('2 为常主')
    expect(html).toContain('J 必打')
  })

  it('只有体验项改动（声音/动画）不算规则改动', () => {
    const s = base()
    const html = settingsPanel({ ...s, volumeBgm: 10, animSpeed: 'fast' })
    expect(html).not.toContain('set-warn')
  })
})
