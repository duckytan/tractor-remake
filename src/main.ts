/**
 * 入口：装配 store + 渲染 + AI 调度
 */

import './ui/styles.css'

import { enumeratePlays } from '@ai/enumerate'
import type { PlayContext } from '@ai/enumerate'
import { checkPlay, DEAL_TOTAL } from '@core'
import type { Card, Play } from '@core'
import { aiCanAct, autoAction, choosePlay, chooseSafePlay, newGame, pickPrefs, reduce } from '@app/game'
import { clearState, loadPrefs, loadStateDetailed, savePrefs, saveState } from '@app/persist'
import { initStats, recordRound } from '@app/stats'
import { beginRound, finishRound, initRoundLog, noteHumanPlay } from '@app/roundLog'
import { canUndo, emptyUndo, popUndo, pushUndo, shouldPush } from '@app/undo'
import type { Action, GameState } from '@app/state'
import type { Prefs } from '@app/persist'
import { ANIM_SPEED_SCALE, HUMAN_SEAT, ctxOf, seatToPlay } from '@app/state'
import { isDraggingRange, patchSelection, refitHand, render } from '@ui/render'
import { captureFx, setAnimScale, trackDealAnimation, trackPlayFx } from '@ui/dealFly'
import { createAudio } from '@audio/index'
import type { AudioHandle, AudioSettings } from '@audio/index'

const root = document.getElementById('app')
if (!root) throw new Error('#app 未找到')

const prefs = loadPrefs()
const loaded = loadStateDetailed()
let state: GameState = loaded.state ?? newGame(
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
  showOppHands: prefs.showOppHands,
  hintSelects: prefs.hintSelects,
  hintStyle: prefs.hintStyle,
  autoPlay: prefs.autoPlay,
  autoLevel: prefs.autoLevel,
  showCounter: prefs.showCounter,
  aiPeekHands: prefs.aiPeekHands,
  pendingConfig: prefs.ruleConfig,
}
/**
 * 存档没恢复成功时**告诉玩家一声**。
 *
 * 旧实现是静默重开 —— 玩家看到的是「我明明打到一半，怎么重新发牌了」，
 * 完全不知道发生了什么（docs/33 C3-02）。现在把原因写进 `notice`，
 * 由 toast 显示一次，玩家点掉或下一个动作就消失。
 *
 * 注意 `contract-phase` 不提示：定主阶段本来就不恢复（见 `loadStateDetailed`），
 * 那是设计行为，说「存档损坏」反而吓人。
 */
if (loaded.issue === 'version') {
  state = { ...state, notice: '存档版本已过期，已重新开局' }
} else if (loaded.issue === 'corrupt') {
  state = { ...state, notice: '存档内容已损坏，已重新开局' }
}

// 战绩缓存（跨局累计，与存档分开；只在这里读一次 localStorage）
initStats()
// 对局数据记录（复盘用，与战绩统计分开）
initRoundLog()

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
/**
 * 这一手之前有没有点过「提示」。
 *
 * 不能等到出牌时读 `hintIds` —— 点牌会 `setSelection` 把它清掉，读出来永远是空。
 * 换墩就清（提示是对"这一手"的参考，不该跨墩继承）。
 */
let hintUsedThisTurn = false

function step(a: Action): void {
  const prev = state
  state = reduce(state, a)
  if (shouldPush(prev, state)) undoStore = pushUndo(undoStore, prev)
  // 刚打完一局：记进战绩（跨局累计，是玩家自己判断"AI 强不强"的唯一外部依据）
  const justSettled = prev.phase !== 'settle' && state.phase === 'settle'
  const justOver = prev.phase !== 'over' && state.phase === 'over'
  if (justSettled || justOver) {
    recordRound(state)
    finishRound(state)
  }

  /* ---- 对局数据记录（复盘用） ----
     ① 定主刚结束、进入埋底/出牌时抓**开局手牌**：再晚就出过牌了，复盘看不到原始手牌。
     ② 人类每出一手，额外算一次「同局面 L3 会出什么」（影子决策）——
        这是分析"你和 AI 差在哪"的唯一依据，也是将来扩标注题库的素材。
     ③ 结算时落库（幂等）。 */
  if (prev.phase === 'contract' && (state.phase === 'bury' || state.phase === 'play')) {
    beginRound(state)
  }
  if (a.type === 'showHint') hintUsedThisTurn = true
  if (a.type === 'playSelected' && prev.phase === 'play' && state !== prev) {
    const hand = prev.hands[HUMAN_SEAT] as readonly Card[]
    const picked = hand.filter((c) => prev.selected.includes(c.id))
    if (picked.length > 0) {
      noteHumanPlay(prev, picked, choosePlay(prev, HUMAN_SEAT, 3, { peek: true }), hintUsedThisTurn)
    }
    hintUsedThisTurn = false
  }
  if (prev.trick !== state.trick) hintUsedThisTurn = false
}

