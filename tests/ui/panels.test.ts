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

  /** 取包含 marker 的那个 <button ...> 开标签（属性顺序无关） */
  const btnTag = (html: string, marker: string): string => {
    const i = html.indexOf(marker)
    if (i < 0) return ''
    return html.slice(html.lastIndexOf('<button', i), html.indexOf('>', i) + 1)
  }

  it('两个开关默认：增强音效关、自动变奏开', () => {
    const html = settingsPanel(base())
    expect(btnTag(html, 'data-act="toggleSoundEnhanced"')).toContain('aria-checked="false"')
    expect(btnTag(html, 'data-act="toggleAutoVariation"')).toContain('aria-checked="true"')
  })

  it('声音分组排在规则与体验之前（常用项不该藏在最底下）', () => {
    const html = settingsPanel(base())
    const iSound = html.indexOf('<h3>声音</h3>')
    const iRule = html.indexOf('<h3>规则</h3>')
    const iExp = html.indexOf('<h3>体验</h3>')
    expect(iSound).toBeGreaterThan(-1)
    expect(iRule).toBeGreaterThan(-1)
    expect(iExp).toBeGreaterThan(-1)
    expect(iSound).toBeLessThan(iRule)
    expect(iRule).toBeLessThan(iExp)
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
  it('没有改动时只显示普通说明，没有警告条', () => {
    const html = settingsPanel(base())
    expect(html).not.toContain('set-warn')
    expect(html).toContain('下一局')
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
