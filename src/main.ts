/**
 * 入口：装配 store + 渲染 + AI 调度
 */

import './ui/styles.css'

import { enumeratePlays } from '@ai/enumerate'
import type { PlayContext } from '@ai/enumerate'
import { checkPlay, DEAL_TOTAL } from '@core'
import type { Card, Play } from '@core'
import { aiCanAct, newGame, reduce } from '@app/game'
import { clearState, loadPrefs, loadState, savePrefs, saveState } from '@app/persist'
import { canUndo, emptyUndo, popUndo, pushUndo, shouldPush } from '@app/undo'
import type { Action, GameState } from '@app/state'
import type { Prefs } from '@app/persist'
import { ANIM_SPEED_SCALE, HUMAN_SEAT, ctxOf, seatToPlay } from '@app/state'
import { refitHand, render } from '@ui/render'
import { captureFx, setAnimScale, trackDealAnimation, trackPlayFx } from '@ui/dealFly'

const root = document.getElementById('app')
if (!root) throw new Error('#app 未找到')

const prefs = loadPrefs()
const restored = loadState()
let state: GameState = restored ?? newGame(
  prefs.ruleConfig,
  prefs.aiLevelOpponent,
  prefs.aiSpeedMs,
)
// 体验项偏好覆盖存档（存档只存对局进度，体验项以偏好为准）
state = {
  ...state,
  aiLevelPartner: prefs.aiLevelPartner,
  aiLevelOpponent: prefs.aiLevelOpponent,
  fourColor: prefs.fourColor,
  cardSize: prefs.cardSize,
  animation: prefs.animation,
  animSpeed: prefs.animSpeed,
  showHistory: prefs.showHistory,
  hintSelects: prefs.hintSelects,
  showCounter: prefs.showCounter,
  pendingConfig: prefs.ruleConfig,
}

let aiTimer: number | null = null
let dealTimer: number | null = null
/** 悔牌快照栈（不持久化，见 app/undo.ts） */
let undoStore = emptyUndo()

/**
 * 悔牌后给 AI 的**一次性**额外延迟（ms）。
 *
 * 悔牌会把本墩四家的出牌一起撤回（快照是整个 GameState），但撤销后若立刻轮到 AI，
 * 它会在 aiSpeedMs（420ms，速度设为 0 时瞬间）内把同样的牌重新放回来 ——
 * 画面上只剩玩家自己那张没回来，看起来像「悔牌只撤了自己的牌」（用户反馈）。
 * 这里先停一下，让「四家全部撤回」这件事看得见，再让 AI 重出。
 */
const UNDO_AI_HOLD_MS = 700
let aiHoldMs = 0

/** 逐张发牌的节奏（ms/张）。25 张约 1.4s */
const DEAL_INTERVAL_MS = 55

/**
 * 走一步状态机，并在「一墩的第一张牌」之前压一份快照。
 *
 * AI 与人类都走这里 —— 悔牌要把 AI 出的牌一起回退，
 * 所以压栈不能只挂在人类操作的 dispatch 上。
 */
function step(a: Action): void {
  const prev = state
  state = reduce(state, a)
  if (shouldPush(prev, state)) undoStore = pushUndo(undoStore, prev)
}

function scheduleAi(): void {
  if (aiTimer !== null) return
  if (!aiCanAct(state)) return
  // 悔牌后的一次性停顿（见 UNDO_AI_HOLD_MS），与 AI 常规速度取较大者
  const hold = aiHoldMs
  aiHoldMs = 0
  aiTimer = window.setTimeout(() => {
    aiTimer = null
    if (!aiCanAct(state)) return
    step({ type: 'aiStep' })
    afterChange()
  }, Math.max(hold, state.aiSpeedMs))
}