function scheduleAi(): void {
  if (aiTimer !== null) return
  // 两条链共用一个定时器：AI 对手出牌（aiStep）与挂机代打人类（autoStep）。
  // **问一次 autoAction 再决定排不排** —— 没有可做的动作就绝不排，
  // 否则「定时器发现没事可做 → 直接返回 → 没人再排下一次」是安全的，
  // 但「排了 → 动作被拒 → 状态没变 → 又排」就是无限空转（下面的守卫兜底）。
  const auto = state.autoPlay ? autoAction(state) : null
  const byAi = aiCanAct(state)
  if (!byAi && auto === null) return
  // 悔牌后的一次性停顿（见 UNDO_AI_HOLD_MS），与 AI 常规速度取较大者
  const hold = aiHoldMs
  aiHoldMs = 0
  const kind: 'ai' | 'auto' = byAi ? 'ai' : 'auto'
  aiTimer = window.setTimeout(() => {
    aiTimer = null
    const now = kind === 'ai' ? aiCanAct(state) : state.autoPlay && autoAction(state) !== null
    if (!now) return
    if (kind === 'ai') {
      step({ type: 'aiStep' })
    } else {
      const before = state
      step({ type: 'autoStep' })
      // 失败守卫：自动动作被规则拒绝时状态引用会整片不变，
      // 这时链条会每 aiSpeedMs 重试一次 ⇒ 无限空转（历史坑，见 aiCanAct 注释）。
      if (sameProgress(before, state)) {
        autoStall++
        if (autoStall >= 3) {
          autoStall = 0
          state = { ...state, autoPlay: false, notice: '挂机已停止（自动操作失败）' }
        }
      } else {
        autoStall = 0
      }
    }
    afterChange()
  }, Math.max(hold, state.aiSpeedMs))
}

/** 挂机连续「状态没变」的次数（失败守卫用，见 scheduleAi） */
let autoStall = 0

/**
 * 这一步有没有真的推进局面。
 *
 * 只比**会被出牌/发牌改动的四个引用**：`reduce` 是不可变更新的，
 * 被拒绝时这些字段原样返回（同一引用）；而 `notice` / `hintIds` 之类的
 * 视觉字段会换新对象，拿来判断会永远「有变化」。
 */
function sameProgress(a: GameState, b: GameState): boolean {
  return a.hands === b.hands && a.phase === b.phase && a.trick === b.trick && a.revealed === b.revealed
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
    // **必须走 `step`**：直接 `state = reduce(...)` 会绕过 `step` 里的记账
    //（悔牌栈 / 战绩 / 对局记录）。发牌最后一张可能就把 `phase` 推到 `play`，
    // 绕过时「开局快照」永远抓不到 ⇒ 整局的复盘数据没有手牌（v1.3.42 实测踩到）。
    step({ type: 'revealTick' })
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
    showOppHands: state.showOppHands,
    hintSelects: state.hintSelects,
    hintStyle: state.hintStyle,
    autoPlay: state.autoPlay,
    autoLevel: state.autoLevel,
    showCounter: state.showCounter,
    aiPeekHands: state.aiPeekHands,
    musicTheme: state.musicTheme,
    soundEnhanced: state.soundEnhanced,
    autoVariation: state.autoVariation,
    volumeMaster: state.volumeMaster,
    volumeBgm: state.volumeBgm,
    volumeSfx: state.volumeSfx,
  })
  paint()
  // 必须在 paint 之后：飞行牌要量「这张牌刚画到哪儿」，以及牌堆的位置
  trackDealAnimation(root as HTMLElement, state)
  scheduleDeal()
  scheduleAi()
}

