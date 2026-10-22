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
  {
    allowSelfCounter: true,
    twoAsPermanent: false,
    allowPartnerGuard: false,
    allowCounterNT: false,
    guardScoreLevels: false,
    guardJA: true,
    guardKingLevel: true,
  },
  prefs.aiLevel,
  prefs.aiSpeedMs,
)
state = { ...state, fourColor: prefs.fourColor }

let aiTimer: number | null = null

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

function afterChange(): void {
  saveState(state)
  savePrefs({ aiLevel: state.aiLevel, aiSpeedMs: state.aiSpeedMs, fourColor: state.fourColor })
  paint()
  scheduleAi()
}

function paint(): void {
  render(root as HTMLElement, state, { dispatch, hint })
}

function dispatch(a: Action): void {
  const prevPhase = state.phase
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

/** 提示：给出一手合法牌并选中 */
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
      dispatch({ type: 'setSelection', ids: r.cards.map((c) => c.id) })
      return
    }
  }
}

/* 键盘：空格出牌 / Esc 取消 / H 提示 */
window.addEventListener('keydown', (ev) => {
  if (ev.repeat) return
  if (ev.code === 'Space') {
    ev.preventDefault()
    dispatch({ type: 'playSelected' })
  } else if (ev.code === 'Escape') {
    dispatch({ type: 'clearSelect' })
  } else if (ev.key === 'h' || ev.key === 'H') {
    hint()
  }
})

paint()
scheduleAi()