/**
 * 逐张发牌：只要还在发、且没有停下来等人决定，就继续下一张。
 * 人类摸到级牌时 `dealPrompt` 会置 true，这里自然停住。
 *
 * 总轮数是全局口径 `DEAL_TOTAL`（33）：第 26..33 轮只有庄家得牌，
 * 人类是不是庄家都要发满 —— 写人类手牌长会让非庄家人类少发 8 轮。
 */
function scheduleDeal(): void {
  if (dealTimer !== null) return
  if (state.phase !== 'contract') return
  if (state.revealed >= DEAL_TOTAL || state.dealPrompt) return
  dealTimer = window.setTimeout(() => {
    dealTimer = null
    if (state.phase !== 'contract') return
    if (state.revealed >= DEAL_TOTAL || state.dealPrompt) return
    state = reduce(state, { type: 'revealTick' })
    afterChange()
  }, Math.round(DEAL_INTERVAL_MS * (ANIM_SPEED_SCALE[state.animSpeed] ?? 1)))
}

/**
 * 上次成功写入 localStorage 的 prefs 序列化串。
 *
 * 发牌动画期间 afterChange 每 55ms 触发一次（revealTick），而 prefs 的
 * 九个字段在此期间完全相同 —— 每 tick 重写一遍 localStorage 纯浪费。
 * 首调用时缓存为空串，必然与首份 prefs 不同 ⇒ 首次一定落盘。
 */
let lastPrefsSerialized = ''

/** prefs 内容与上次成功写入一致时跳过写盘（state 仍然每次全写） */
function savePrefsIfChanged(p: Prefs): void {
  const serialized = JSON.stringify(p)
  if (serialized === lastPrefsSerialized) return
  lastPrefsSerialized = serialized
  savePrefs(p)
}

function afterChange(): void {
  saveState(state)
  savePrefsIfChanged({
    aiLevelPartner: state.aiLevelPartner,
    aiLevelOpponent: state.aiLevelOpponent,
    aiSpeedMs: state.aiSpeedMs,
    fourColor: state.fourColor,
    ruleConfig: state.pendingConfig,
    cardSize: state.cardSize,
    animation: state.animation,
    animSpeed: state.animSpeed,
    showHistory: state.showHistory,
    hintSelects: state.hintSelects,
    showCounter: state.showCounter,
  })
  paint()
  // 必须在 paint 之后：飞行牌要量「这张牌刚画到哪儿」，以及牌堆的位置
  trackDealAnimation(root as HTMLElement, state)
  scheduleDeal()
  scheduleAi()
}

/** 上一次 paint 用的状态：captureFx 要用它读「上一帧的本墩出牌」（见 ui/dealFly.ts） */
let lastPainted: GameState | null = null

function paint(): void {
  // 出牌动画只在「出牌阶段 + 动画开」时需要前后帧快照。
  // 发牌阶段每 55ms 一次 paint，每次都量 30+ 个矩形（强制同步布局）纯属浪费。
  const wantFx = state.animation && state.phase === 'play'
  // 顺序不能换：render 会重建整棵 DOM，旧元素的矩形只能在它之前量
  const before = wantFx ? captureFx(root as HTMLElement, lastPainted ?? state) : null
  lastPainted = state
  setAnimScale(state.animSpeed)
  render(root as HTMLElement, state, {
    dispatch,
    hint,
    undo: undoMove,
    canUndo: canUndo(state, undoStore),
  })
  trackDealAnimation(root as HTMLElement, state)
  if (before !== null) trackPlayFx(root as HTMLElement, state, before)
}

function dispatch(a: Action): void {
  const prevPhase = state.phase
  // 任何主动操作都打断正在排队的发牌节奏，由 afterChange 重新判断
  if (dealTimer !== null) {
    window.clearTimeout(dealTimer)
    dealTimer = null
  }
  step(a)

  // 换局 / 新游戏时清掉旧存档与悔牌栈
  if (a.type === 'newGame' || a.type === 'nextRound') {
    undoStore = emptyUndo()
    if (a.type === 'newGame') clearState()
  }
  if (prevPhase !== state.phase) {
    if (aiTimer !== null) {
      window.clearTimeout(aiTimer)
      aiTimer = null
    }
  }
  afterChange()
}