/*
 * PWA：生产环境注册 service worker（离线 + 可安装）。
 *
 * **本地预览 / e2e 不注册**：它们都跑在 127.0.0.1 / localhost 上，
 * 而 SW 会把构建产物缓存起来 —— 之后改了代码再跑，读到的还是旧产物，
 * 排查起来极其费时（PWA 最经典的坑）。部署到 Vercel 等真实域名时才启用。
 *
 * **必须放在 `afterChange()` 外面**（v1.3.29 修正）：这段曾经写在 `paint()` 之后、
 * 但括号没闭合，于是整块落进了 `afterChange()` 函数体 —— 每次状态变化都会
 * 重新 `addEventListener('load', …)` 一次，监听器无限累积（虽然 `load` 只触发一次
 * 所以没暴露成 bug，但属于典型的「括号放错位置」事故）。
 */
const isLocalHost = ['127.0.0.1', 'localhost', '[::1]'].includes(location.hostname)
if (import.meta.env.PROD && !isLocalHost && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {
      /* 注册失败不影响游戏本身（只是没有离线能力） */
    })
  })
}

/** 上一次 paint 用的状态：captureFx 要用它读「上一帧的本墩出牌」（见 ui/dealFly.ts） */
let lastPainted: GameState | null = null

/**
 * 只有 `selected` / `hintIds` 变了？（= 纯视觉变化，可以走增量路径）
 *
 * 判定靠**引用比较**：`reduce` 是不可变更新的，没变的字段保持同一引用，
 * 变了的字段换新引用。所以 56 个字段逐个 `!==` 就能精确判断，
 * 不需要深比较（`hands` / `trick` / `history` 这些嵌套结构同理）。
 */
const SELECTION_ONLY_KEYS = new Set<string>(['selected', 'hintIds'])
function onlySelectionChanged(prev: GameState, next: GameState): boolean {
  if (prev === next) return false
  for (const k of Object.keys(next) as (keyof GameState)[]) {
    if (SELECTION_ONLY_KEYS.has(k as string)) continue
    if (prev[k] !== next[k]) return false
  }
  return true
}

/* ============================================================
   音频
   ------------------------------------------------------------
   纯观察者：`core` / `app` 一行都不改，靠 paint() 里的前后帧 diff 推断发生了什么。
   浏览器要求用户手势后才能出声 ⇒ 首次交互时 start()。
   ============================================================ */

const audioSettingsOf = (s: GameState): AudioSettings => ({
  volumeMaster: s.volumeMaster / 100,
  volumeBgm: s.volumeBgm / 100,
  volumeSfx: s.volumeSfx / 100,
  musicTheme: s.musicTheme,
  soundEnhanced: s.soundEnhanced,
  autoVariation: s.autoVariation,
})

const audio: AudioHandle = createAudio(audioSettingsOf(state))

/** 首次用户手势起播（浏览器自动播放策略） */
let audioStarted = false
function ensureAudioStarted(): void {
  if (audioStarted) return
  audioStarted = true
  audio.start()
  audio.applySettings(audioSettingsOf(state))
}
window.addEventListener('pointerdown', ensureAudioStarted, { once: true })
window.addEventListener('keydown', ensureAudioStarted, { once: true })

/** 切后台就 suspend，回来再 resume —— 省电，也避免锁屏还在响 */
document.addEventListener('visibilitychange', () => {
  audio.setPageVisible(!document.hidden)
})

/**
 * 页面卸载时回收 AudioContext。
 *
 * `audio.dispose()` 早就写好了，但**从来没有人调用**（docs/31 P1-3 / J1-7）——
 * 典型的「写了清理函数却没接线」。不回收的后果是：
 *   · 开着标签页再关掉，`AudioContext` 可能停留在 running 状态占着音频设备；
 *   · 移动端 Safari 对同时存在的 AudioContext 数量有限制（历史上是 4 个），
 *     反复刷新会累积到超限、后续页面直接没声音。
 * 用 `pagehide` 而不是 `beforeunload`：后者在移动端和 bfcache 场景下不触发。
 */
window.addEventListener('pagehide', () => {
  audio.dispose()
})

/** 上一次 paint 给音频用的状态（与 lastPainted 同源，单独存一份避免动画关掉时失效） */
let lastAudioPainted: GameState | null = null

