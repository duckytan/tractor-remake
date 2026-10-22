/**
 * 入口：装配 store + 渲染 + AI 调度
 */

import './ui/styles.css'

import { enumeratePlays } from '@ai/enumerate'
import type { PlayContext } from '@ai/enumerate'
import { checkPlay } from '@core'
import type { Card, Play } from '@core'
import { aiCanAct, newGame, reduce } from '@app/game'
import { clearState, loadPrefs, loadState, savePrefs, saveState } from '@app/persist'
import type { Action, GameState } from '@app/state'
import { HUMAN_SEAT, ctxOf, seatToPlay } from '@app/state'
import { render } from '@ui/render'

const root = document.getElementById('app')
if (!root) throw new Error('#app 未找到')

const prefs = loadPrefs()
const restored = loadState()
let state: GameState = restored ?? newGame(
  prefs.ruleConfig,
  prefs.aiLevel,
  prefs.aiSpeedMs,
)
// 体验项偏好覆盖存档（存档只存对局进度，体验项以偏好为准）
state = {
  ...state,
  fourColor: prefs.fourColor,
  cardSize: prefs.cardSize,
  animation: prefs.animation,
  pendingConfig: prefs.ruleConfig,
}

let aiTimer: number | null = null
let dealTimer: number | null = null

/** 逐张发牌的节奏（ms/张）。25 张约 1.4s */
const DEAL_INTERVAL_MS = 55

function scheduleAi(): void {
  if (aiTimer !== null) return
  if (!aiCanAct(state)) return
  aiTimer = window.setTimeout(() => {
    aiTimer = null
    if (!aiCanAct(state)) return
    state = reduce(state, { type: 'aiStep' })
    afterChange()
  }, Math.max(0, state.aiSpeedMs))
}

/**
 * 逐张发牌：只要还在发、且没有停下来等人决定，就继续下一张。
 * 人类摸到级牌时 `dealPrompt` 会置 true，这里自然停住。
 */
function scheduleDeal(): void {
  if (dealTimer !== null) return
  if (state.phase !== 'contract') return
  const total = (state.hands[HUMAN_SEAT] as readonly Card[]).length
  if (state.revealed >= total || state.dealPrompt) return
  dealTimer = window.setTimeout(() => {
    dealTimer = null
    if (state.phase !== 'contract') return
    const t = (state.hands[HUMAN_SEAT] as readonly Card[]).length
    if (state.revealed >= t || state.dealPrompt) return
    state = reduce(state, { type: 'revealTick' })
    afterChange()
  }, DEAL_INTERVAL_MS)
}

function afterChange(): void {
  saveState(state)
  savePrefs({
    aiLevel: state.aiLevel,
    aiSpeedMs: state.aiSpeedMs,
    fourColor: state.fourColor,
    ruleConfig: state.pendingConfig,
    cardSize: state.cardSize,
    animation: state.animation,
  })
  paint()
  scheduleDeal()
  scheduleAi()
}

function paint(): void {
  render(root as HTMLElement, state, { dispatch, hint })
}

function dispatch(a: Action): void {
  const prevPhase = state.phase
  // 任何主动操作都打断正在排队的发牌节奏，由 afterChange 重新判断
  if (dealTimer !== null) {
    window.clearTimeout(dealTimer)
    dealTimer = null
  }
  state = reduce(state, a)

  // 换局 / 新游戏时清掉旧存档
  if (a.type === 'newGame') clearState()
  if (prevPhase !== state.phase) {
    if (aiTimer !== null) {
      window.clearTimeout(aiTimer)
      aiTimer = null
    }
  }
  afterChange()
}

/**
 * 提示：高亮一手合法牌。
 *
 * FR-19 ③：**不改变游戏状态** —— 只做视觉高亮，不动 selected。
 * 早先这里派发 setSelection，会把用户已选好的牌覆盖掉，
 * 而且提示结果还会被 saveState 写进存档。
 */
function hint(): void {
  if (seatToPlay(state) !== HUMAN_SEAT) return
  const ctx = ctxOf(state)
  const hand = state.hands[HUMAN_SEAT] as readonly Card[]
  const leadPlay = state.trick.plays[0] as Play | undefined

  const pc: PlayContext = leadPlay
    ? { kind: 'follow', leadCards: leadPlay.cards, leadAnalysis: leadPlay.analysis }
    : { kind: 'lead' }

  const candidates = enumeratePlays(hand, ctx, pc, 40)
  for (const cards of candidates) {
    const r = checkPlay({
      hand,
      cards,
      ctx,
      ...(leadPlay ? { lead: { cards: leadPlay.cards, analysis: leadPlay.analysis } } : {}),
      opponents: [1, 2, 3].map((x) => state.hands[x] as readonly Card[]),
    })
    if (r.ok) {
      // 只高亮，不选中
      dispatch({ type: 'showHint', ids: r.cards.map((c) => c.id) })
      return
    }
  }
}

/* 键盘：空格出牌 / Esc 取消 / H 提示 / 回车选牌
 * NFR-10：全部操作可用键盘完成。 */
window.addEventListener('keydown', (ev) => {
  if (ev.repeat) return

  // 焦点在手牌上时，回车/空格切换选中，不触发出牌
  const onCard = ev.target instanceof HTMLElement && ev.target.closest('.card[data-id]')
  if (onCard && (ev.code === 'Enter' || ev.code === 'Space')) {
    ev.preventDefault()
    const id = Number((ev.target as HTMLElement).closest('.card[data-id]')?.getAttribute('data-id'))
    if (Number.isFinite(id)) dispatch({ type: 'toggleSelect', id })
    return
  }

  if (ev.code === 'Space') {
    ev.preventDefault()
    dispatch({ type: 'playSelected' })
  } else if (ev.code === 'Escape') {
    // 弹层优先关闭
    if (state.settingsOpen) dispatch({ type: 'closeSettings' })
    else if (state.logOpen) dispatch({ type: 'toggleLog' })
    else dispatch({ type: 'clearSelect' })
  } else if (ev.key === 'h' || ev.key === 'H') {
    hint()
  }
})

paint()
scheduleDeal()
scheduleAi()