/**
 * 悔牌：回到「当前这一墩开始前」（本墩还没出牌时 = 上一墩开始前）。
 *
 * **四家的牌一起回退**（快照是整个 GameState，含 AI 已出的牌）。
 * 撤销后如果轮到 AI，先按 UNDO_AI_HOLD_MS 停一下再让它重出 ——
 * 否则 AI 立刻把同样的牌放回来，玩家会以为「悔牌只撤了自己的牌」。
 * 用户连按可以一直退，这是预期行为（不是「悔牌没生效」）。
 */
function undoMove(): void {
  if (!canUndo(state, undoStore)) return
  const { store, target } = popUndo(undoStore)
  if (!target) return
  undoStore = store
  // 快照自带的 selected / hintIds / lastReject 一并清掉，避免「回来就预选着牌」
  state = {
    ...target,
    selected: [],
    hintIds: [],
    lastReject: null,
    notice: '已撤回本墩四家出牌',
  }
  if (aiTimer !== null) {
    window.clearTimeout(aiTimer)
    aiTimer = null
  }
  // 撤销后若立刻该 AI 出牌，给它一个可见停顿（让「整墩撤回」看得见）
  aiHoldMs = aiCanAct(state) ? UNDO_AI_HOLD_MS : 0
  afterChange()
}

/**
 * 提示：高亮一手合法牌。
 *
 * 两种模式由设置项 `hintSelects` 决定（默认关）：
 * - 关（默认）：FR-19 ③ —— **不改变游戏状态**，只写 hintIds，不动 selected。
 *   早先这里派发 setSelection，会把用户已选好的牌覆盖掉，
 *   而且提示结果还会被 saveState 写进存档。
 * - 开：派发 `hintSelect`，一次写入 hintIds + selected，直接进入可出牌状态。
 *   覆盖已选牌 + selected 进存档是**预期副作用**（设置项文案已写明）。
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
      const ids = r.cards.map((c) => c.id)
      dispatch(state.hintSelects ? { type: 'hintSelect', ids } : { type: 'showHint', ids })
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
    // 弹层优先关闭（确认框 > 设置 > 记录 > 取消选牌）
    if (state.confirmNew) dispatch({ type: 'cancelNewGame' })
    else if (state.settingsOpen) dispatch({ type: 'closeSettings' })
    else if (state.logOpen) dispatch({ type: 'toggleLog' })
    else dispatch({ type: 'clearSelect' })
  } else if (ev.key === 'h' || ev.key === 'H') {
    hint()
  }
})

/* 窗口尺寸变化：重算手牌重叠率与花色分组间隔。
 *
 * fitHand 的结果是写在 `.hand` 上的内联 CSS 变量，只在 paint 时算一次。
 * 改牌面尺寸会重新 paint（所以 S/M/L 切换没问题），但拖动窗口大小不会 ——
 * 从窄窗口拉宽后手牌会沿用旧宽度算出的重叠率，挤成一团、分组间隔也停在旧值，
 * 看上去就像「花色间隔消失了」。这里只改 CSS 变量，不重建 DOM。 */
let resizeTimer: number | null = null
window.addEventListener('resize', () => {
  if (resizeTimer !== null) window.clearTimeout(resizeTimer)
  resizeTimer = window.setTimeout(() => {
    resizeTimer = null
    refitHand(root as HTMLElement)
  }, 120)
})

paint()
// 首帧同步一次发牌进度：从存档恢复时 revealed 可能不是 0，
// 不先对齐的话第一张牌会被当成「批量补满」而跳过飞行
trackDealAnimation(root as HTMLElement, state)
scheduleDeal()
scheduleAi()