function paint(): void {
  // 拖音量滑条时**不能重建 DOM**：render 是整棵 root.innerHTML 重建，
  // <input type=range> 会被换成新元素，拖动立刻中断（只剩点哪跳哪）。
  // 这期间只把音量推给音频层 —— 所以拖动时能实时听到变化。
  if (isDraggingRange()) {
    lastAudioPainted = state
    audio.applySettings(audioSettingsOf(state))
    return
  }
  // 出牌动画只在「出牌阶段 + 动画开」时需要前后帧快照。
  // 发牌阶段每 55ms 一次 paint，每次都量 30+ 个矩形（强制同步布局）纯属浪费。
  const wantFx = state.animation && state.phase === 'play'

  // 选牌 / 提示是纯视觉状态：只切 class，不重建 DOM。
  // 整棵重建会把焦点（键盘用户每选一张就要重新 Tab）、<input> 拖动、动画状态
  // 一起丢掉，而且一次选牌要写 71 次 innerHTML / 72KB（docs/34 D-3、docs/37 E-2）。
  // 放在 captureFx 之前：这条路径没有任何牌在飞，不需要前后帧快照。
  if (lastPainted !== null && onlySelectionChanged(lastPainted, state)) {
    lastPainted = state
    lastAudioPainted = state
    patchSelection(root as HTMLElement, state)
    audio.applySettings(audioSettingsOf(state))
    return
  }

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

  // 音频：跟动画用同一套「前后帧」思路（prev 必须是上一帧的状态）
  const prevForAudio = lastAudioPainted
  lastAudioPainted = state
  if (prevForAudio !== null && prevForAudio !== state) {
    audio.observe(prevForAudio, state)
  }
  audio.applySettings(audioSettingsOf(state))
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
  // 快照自带的 selected / hintIds / lastReject 一并清掉，避免「回来就预选着牌」。
  //
  // **偏好字段必须用「当前值」覆盖快照里的旧值**（docs/33 C5-01）：
  // 快照是整个 GameState，所以「出牌 → 改设置（四色/音量/主题/AI 档位/规则）→ 悔牌」
  // 会把刚改的设置一起退回，而紧接着 `afterChange()` 还会把回退后的值写回
  // localStorage ⇒ 用户的设置被永久抹掉。用 `pickPrefs(state)` 覆盖即可。
  state = {
    ...target,
    ...pickPrefs(state),
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
 * 提示：高亮一手**建议**的牌。
 *
 * 两种模式由设置项 `hintSelects` 决定（默认关）：
 * - 关（默认）：FR-19 ③ —— **不改变游戏状态**，只写 hintIds，不动 selected。
 *   早先这里派发 setSelection，会把用户已选好的牌覆盖掉，
 *   而且提示结果还会被 saveState 写进存档。
 * - 开：派发 `hintSelect`，一次写入 hintIds + selected，直接进入可出牌状态。
 *   覆盖已选牌 + selected 进存档是**预期副作用**（设置项文案已写明）。
 *
 * **建议从哪来**（v1.3.31 修）：早先走 `enumeratePlays(...)` 取第一个合法候选，
 * 而候选是按小到大枚举的 ⇒ 提示永远只会让你出最小的一手（用户反馈「太弱智」）。
 * 现在直接调 `choosePlay()` —— 与 AI 完全同一个大脑（L3 超强 + 残局精确搜索），
 * 所以「提示建议怎么打」和「超强 AI 会怎么打」不可能分叉。
 */
function hint(): void {
  if (seatToPlay(state) !== HUMAN_SEAT) return
  const ids = hintIdsFor(state)
  if (ids.length === 0) return
  dispatch(state.hintSelects ? { type: 'hintSelect', ids } : { type: 'showHint', ids })
}

/**
 * 算出一手建议牌（牌 id 列表）。
 *
 * ① 主路径：`choosePlay` 选出的那一手 —— 先过一遍 `checkPlay` 兜底，
 *    万一策略给出不合法的一手（理论上不会，但提示是玩家直接看到的东西，
 *    错一次就会被当成「提示坏了」），落到 ②。
 * ② 兜底：老的「枚举候选取第一个合法」—— 保证任何局面下提示都有输出。
 */
function hintIdsFor(s: GameState): number[] {
  const hand = s.hands[HUMAN_SEAT] as readonly Card[]
  if (hand.length === 0) return []
  const leadPlay = s.trick.plays[0] as Play | undefined
  const opponents = [1, 2, 3].map((x) => s.hands[x] as readonly Card[])
  const verify = (cards: readonly Card[]): number[] | null => {
    const r = checkPlay({
      hand,
      cards,
      ctx: ctxOf(s),
      ...(leadPlay ? { lead: { cards: leadPlay.cards, analysis: leadPlay.analysis } } : {}),
      opponents,
    })
    return r.ok ? r.cards.map((c) => c.id) : null
  }

  // ① 主路径：按设置选策略
  //    'safe'（默认）= 稳妥人类风格：不首出带分牌、能赢才抢、队友赢着垫最小
  //    'ai'          = 最强 AI（L3 + 残局搜索），胜率更高但线路更像机器
  //
  // **提示恒用全信息**（v1.3.39 · 三司会审 F2）：「AI 读牌」这个开关的语义是
  // 「对手 AI 能不能看到我的手牌」，不该顺带决定**我的助手**有多强。
  // 之前没显式传 peek，于是玩家为公平关掉读牌时，提示也一起变弱（实测 L3 只剩 26.9%）。
  const best = verify(
    s.hintStyle === 'ai'
      ? choosePlay(s, HUMAN_SEAT, 3, { peek: true })
      : chooseSafePlay(s, HUMAN_SEAT),
  )
  if (best !== null) return best

  // ② 兜底：枚举候选里第一个合法的
  const pc: PlayContext = leadPlay
    ? { kind: 'follow', leadCards: leadPlay.cards, leadAnalysis: leadPlay.analysis }
    : { kind: 'lead' }
  for (const cards of enumeratePlays(hand, ctxOf(s), pc, 40)) {
    const ids = verify(cards)
    if (ids !== null) return ids
  }
  return []
}

/* 键盘：空格出牌 / Esc 取消 / H 提示 / 回车选牌
 * NFR-10：全部操作可用键盘完成。 */
window.addEventListener('keydown', (ev) => {
  if (ev.repeat) return

  // 回放期间只响应 ←/→/Esc —— 尤其要挡住空格（否则会在看历史墩时把牌打出去）
  if (state.replayAt !== null) {
    if (ev.code === 'ArrowLeft') {
      ev.preventDefault()
      dispatch({ type: 'replayStep', delta: -1 })
    } else if (ev.code === 'ArrowRight') {
      ev.preventDefault()
      dispatch({ type: 'replayStep', delta: 1 })
    } else if (ev.code === 'Escape') {
      dispatch({ type: 'replayExit' })
    }
    return
  }

  // 焦点在手牌上时，回车/空格切换选中，不触发出牌
  const onCard = ev.target instanceof HTMLElement && ev.target.closest('.card[data-id]')
  if (onCard && (ev.code === 'Enter' || ev.code === 'Space')) {
    ev.preventDefault()
    const id = Number((ev.target as HTMLElement).closest('.card[data-id]')?.getAttribute('data-id'))
    if (Number.isFinite(id)) dispatch({ type: 'toggleSelect', id })
    return
  }

  // 焦点在「本来就能用空格激活」的元素上时，空格必须归浏览器。
  //
  // 旧实现无条件 `preventDefault()` + `playSelected()`，于是：
  //   - 焦点在顶栏「设置」上按空格 → 什么都不发生（Enter 才有用）
  //   - 焦点在设置里的 role=switch 上按空格 → 开关不翻转
  // 即 NFR-10 声称的「全部操作可用键盘完成」实际做不到（docs/37 E-1）。
  const onActivatable =
    ev.target instanceof HTMLElement &&
    ev.target.closest(
      'button, [role="button"], [role="switch"], [role="tab"], [role="checkbox"], input, select, textarea, a[href]',
    ) !== null

  if (ev.code === 'Space') {
    if (onActivatable) return
    ev.preventDefault()
    dispatch({ type: 'playSelected' })
  } else if (ev.code === 'Escape') {
    // 弹层优先关闭（确认框 > 设置 > 记录 > 取消选牌）
    if (state.confirmNew) dispatch({ type: 'cancelNewGame' })
    else if (state.settingsOpen) dispatch({ type: 'closeSettings' })
    else if (state.logOpen) dispatch({ type: 'toggleLog' })
    else dispatch({ type: 'clearSelect' })
  } else if ((ev.key === 'h' || ev.key === 'H') && !onActivatable) {
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
