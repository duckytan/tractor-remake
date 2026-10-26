/**
 * 界面渲染
 *
 * 策略：每次状态变化重建 DOM。牌桌最多约 200 个节点，重建成本可忽略，
 * 换来的是「渲染 = state 的纯函数」这种简单性。
 *
 * 分层铁律：本文件只消费 app 层算好的视图数据（handView / trickLogView /
 * pastPlaysView），不出现 power / 主牌判定等规则概念。
 */

import type { Card, LevelRank, Play, PlayResult, RuleConfig, Seat, Trump } from '@core'
import { DEAL_TOTAL, DECK_SIZE, GUARD_NEED, checkPlay, dealtCount, teamOf } from '@core'
import type { AiLevel } from '@ai/policy'
import { THEMES, THEME_ORDER, isThemeKey } from '@audio/scenes'
import type { Action, CardSize, GameState } from '@app/state'
import { CARD_SIZE_PX, HUMAN_SEAT, ctxOf, seatToPlay } from '@app/state'
import { gapCountOf, handView } from '@app/handView'
import {
  counterView,
  dealtCardsFor,
  displayPlays,
  pastPlaysView,
  replaySummary,
  trickLogView,
} from '@app/view'
import { leadingSeat } from '@app/view'
import type { CounterSlot } from '@app/view'
import { backEl, cardEl, ensureDefs } from './card'
import { isBackInFlight, isInFlight } from './dealFly'

export interface Actions {
  readonly dispatch: (a: Action) => void
  readonly hint: () => void
  /** 悔牌：回到本墩开始前（栈在 main.ts，不在 GameState 里） */
  readonly undo: () => void
  readonly canUndo: boolean
}

const SUIT_LABEL = ['♠ 黑桃', '♥ 红心', '♣ 梅花', '♦ 方片']
const SEAT_LABEL = ['南（你）', '西', '北', '东']
const SEAT_CLASS: Record<Seat, string> = { 0: 'center', 1: 'west', 2: 'north', 3: 'east' }

/** 各家出牌区里显示最近几墩的历史小牌（v1.2.3：3 → 5，用户反馈「只留 3 墩，新的把旧的顶走」） */
const PAST_DEPTH = 5
/** 历史小牌宽度占卡宽的比例（M 档 150 × 0.24 = 36px。
 *  v1.3.4：0.16（24px）用户反馈「牌太小了看不清」—— 24px 的牌 Rank/花色基本不可读，提到 36px） */
const TINY_RATIO = 0.32
/** 已出牌宽度占卡宽的比例：正常 0.56（M 档 84px），矮屏 0.44（66px） */
const PLAYED_RATIO = 0.56
const PLAYED_RATIO_SHORT = 0.44
/** 花色分组间隔占卡宽的比例（与 CSS 的 --suit-gap 保持一致） */
const SUIT_GAP_RATIO = 0.2
/**
 * 分组间隔的压缩下限（占卡宽）。
 *
 * 空间不够时间隔可以缩，但**不能缩到 0** —— 缩到 0 就等于没有分组。
 * v1.2.9 之前这里走的是「放不下就降级成写死的 6px，再放不下就 0」，
 * 结果 M 档（6px = 卡宽 4%）和 L 档（0px）的花色间隔彻底看不见，
 * 只有 S 档因为手牌窄、够放而侥幸保留了 24px。见 docs/14 §2.1。
 */
const SUIT_GAP_MIN_RATIO = 0.08
/** 手牌重叠步长上限：每张露出 58% 卡宽 */
const HAND_STEP_MAX = 0.58
/** 手牌重叠步长下限：左上角标约占卡宽 24%（「10」这种两位数最宽），再压就开始切字 */
const HAND_STEP_MIN = 0.28
/** 极端拥挤时步长的硬下限：宁可切掉角标的一个数字，也不让手牌横向溢出整张牌 */
const HAND_STEP_HARD_MIN = 0.18
/** 侧家（西/东）竖向牌背最多显示几张 —— 竖向更吃高度，比北家的 13 少 */
const SIDE_SHOW = 10
/**
 * 对家牌背宽度占卡宽的比例（竖向排列时视觉高度 = 该值）。
 * 同样是比例而非 px —— 换 S/L 档位时牌背要跟着手牌一起缩放。
 * 侧家：正常 0.347（M 档 52px）、窄屏 0.267（40px）、矮屏 0.253（38px）；北家横向 0.307（46px）。
 */
const SIDE_RATIO = 0.347
const SIDE_RATIO_NARROW = 0.267
const SIDE_RATIO_SHORT = 0.253
const NORTH_BACK_RATIO = 0.307
/** 侧家竖向重叠率下限：低于这个值牌与牌就糊成一整块，看不出张数 */
const SIDE_MIN_STEP = 0.18
/** AI 四档（弱 / 中 / 强 / 超强） */
const AI_LEVEL_OPTS = [
  { v: '0', label: '弱' },
  { v: '1', label: '中' },
  { v: '2', label: '强' },
  { v: '3', label: '超强' },
] as const

export function levelLabel(lr: LevelRank): string {
  if (lr === 18) return '打王'
  if (lr === 1) return 'A'
  return String(lr)
}

export function trumpLabel(t: Trump): string {
  if (t === 'NT') return '无将'
  return SUIT_LABEL[t] as string
}

/**
 * 座位角色标签：**庄**（庄家本人）/ **友**（庄家的队友）/ **闲**（闲家）。
 *
 * 不能按「队伍」给四家发庄/闲 —— 庄家的队友与庄家同队，也会显示「庄」，
 * 于是庄家坐东西边时左右两家同时显示「庄」，用户会误以为有两个庄家
 * （v1.3.6 用户反馈：「怎么左右两边同时是庄家？只能是其中一个」）。
 * 真正的庄家只有 s.dealer 一个；顶部信息栏的「庄 <座位>」也始终指向本人。
 */
function seatRoleLabel(
  s: GameState,
  seat: Seat,
): { text: string; title: string; isDealer: boolean } {
  if (seat === s.dealer) return { text: '庄', title: '庄家（本局坐庄）', isDealer: true }
  if (teamOf(seat) === teamOf(s.dealer)) {
    return { text: '友', title: '庄家的队友（庄家队）', isDealer: false }
  }
  return { text: '闲', title: '闲家', isDealer: false }
}

/** 角色标签的 HTML（庄家本人加 is-dealer 高亮 + 悬停说明） */
function roleTag(s: GameState, seat: Seat): string {
  const r = seatRoleLabel(s, seat)
  return `<b class="seat-role${r.isDealer ? ' is-dealer' : ''}" title="${r.title}">${r.text}</b>`
}

function cardWrap(cards: readonly Card[], o: { cls?: string; width?: number } = {}): HTMLElement {
  const box = document.createElement('div')
  box.className = 'cards'
  for (const c of cards) {
    // 正在飞行的牌先不显形（出牌飞行 / 发牌飞行），落地由 ui/dealFly.ts 揭开。
    // 不藏的话会看到「牌已经在出牌区了，同时还有一张在飞」。
    const cls = isInFlight(c.id) ? `${o.cls ?? ''} card--incoming`.trim() : o.cls
    // data-id 必带：出牌飞行 / 收墩归位都靠它把「状态里的牌」和「DOM 元素」对上
    box.appendChild(cardEl(c, { ...o, cls, id: c.id }))
  }
  return box
}

/**
 * 当前牌面尺寸档位下的卡宽（px）。
 *
 * 牌面尺寸有三档（S/M/L = 120/150/190，窄屏另有覆盖），全部体现在 CSS 变量
 * `--card-w` 上。UI 里凡与牌相关的尺寸都应从它派生，不要写死 px ——
 * 否则换档位后比例就崩了（v1.2.6 之前的 playedW / TINY_W 就是写死的）。
 *
 * 注意：必须在 `render()` 把 `data-card-size` 挂到 `<html>` **之后**调用，
 * 否则读到的是上一档的旧值。
 */
function cardWidthPx(): number {
  const raw = getComputedStyle(document.documentElement).getPropertyValue('--card-w')
  const n = Number.parseFloat(raw)
  return Number.isFinite(n) && n > 0 ? n : 150
}

/**
 * 填一个座位的出牌区。
 *
 * - `plays__now`  本墩出的牌（按卡宽比例缩放）
 * - `plays__past` 最近几墩**该座位**出的牌（微小卡牌，每墩一组）
 *
 * 现实里打完的牌就摆在自己面前 ⇒ 每个座位各有一个出牌区，
 * 不再把四家的牌堆在同一个玩家前面。
 */
function fillPlays(
  box: HTMLElement,
  s: GameState,
  seat: Seat,
  playedW: number,
  tinyW: number,
  leadSeat: Seat | null,
): void {
  // 侧家的竖向堆叠步长要用到本墩牌的宽度
  box.style.setProperty('--played-w', `${playedW}px`)
  // 历史小牌的实际宽度也要暴露给 CSS：侧家小牌是竖向压叠的，
  // 压叠量必须按**小牌自己**的尺寸算（v1.3.22 踩过：用全局 --card-w 算，
  // 每张上移 157px 而小牌只有 48 宽，第三张就冲出容器压到牌背上了）。
  box.style.setProperty('--tiny-w', `${tinyW}px`)
  const now = box.querySelector('.plays__now') as HTMLElement
  const past = box.querySelector('.plays__past') as HTMLElement
  // 回放时出牌区显示的是「那一墩」的历史出牌，不是当前墩（见 app/view.ts displayPlays）
  const play = displayPlays(s).find((p) => p.seat === seat)
  if (play) now.appendChild(cardWrap(play.cards, { width: playedW }))
  // 当前这墩谁最大：给那一组牌加金色呼吸光晕，一眼看出「现在要压谁」。
  // leadSeat 由 view 层的 leadingSeat() 算（走 trickStanding，能排除垫牌）。
  now.classList.toggle('plays__now--lead', leadSeat === seat && play !== undefined)
  if (!s.showHistory) return
  const { nos, tricks } = pastPlaysView(s, seat, PAST_DEPTH)
  tricks.forEach((cards, i) => {
    if (cards.length === 0) return
    const g = document.createElement('div')
    g.className = 'past__trick'
    g.title = `第 ${nos[i]} 墩`
    for (const c of cards) g.appendChild(cardEl(c, { width: tinyW, cls: 'card--tiny' }))
    past.appendChild(g)
  })
}

/**
 * 是否正在拖音量滑条。
 *
 * `render()` 是整棵 `root.innerHTML` 重建 —— 拖动时每个 `input` 事件都会 dispatch
 * 一次音量，paint 一重建，`<input type=range>` 元素就被换掉，拖动立刻中断，
 * 表现成「只能点某个位置跳过去，拖不动」（用户反馈）。
 * main.ts 的 `paint()` 会读这个标志，拖动期间只更新音频、不重绘 DOM。
 */
let draggingRange = false

export function isDraggingRange(): boolean {
  return draggingRange
}

function endRangeDrag(): void {
  draggingRange = false
}

/** window 级的 pointerup 兜底只绑一次（render 每帧都会调 bind，不能重复加监听） */
let windowDragBound = false

/**
 * 上一次 paint 时弹层面板的滚动位置。
 *
 * 必须**在 `root.innerHTML = ...` 之前**量 —— 整棵重建会把 overlay 里的
 * 旧面板一起销毁，等 `fillOverlay` 执行时已经查不到 `.panel` 了，
 * 只能读到 0（v1.3.21 踩过：加了恢复逻辑却始终不生效）。
 */
let savedOverlayScroll = 0
let savedOverlayLabel = ''

/** 设置面板的标签页键 */
export type SettingsTab = 'game' | 'view' | 'sound' | 'rule'

/**
 * 设置面板当前选中的标签页。
 *
 * 放在模块级而不是 state 里：切标签纯属 UI 视图状态，写进 state 会连带
 * 触发存档写入与「规则改动」比较，得不偿失。render 重建时读它，
 * 点击时同步改 DOM（不 dispatch，所以切换是瞬时的、不丢滚动位置）。
 */
let settingsTab: SettingsTab = 'game'

/** 标签页定义（顺序 = 展示顺序） */
const SETTINGS_TABS: readonly { key: SettingsTab; label: string }[] = [
  { key: 'game', label: '牌局' },
  { key: 'view', label: '画面' },
  { key: 'sound', label: '声音' },
  { key: 'rule', label: '规则' },
]

export function render(root: HTMLElement, s: GameState, act: Actions): void {
  ensureDefs()
  // 体验档位挂在 <html> 上：styles.css 里用的是 :root[...] 选择器，
  // 只挂 #app 会让四色 / 尺寸 / 动画三档全部失效（历史遗留）。
  for (const el of [root, document.documentElement]) {
    el.dataset.fourColor = s.fourColor ? 'true' : 'false'
    el.dataset.cardSize = s.cardSize
    el.dataset.anim = s.animation ? 'on' : 'off'
  }

  const turn = seatToPlay(s)
  // 与牌相关的尺寸全部按当前档位的卡宽派生，不写死 px。
  // 注意顺序：上面已经把 data-card-size 挂到 <html>，这里读到的才是本档位的值。
  const cardW = cardWidthPx()
  const shortScreen = window.innerHeight <= 780
  const playedW = Math.round(cardW * (shortScreen ? PLAYED_RATIO_SHORT : PLAYED_RATIO))
  const tinyW = Math.round(cardW * TINY_RATIO)

  // 整棵重建前先记下弹层面板的滚动位置（重建后旧元素就没了）
  {
    const oldPanel = root.querySelector<HTMLElement>('.overlay .panel')
    savedOverlayScroll = oldPanel === null ? 0 : oldPanel.scrollTop
    savedOverlayLabel = oldPanel === null ? '' : (oldPanel.getAttribute('aria-label') ?? '')
  }

  root.innerHTML = `
    <header class="topbar">
      <div class="brand">拖拉机 · 重制版<span class="brand__ver" title="版本 ${__APP_VERSION__}">v${__APP_VERSION__}</span></div>
      <div class="meta">
        <span>第 <b>${s.round}</b> 局</span>
        <span>打 <b>${levelLabel(s.levelRank)}</b></span>
        <span>主 <b>${trumpLabel(s.trump)}</b></span>
        <span>庄 <b>${SEAT_LABEL[s.dealer]}</b></span>
      </div>
      <div class="top-actions">
        <button class="btn btn--ghost" data-act="toggleFourColor">四色</button>
        <button class="btn btn--ghost" data-act="toggleLog">记录</button>
        <button class="btn btn--ghost" data-act="openSettings">设置</button>
        <button class="btn btn--ghost" data-act="newGame">新游戏</button>
      </div>
    </header>

    <div class="scorebar status" data-slot="status"></div>
    ${counterStrip(s)}

    <main class="felt">
      <div class="seat seat--north" data-slot="north"></div>
      <div class="seat seat--west" data-slot="west"></div>
      <div class="seat seat--center" data-slot="center"></div>
      <div class="seat seat--east" data-slot="east"></div>
      <div class="south">
        <div class="plays" data-slot="plays-mine">
          <div class="plays__now"></div>
          <div class="plays__past"></div>
        </div>
        <div class="hand" data-slot="hand"></div>
        <div class="hand-bar" data-slot="handbar"></div>
      </div>
    </main>

    <div class="overlay" data-slot="overlay"></div>
    <div class="toast" data-slot="toast"></div>
  `

  const q = <T extends HTMLElement>(slot: string) => root.querySelector(`[data-slot="${slot}"]`) as T

  /* ---- 三家对家 ---- */
  // 两趟：先立骨架（含已出的牌），再统一填牌背。
  // 一趟做不行 —— 填西家的牌背会改变北家那一行的高度，进而改变后面几家的可用高度，
  // 先量的那家就会拿到过期的高度、把牌堆排出容器。
  const sideW = Math.round(
    cardW *
      (window.innerWidth <= 900
        ? SIDE_RATIO_NARROW
        : window.innerHeight <= 780
          ? SIDE_RATIO_SHORT
          : SIDE_RATIO),
  )
  // 本墩当前谁最大（走 trickStanding，能排除垫牌）。每帧算一次，四个出牌区共用。
  // 不能用 s.trick.winner —— 那个字段在出牌途中恒为 null。
  const leadSeat = leadingSeat(s)
  for (const seat of [1, 2, 3] as Seat[]) {
    const box = q(SEAT_CLASS[seat])
    // 侧家牌背要旋转 90°，旋转后包围盒宽 = 牌高 = sideW×1.4。
    // 布局尺寸仍是 sideW，所以容器必须按旋转后的宽度留位，
    // 否则牌会左右各溢出 0.2×sideW，压到旁边的出牌区上（v1.3.22 实测）。
    box.style.setProperty('--side-w', `${sideW}px`)
    const hand = s.hands[seat] as readonly Card[]
    const isWinner = leadSeat === seat
    // 西（1）/ 东（3）竖向堆叠，北（2）保持横向
    const side = seat === 1 || seat === 3

    box.innerHTML = `<div class="seat-tag${isWinner ? ' is-win' : ''}">
        ${SEAT_LABEL[seat]} · ${hand.length} 张 · ${roleTag(s, seat)}
        ${turn === seat ? '<span class="turn-dot"></span>' : ''}
      </div>
      <div class="seat-body">
        <div class="back-row${side ? ' back-row--side' : ''}" data-slot="back-${seat}"></div>
        <div class="plays${side ? ' plays--side' : ''}" data-slot="plays-${seat}">
          <div class="plays__now"></div>
          <div class="plays__past"></div>
        </div>
      </div>`

    fillPlays(
      box.querySelector(`[data-slot="plays-${seat}"]`) as HTMLElement,
      s,
      seat,
      playedW,
      tinyW,
      leadSeat,
    )
  }
  // 填牌背的顺序必须是「北家先、侧家后」：北家那一行是 auto 高，
  // 它的牌背一进去就会把中间的 1fr 行压矮；先量侧家就会拿到过期高度而溢出。
  for (const seat of [2, 1, 3] as Seat[]) {
    const box = q(SEAT_CLASS[seat])
    const hand = s.hands[seat] as readonly Card[]
    const side = seat === 1 || seat === 3
    const backRow = box.querySelector(`[data-slot="back-${seat}"]`) as HTMLElement
    const narrow = window.innerWidth <= 900
    let show = Math.min(hand.length, side ? (narrow ? 8 : SIDE_SHOW) : 13)
    // 逐张发牌期间：牌背也一张一张长出来（否则三家是「啪」一下全出现）
    if (s.phase === 'contract') show = Math.min(show, dealtCardsFor(s, seat))
    if (side) {
      // 此时 back-row 还没有子节点，clientHeight 就是 flex 分给它的可用高度
      const avail = backRow.clientHeight
      const layoutH = sideW * 1.4
      const maxFit =
        avail > 0 ? Math.max(2, Math.floor((avail - layoutH) / (layoutH * SIDE_MIN_STEP)) + 1) : show
      show = Math.min(show, maxFit)
    }
    for (let i = 0; i < show; i++) {
      backRow.appendChild(
        backEl(1, {
          width: side ? sideW : Math.round(cardW * NORTH_BACK_RATIO),
          // 这张还在从牌堆飞过来 ⇒ 先占位不显形（见 ui/dealFly.ts）
          cls: isBackInFlight(seat, i) ? 'card--incoming' : undefined,
        }),
      )
    }
    if (side) fitSideStack(backRow, show, sideW)
  }

  /* ---- 中央：牌堆 + 人类座位信息（本墩的牌已挪到南家自己的出牌区） ---- */
  {
    const box = q('center')
    const isWinner = leadSeat === HUMAN_SEAT
    const full = (s.hands[HUMAN_SEAT] as readonly Card[]).length
    // 逐张发牌期间「手上几张」按已发到的算，别一上来就写 25
    const held = s.phase === 'contract' ? Math.min(full, s.revealed) : full
    // 牌堆：108 张全部派完 —— 前 25 轮每家各得 1 张，第 26 轮起每轮只有庄家得 1 张
    //（庄家共 33 张）。它同时是发牌飞行轨迹的起点（见 ui/dealFly.ts），发完即消失。
    const left = Math.max(0, DECK_SIZE - dealtCount(s.revealed))
    const deck =
      s.phase === 'contract' && left > 0
        ? `<div class="deck" data-slot="deck" aria-hidden="true">
        <i class="deck__layer"></i><i class="deck__layer"></i><i class="deck__layer"></i>
        <span class="deck__count">${left}</span>
      </div>`
        : ''
    box.innerHTML = `<div class="seat-tag${isWinner ? ' is-win' : ''}">
        ${SEAT_LABEL[HUMAN_SEAT]} · ${held} 张 · ${roleTag(s, HUMAN_SEAT)}
      </div>${deck}`
  }

  /* ---- 南家（你）：自己的出牌区在手牌正前方 ---- */
  {
    fillPlays(q('plays-mine'), s, HUMAN_SEAT, playedW, tinyW, leadSeat)
    // 提示条浮在手牌区之上 ⇒ 实测出牌区高度后回写变量
    const box = q('plays-mine')
    root.style.setProperty('--plays-h', box.offsetHeight ? `${box.offsetHeight + 6}px` : '0px')
  }

  /* ---- 积分栏（顶部）---- */
  {
    const bar = q('status')
    const teamA = `队A ${levelLabel(s.levels.a)}`
    const teamB = `队B ${levelLabel(s.levels.b)}`
    bar.innerHTML = `
      <span>${teamA}</span><i></i>
      <span>${teamB}</span><i></i>
      <span>闲家得分 <b>${s.defenderScore}</b> / 200</span><i></i>
      <span>${
        s.phase === 'settle' || s.phase === 'over'
          ? // 一墩出对子/拖拉机时一次耗多张牌，实际墩数会少于 25。
            // 结算时还写「第 23 / 25 墩」会让人以为没打完。
            `共 ${s.history.length} 墩`
          : `第 ${s.tricksDone + (s.phase === 'play' ? 1 : 0)} / 25 墩`
      }</span>
      ${s.bottomScore > 0 ? `<i></i><span>底分 <b>${s.bottomScore}</b></span>` : ''}
    `
  }

  /* ---- 我的手牌 ---- */
  {
    const hand = q('hand')
    const fullHand = s.hands[HUMAN_SEAT] as readonly Card[]
    // 逐张发牌：只渲染已经发到手上的那部分（hands 里始终是完整的 25 张）
    const myHand = s.revealed < fullHand.length ? fullHand.slice(0, s.revealed) : fullHand
    const items = handView(myHand, ctxOf(s))
    const selected = new Set(s.selected)
    const hinted = new Set(s.hintIds)
    // 回放期间手牌不可点（看的是历史墩，点牌没有意义）
    const canAct = s.phase === 'play' && turn === HUMAN_SEAT && s.replayAt === null
    const burying = s.phase === 'bury'

    for (let i = 0; i < items.length; i++) {
      const item = items[i] as (typeof items)[number]
      const c = item.card
      const on = selected.has(c.id)
      const isHint = hinted.has(c.id)
      const cls = [
        on ? 'card--selected' : '',
        isHint ? 'card--hint' : '',
        // 这张牌还在从牌堆飞过来 ⇒ 先占位不显形，落地那帧由 dealFly 揭开（见 ui/dealFly.ts）
        isInFlight(c.id) ? 'card--incoming' : '',
        item.gapBefore ? 'card--gap' : '',
      ]
        .filter(Boolean)
        .join(' ')
      const el = cardEl(c, {
        cls,
        id: c.id,
      })
      if (burying) el.classList.add('is-pickable')
      else if (!canAct) el.classList.add('card--disabled')
      // NFR-10：可操作时牌可 Tab 聚焦，回车切换选中
      if (burying || canAct) {
        el.tabIndex = 0
        el.setAttribute('role', 'button')
        el.setAttribute('aria-pressed', on ? 'true' : 'false')
        el.setAttribute('aria-label', isHint ? `第 ${c.id} 张牌（提示）` : `第 ${c.id} 张牌`)
      }
      hand.appendChild(el)
    }
    if (items.length === 0) hand.innerHTML = '<div class="hand-empty">手牌已出完</div>'

    // 手牌重叠率按容器宽度反算（分组间隔一起计入），保证任意张数都铺得下且角标可见
    // 花色分组间隔 = 卡宽的 20%（与 CSS 的 --suit-gap 同源，避免两处各写一个数）
    fitHand(hand, items.length, gapCountOf(items))
  }

  /* ---- 手牌操作条 ---- */
  {
    const bar = q('handbar')
    if (s.phase === 'bury') {
      bar.innerHTML = `
        <span class="hint-text">选 8 张扣底（已选 ${s.selected.length} / 8）</span>
        <button class="btn btn--primary" data-act="bury" ${s.selected.length === 8 ? '' : 'disabled'}>扣底</button>`
    } else if (s.phase === 'play') {
      const myTurn = turn === HUMAN_SEAT
      const rep = replaySummary(s)
      if (rep !== null) {
        bar.innerHTML = `
          <button class="btn" data-act="replayStep" data-val="-1" ${rep.isFirst ? 'disabled' : ''}>◀ 上一墩</button>
          <span class="hint-text">回放 第 ${rep.index + 1} / ${rep.total} 墩 · ${rep.winnerLabel} 赢${
            rep.score > 0 ? ` · ${rep.score} 分` : ''
          }</span>
          <button class="btn" data-act="replayStep" data-val="1" ${rep.isLast ? 'disabled' : ''}>下一墩 ▶</button>
          <button class="btn btn--primary" data-act="replayExit">退出回放</button>`
        return
      }
      bar.innerHTML = `
        <span class="hint-text">${myTurn ? '轮到你了' : `${SEAT_LABEL[turn ?? 0]} 出牌中…`}</span>
        ${legalityBadge(s)}
        <button class="btn" data-act="undo" ${act.canUndo ? '' : 'disabled'}>悔牌</button>
        <button class="btn" data-act="clear" ${s.selected.length ? '' : 'disabled'}>取消</button>
        <button class="btn" data-act="hint" ${myTurn ? '' : 'disabled'}>提示</button>
        <button class="btn btn--primary" data-act="play" ${myTurn && s.selected.length ? '' : 'disabled'}>出牌</button>`
    } else {
      bar.innerHTML = ''
    }
  }

  /* ---- 弹层 ---- */
  {
    const ov = q('overlay')
    /**
     * 换弹层内容，并把面板的滚动位置恢复回去。
     *
     * 设置面板有两屏高，点任意一个开关都会重建 ⇒ 不恢复就会跳回顶端（用户反馈）。
     * 滚动值在 `root.innerHTML` 之前就量好了（见 render 开头）。
     */
    const fillOverlay = (html: string): void => {
      ov.innerHTML = html
      if (savedOverlayScroll === 0) return
      const next = ov.querySelector<HTMLElement>('.panel')
      // 只在「还是同一个面板」时恢复 —— 从设置切到结算不该带着上一个面板的滚动
      if (next !== null && (next.getAttribute('aria-label') ?? '') === savedOverlayLabel) {
        next.scrollTop = savedOverlayScroll
      }
    }
    // 发牌暂停提示时把手牌露出来（否则遮罩+模糊让人看不清自己有什么牌）
    ov.dataset.mode = s.phase === 'contract' && s.dealPrompt ? 'deal' : ''
    if (s.replayAt !== null) {
      // 回放时牌桌必须可见 —— 记录/结算面板一律让路
      fillOverlay('')
    } else if (s.confirmNew) {
      fillOverlay(confirmNewPanel(s))
    } else if (s.settingsOpen) {
      fillOverlay(settingsPanel(s))
    } else if (s.logOpen) {
      fillOverlay(logPanel(s))
    } else if (s.phase === 'contract') {
      const totalHand = (s.hands[HUMAN_SEAT] as readonly Card[]).length
      // 全局发牌轮次口径：第 26..33 轮只有庄家得牌，非庄家人类也要等这 8 轮
      // 发完才弹定主面板（否则牌还在飞，面板先出来了）。
      const stillDealing = s.revealed < DEAL_TOTAL
      if (stillDealing && !s.dealPrompt) {
        // 正在逐张发牌且还没到该决定的时候 —— 不弹面板，把牌桌让出来
        fillOverlay('')
      } else {
      // 反主阶段看 counterOptions（还持别门级牌的那几门）；
      // 首次亮主阶段看 declareOptions（持该门级牌的那几门 + 无将）。
      // 统一由清单决定置灰 —— 规则判定在 app 层，UI 不再自己推。
      const countering = s.counterPending
      const allowed = new Set<string>((countering ? s.counterOptions : s.declareOptions).map(String))
      // 反主门槛 = 当前张数 + 1（每门级牌只有 2 张 ⇒ 最多抬到 2 张，没有「第三级」）
      const need = s.trumpCount + 1
      const title = !countering ? '定主' : s.counterOptions.length > 0 ? '反主' : '加固'
      const stateText = countering
        ? ` · 当前主 <b>${trumpLabel(s.trump)}</b> · <b>${s.trumpCount}</b> 张`
        : stillDealing
          ? // 「已发」按人类自己的到手张数算（第 26..33 轮是庄家独得，人类不涨）
            ` · 已发 <b>${Math.min(s.revealed, totalHand)}</b> / ${totalHand} 张，摸到级牌可以先抢`
          : ''
      // 无将按钮为什么是灰的：只在「发完后首次定主」的面板上解释。
      // 中途面板（stillDealing）本来就不列无将，反主面板也不列，说这句反而误导。
      const ntNeedsJoker =
        !countering && !stillDealing && !s.forcedNT && !allowed.has('NT')
      const note =
        s.guardBy !== null
          ? `<p class="trump-note">已加固：反主门槛升到 <b>${need}</b> 张（锁死）</p>`
          : countering && s.counterOptions.length > 0
            ? `<p class="trump-note">反主需 <b>${need}</b> 张该门级牌</p>`
            : ntNeedsJoker
              ? '<p class="trump-note">无将需持<b>一对王</b>（一对小王 或 一对大王）</p>'
              : ''
      const guardBtn = s.guardOption
        ? `<div class="trump-actions"><button class="btn btn--primary guard-btn" data-act="guard">加固（需 ${GUARD_NEED} 张同花色级牌）</button></div>`
        : ''
      // 亮主按钮三态（对齐原版按钮的三态：已亮 / 可亮 / 不可选，文档里记作 U/D/X）
      //
      // 优先级：**已亮 > 不可选 > 可亮**。
      //   - 已亮：该按钮的花色正是当前主，且确实有人亮过主。
      //     `trumpDeclarer === null` 是「首次亮主阶段还没人亮」，此时主字段虽然
      //     有个默认值（'NT'），但不能把它当成「已亮」—— 否则开局就有一个按钮
      //     显示「已亮」，玩家会以为已经定完主了。
      //   - 已亮也 disabled：点自己没有再亮一次的道理。
      //     视觉上靠 `.is-current`（高亮边框 + 「已亮」角标）与普通置灰区分，
      //     不只靠颜色 —— 同时给 `aria-pressed` + `title`，读屏也能拿到状态。
      const trumpBtn = (t: Trump, label: string, cls = ''): string => {
        const v = String(t)
        const isCurrent = s.trumpDeclarer !== null && String(s.trump) === v
        const disabled = isCurrent || !allowed.has(v)
        const stateCls = isCurrent ? ' is-current' : ''
        const a11y = isCurrent ? ' aria-pressed="true" title="当前主"' : ''
        const tag = isCurrent ? '<span class="trump-btn__tag">已亮</span>' : ''
        return `<button class="btn trump-btn${cls}${stateCls}" data-trump="${v}"${disabled ? ' disabled' : ''}${a11y}>${label}${tag}</button>`
      }
      fillOverlay(`
        <div class="panel">
          <h2>${title}</h2>
          <p class="muted">本局打 <b>${levelLabel(s.levelRank)}</b>${s.forcedNT ? '（打王级强制无将）' : ''}${stateText}</p>
          <div class="trump-grid">
            ${trumpBtn(0, SUIT_LABEL[0] as string)}
            ${trumpBtn(1, SUIT_LABEL[1] as string, ' is-red')}
            ${trumpBtn(2, SUIT_LABEL[2] as string)}
            ${trumpBtn(3, SUIT_LABEL[3] as string, ' is-red')}
            ${trumpBtn('NT', '无将')}
          </div>
          ${note}
          ${guardBtn}
          ${
            countering
              ? '<div class="trump-actions"><button class="btn btn--ghost" data-act="passCounter">过（不反）</button></div>'
              : stillDealing
                ? '<div class="trump-actions"><button class="btn btn--ghost" data-act="passDeal">继续发牌</button></div>'
                : ''
          }
        </div>`)
      }
    } else if (s.phase === 'settle' || s.phase === 'over') {
      fillOverlay(settlePanel(s))
    } else {
      fillOverlay('')
    }
  }

  /* ---- 提示条 ---- */
  {
    const t = q('toast')
    // 拒绝原因只走底部操作条里的 legalityBadge —— 那里紧挨着「出牌」按钮，
    // 而 toast 浮在手牌上方会挡住牌。两处都写等于同一句话说两遍（v1.3.22 实测）。
    const msg = s.notice
    // 弹层（定主/反主/结算/设置/记录）打开时 toast 让路：
    // 否则它会盖住面板底部的按钮（「过」「扣底」），把点击吃掉。
    const modalOpen = (q('overlay') as HTMLElement).innerHTML !== ''
    if (msg) {
      t.className = `toast is-show${s.lastReject ? ' is-error' : ''}${modalOpen ? ' is-modal' : ''}`
      t.textContent = msg
      t.onclick = () => act.dispatch({ type: 'dismissNotice' })
    } else {
      t.className = 'toast'
      t.textContent = ''
      t.onclick = null
    }
  }

  bind(root, s, act)
}

/**
 * 「重新开局」二次确认。
 *
 * 顶栏的「新游戏」紧挨着「设置 / 记录」，出牌途中误点一次就会清掉整局进度
 * （`dispatch` 里还会 `clearState()` 清存档）。这里先问一次。
 * 定主阶段（还没开打）不弹，直接重开。
 */
export function confirmNewPanel(s: GameState): string {
  const progress = s.phase === 'bury' ? '还没扣底' : `第 ${Math.min(s.tricksDone + 1, 25)} 墩`
  return `<div class="panel" role="dialog" aria-label="重新开局确认">
    <h2>重新开局？</h2>
    <p class="muted">第 ${s.round} 局 · ${progress} · 当前进度会丢失（存档一并清掉）。</p>
    <div class="panel-actions">
      <button class="btn" data-act="cancelNew">取消</button>
      <button class="btn btn--primary" data-act="confirmNew">重新开局</button>
    </div>
  </div>`
}

export /**
 * 记牌器（v1.3.14）：一行显示「未出 / 总数」。
 *
 * 口径：只统计**已经打出来的牌**，底牌 8 张谁也不知道，所以算在「未出」里。
 * 关掉时返回空串 —— `#app` 的网格行是 auto，空 div 高度为 0，不占地方。
 */
function counterStrip(s: GameState): string {
  if (!s.showCounter) return ''
  const c = counterView(s)
  const item = (label: string, slot: CounterSlot): string =>
    `<span class="counter__item${slot.left === 0 ? ' is-done' : ''}">${label} <b>${slot.left}</b>/${slot.total}</span>`
  return `<div class="counter" data-slot="counter" title="记牌器：未出 / 总数（底牌 8 张谁也不知道，算在「未出」里）">
      ${item('大王', c.bigJoker)}
      ${item('小王', c.smallJoker)}
      ${item('主级', c.levelTrump)}
      ${item('副级', c.levelOff)}
      ${item('主', c.trumps)}
      <span class="counter__item${c.pointsPlayed >= c.pointsTotal ? ' is-done' : ''}">分 <b>${c.pointsPlayed}</b>/${c.pointsTotal}</span>
    </div>`
}

export function settlePanel(s: GameState): string {
  const r = s.lastSettle
  if (!r) return ''
  const over = s.phase === 'over'
  const rows: string[] = []
  rows.push(`<div class="row"><span>闲家得分</span><b>${r.defenderScore}</b></div>`)
  rows.push(`<div class="row"><span>${r.dealerChanged ? '闲家上台' : '庄家方继续'}</span><b>${r.levels} 级</b></div>`)
  if (r.actualLevels !== r.levels) {
    rows.push(
      `<div class="row"><span>必打截断</span><b>实际升 ${r.actualLevels} 级${r.guardLevel ? `（停在 ${levelLabel(r.guardLevel)}）` : ''}</b></div>`,
    )
  }
  rows.push(`<div class="row"><span>下一局</span><b>${SEAT_LABEL[r.newDealer]}坐庄</b></div>`)
  rows.push(`<div class="row"><span>级牌</span><b>队A ${levelLabel(r.newLevels.a)} · 队B ${levelLabel(r.newLevels.b)}</b></div>`)

  return `<div class="panel">
    <h2>${over ? `游戏结束 · ${r.winnerTeam === 0 ? '队A' : '队B'} 获胜` : '本局结算'}</h2>
    ${rows.join('')}
    <div class="panel-actions">
      <!-- 结算弹层会盖住顶栏，「记录」按钮点不到 ⇒ 这里补一个入口，
           打完一局立刻能复盘（logOpen 优先级高于 settle，关闭后回到本面板） -->
      <button class="btn" data-act="toggleLog">查看记录</button>
      <button class="btn btn--primary" data-act="nextRound">${over ? '再来一局' : '下一局'}</button>
    </div>
  </div>`
}

/**
 * FR-19 ①：选牌时实时显示合法性。
 * 复用 core 的 checkPlay，UI 不自己判断规则。
 */
function legalityBadge(s: GameState): string {
  if (s.phase !== 'play' || s.selected.length === 0) return ''
  if (seatToPlay(s) !== HUMAN_SEAT) return ''

  const hand = s.hands[HUMAN_SEAT] as readonly Card[]
  const idSet = new Set(s.selected)
  const cards = hand.filter((c) => idSet.has(c.id))
  if (cards.length === 0) return ''

  const leadPlay = s.trick.plays[0] as Play | undefined
  const result = checkPlay({
    hand,
    cards,
    ctx: ctxOf(s),
    ...(leadPlay ? { lead: { cards: leadPlay.cards, analysis: leadPlay.analysis } } : {}),
    opponents: [1, 2, 3].map((x) => s.hands[x] as readonly Card[]),
  })

  return legalityBadgeOf(result)
}

/**
 * PlayResult → 徽标 HTML 的映射。
 *
 * 抽成导出纯函数是为了让 node 环境的 vitest 能直接测三分支，
 * 不必构造整个 GameState（docs/08 RISK-04：UI 只原样消费 core 的结果）。
 *
 * 三分支：
 *   - 直接合法            → 绿色「✓ 可以出」
 *   - 甩牌失败被裁剪      → 琥珀色警告：明确告知只会出 N 张。
 *     不警告的话，玩家选 6 张甩牌看到「可以出」，点下去只掉最小的 2 张，
 *     观感像 bug（ADR-008 的 UI 侧配套）。
 *   - 不合法              → 红色「✕ 原因」
 */
export function legalityBadgeOf(result: PlayResult): string {
  if (!result.ok) {
    return `<span class="legality is-bad">✕ ${escapeHtml(result.detail)}</span>`
  }
  if (result.adjusted) {
    return `<span class="legality is-warn">⚠ ${escapeHtml(result.detail)}（将只出 ${result.cards.length} 张）</span>`
  }
  return `<span class="legality is-ok">✓ 可以出</span>`
}

/** 设置面板（FR-18）—— 导出给单测断言内容用 */
/**
 * AI 出牌速度档位（毫秒 = 出牌前等多久，所以**数字越大越慢**）。
 *
 * 早先写成「0 瞬时 / 300 慢 / 800 中」—— 标签和数值是反的（中比慢还慢），
 * 而且默认值 420 根本不在选项里，三个按钮一个都不高亮。
 */
const AI_SPEED_OPTS = [
  { v: '0', label: '瞬时' },
  { v: '300', label: '中' },
  { v: '800', label: '慢' },
] as const

/** 把任意历史值吸附到最近的档位（老存档里可能存着 420 这种不在选项里的值） */
function nearestSpeed(ms: number): string {
  let best = AI_SPEED_OPTS[0].v as string
  let dist = Infinity
  for (const o of AI_SPEED_OPTS) {
    const d = Math.abs(Number(o.v) - ms)
    if (d < dist) {
      dist = d
      best = o.v
    }
  }
  return best
}

/** 规则项的中文名（「改动未生效」提示要逐条列出来） */
const RULE_LABEL: Record<keyof RuleConfig, string> = {
  allowSelfCounter: '允许自反',
  twoAsPermanent: '2 为常主',
  allowPartnerGuard: '允许对家保',
  allowCounterNT: '允许反无将',
  guardScoreLevels: '5,10,K 必打',
  guardJack: 'J 必打',
  guardAce: 'A 必打',
  guardKingLevel: '打王必打',
}

/**
 * 设置面板顶部的「规则改动未生效」警告条。
 *
 * 只在「待生效 ≠ 当前生效」时出现 —— 规则开关是**下一局**生效，玩家改完
 * `2 为常主` 回头看手牌，发现 2 还排在副牌段末尾，很容易以为功能坏了
 * （v1.3.18 用户反馈）。把「改了哪几项、本局仍按旧规则」直接写出来。
 *
 * 没有改动时返回空串：每个分组的标题右侧已经写明「立即生效 / 改完下一局生效」，
 * 再挂一句通栏说明是重复。
 */
function ruleNote(pending: RuleConfig, live: RuleConfig): string {
  const changed = (Object.keys(RULE_LABEL) as (keyof RuleConfig)[]).filter((k) => pending[k] !== live[k])
  if (changed.length === 0) return ''
  return (
    '<p class="set-warn">⚠ 已改 ' +
    changed.map((k) => `<b>${RULE_LABEL[k]}</b>`).join('、') +
    ' —— <b>本局仍按旧规则</b>进行，点「下一局」或「新游戏」后才生效。</p>'
  )
}

export function settingsPanel(s: GameState): string {
  const c = s.pendingConfig
  /** 规则开关：写 pendingConfig，下一局生效 */
  const sw = (key: string, label: string, desc: string, on: boolean): string => `
    <div class="set-row">
      <span>${label}<small class="set-desc">${desc}</small></span>
      <button class="switch" role="switch" aria-checked="${on ? 'true' : 'false'}" data-cfg="${key}" aria-label="${label}"></button>
    </div>`

  /** 体验开关：直接改 state，立即生效 */
  const swAct = (act: string, label: string, desc: string, on: boolean): string => `
    <div class="set-row">
      <span>${label}<small class="set-desc">${desc}</small></span>
      <button class="switch" role="switch" aria-checked="${on ? 'true' : 'false'}" data-act="${act}" aria-label="${label}"></button>
    </div>`

  const seg = (
    act: string,
    name: string,
    opts: { v: string; label: string; on: boolean }[],
    side?: 'partner' | 'opponent',
  ): string => `
    <div class="seg" role="group" aria-label="${name}">
      ${opts
        .map(
          (o) =>
            `<button data-act="${act}" data-val="${o.v}"${side ? ` data-side="${side}"` : ''} class="${o.on ? 'is-on' : ''}" aria-pressed="${o.on ? 'true' : 'false'}">${o.label}</button>`,
        )
        .join('')}
    </div>`

  const sizeOpts = (['S', 'M', 'L'] as CardSize[]).map((v) => ({
    v,
    label: `${v}（${CARD_SIZE_PX[v]}px）`,
    on: s.cardSize === v,
  }))

  /**
   * 一个设置分组。
   *
   * `hint` 写在组标题右侧，用来说明「这一组什么时候生效」——
   * 之前全靠顶部一句通栏说明，玩家滚到下面早忘了。
   */
  const group = (tab: SettingsTab, title: string, hint: string, body: string): string => `
    <div class="set-group" data-tab="${tab}">
      <h3>${title}<small>${hint}</small></h3>
      ${body}
    </div>`

  /** 组内子标题（带分隔线），用于「音量」「升级必打」这类二级分类 */
  const sub = (title: string, note = ''): string =>
    `<div class="set-sub">${title}${note ? `<small>${note}</small>` : ''}</div>`

  return `<div class="panel panel--wide" role="dialog" aria-label="设置" data-settings-tab="${settingsTab}">
    <h2>设置</h2>
    <div class="set-tabs" role="tablist" aria-label="设置分类">
      ${SETTINGS_TABS.map(
        (t) =>
          `<button role="tab" data-act="settingsTab" data-val="${t.key}" aria-selected="${settingsTab === t.key}" class="${settingsTab === t.key ? 'is-on' : ''}">${t.label}</button>`,
      ).join('')}
    </div>
    ${ruleNote(c, s.config)}

    ${group(
      'game',
      '牌局',
      '对手强度与节奏 · 立即生效',
      `<div class="set-row">
        <span>对家 AI<small class="set-desc">座位 2（你的队友）</small></span>
        ${seg(
          'setAiLevelSide',
          '对家 AI 难度',
          AI_LEVEL_OPTS.map((o) => ({ ...o, on: s.aiLevelPartner === Number(o.v) })),
          'partner',
        )}
      </div>
      <div class="set-row">
        <span>敌家 AI<small class="set-desc">座位 1 / 3（对手）</small></span>
        ${seg(
          'setAiLevelSide',
          '敌家 AI 难度',
          AI_LEVEL_OPTS.map((o) => ({ ...o, on: s.aiLevelOpponent === Number(o.v) })),
          'opponent',
        )}
      </div>
      <div class="set-row">
        <span>AI 出牌速度<small class="set-desc">快一点更好打；想看清每张牌就调慢</small></span>
        ${seg('setAiSpeed', 'AI 出牌速度', AI_SPEED_OPTS.map((o) => ({ ...o, on: o.v === nearestSpeed(s.aiSpeedMs) })))}
      </div>`,
    )}

    ${group(
      'view',
      '画面',
      '视觉与操作辅助 · 立即生效',
      `<div class="set-row">
        <span>牌面尺寸</span>
        ${seg('setCardSize', '牌面尺寸', sizeOpts)}
      </div>
      <div class="set-row">
        <span>动画</span>
        ${seg('toggleAnimation', '动画', [
          { v: 'on', label: '开', on: s.animation },
          { v: 'off', label: '关', on: !s.animation },
        ])}
      </div>
      <div class="set-row">
        <span>动画速度<small class="set-desc">发牌 / 出牌 / 收墩 / 手牌重排</small></span>
        ${seg('setAnimSpeed', '动画速度', [
          { v: 'slow', label: '慢', on: s.animSpeed === 'slow' },
          { v: 'normal', label: '中', on: s.animSpeed === 'normal' },
          { v: 'fast', label: '快', on: s.animSpeed === 'fast' },
        ])}
      </div>
      ${swAct('toggleShowHistory', '各家出牌留痕', `各家面前显示最近 ${PAST_DEPTH} 墩的历史小牌`, s.showHistory)}
      ${swAct('toggleShowCounter', '记牌器', '牌桌上方显示未出的王 / 级牌 / 主牌 / 已出分（辅助工具，默认关）', s.showCounter)}
      ${swAct('toggleHintSelects', '提示即选中', '点「提示」直接选中提示的牌（会覆盖已选牌，并写入存档）', s.hintSelects)}`,
    )}

    ${group(
      'sound',
      '声音',
      'BGM 与音效 · 立即生效',
      `<div class="set-row">
        <span>音乐主题<small class="set-desc">四季各一条旋律，切换后下一小节生效</small></span>
        <select class="set-select" data-sound="theme" aria-label="音乐主题">
          ${THEME_ORDER.map(
            (k) => `<option value="${k}"${s.musicTheme === k ? ' selected' : ''}>${THEMES[k].name}</option>`,
          ).join('')}
        </select>
      </div>
      ${swAct('toggleAutoVariation', '根据剧情自动变奏', '关闭后永远是同一套编排、不转调', s.autoVariation)}
      ${swAct('toggleSoundEnhanced', '增强音效', 'BGM 改用 Tone.js 引擎（更细腻；首次需联网加载，失败自动退回）', s.soundEnhanced)}
      ${sub('音量')}
      <div class="set-row">
        <span>总音量</span>
        <input class="set-range" type="range" min="0" max="100" step="1" value="${s.volumeMaster}" data-vol="master" aria-label="总音量" />
        <b class="set-num">${s.volumeMaster}</b>
      </div>
      <div class="set-row">
        <span>BGM 音量</span>
        <input class="set-range" type="range" min="0" max="100" step="1" value="${s.volumeBgm}" data-vol="bgm" aria-label="BGM 音量" />
        <b class="set-num">${s.volumeBgm}</b>
      </div>
      <div class="set-row">
        <span>音效音量</span>
        <input class="set-range" type="range" min="0" max="100" step="1" value="${s.volumeSfx}" data-vol="sfx" aria-label="音效音量" />
        <b class="set-num">${s.volumeSfx}</b>
      </div>`,
    )}

    ${group(
      'rule',
      '规则',
      '改完下一局生效',
      `${sw('allowSelfCounter', '允许自反', '同队也可反主', c.allowSelfCounter)}
      ${sw('twoAsPermanent', '2 为常主', '两张 2 恒为主牌', c.twoAsPermanent)}
      ${sw('allowPartnerGuard', '允许对家保', '对家可保级', c.allowPartnerGuard)}
      ${sw('allowCounterNT', '允许反无将', '主动亮无将可被花色反（打王级除外）', c.allowCounterNT)}
      ${sub('升级必打', '升级时禁止跳级，与出牌无关')}
      ${sw('guardScoreLevels', '5、10、K 必打', '升级时不可跳过这些级牌', c.guardScoreLevels)}
      ${sw('guardJack', 'J 必打', '升级时不可跳过 J', c.guardJack)}
      ${sw('guardAce', 'A 必打', '升级时不可跳过 A', c.guardAce)}
      ${sw('guardKingLevel', '打王必打', '升级时不可跳过打王级', c.guardKingLevel)}`,
    )}

    <div class="panel-foot"><button class="btn btn--primary" data-act="closeSettings">完成</button></div>
  </div>`
}

/** 对局记录面板（FR-20）：按墩分组，标赢家、得分高亮、花色着色 */
function logPanel(s: GameState): string {
  const tricks = trickLogView(s)
  const items = tricks
    .map(
      (t, i) => `<div class="log-trick" data-win-team="${t.winnerTeam}">
        <div class="log-trick__head">
          <span class="log-trick__no">第 ${t.no} 墩</span>
          <span class="log-trick__win">${t.winnerLabel} 赢</span>
          ${t.score > 0 ? `<span class="log-trick__pts is-score">${t.score} 分</span>` : ''}
          <button class="btn btn--mini" data-act="replayStart" data-val="${i}">回放</button>
        </div>
        <div class="log-trick__plays">
          ${t.plays
            .map(
              (p) => `<div class="log-play" data-win="${p.isWinner ? 'true' : 'false'}">
              <span class="log-play__seat">${p.label}</span>
              <span class="log-play__cards">${p.cards
                .map(
                  (c) =>
                    `<span class="log-card"${c.suit !== null ? ` data-suit="${c.suit}"` : ''}${
                      c.isTrump ? ' data-is-trump="true"' : ''
                    }>${c.text}</span>`,
                )
                .join('')}</span>
            </div>`,
            )
            .join('')}
        </div>
      </div>`,
    )
    .join('')

  return `<div class="panel panel--wide" role="dialog" aria-label="对局记录">
    <h2>对局记录</h2>
    <p class="muted">已打完 ${s.history.length} 墩（仅内存，不写存档）</p>
    ${items ? `<div class="log-list">${items}</div>` : '<div class="log-empty">还没有打完的墩</div>'}
    <div class="panel-foot"><button class="btn btn--primary" data-act="toggleLog">关闭</button></div>
  </div>`
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

export interface HandFit {
  /** 花色分组间隔（px，已取整） */
  readonly gap: number
  /** 每张牌前进的比例（× 卡宽）；1 = 完全不重叠 */
  readonly step: number
}

/**
 * 手牌排布求解：给定可用宽度与卡宽，算出「分组间隔」和「重叠步长」。
 *
 * 抽成纯函数是为了能单测（`tests/ui/handFit.test.ts`）—— 这里出过两次回归，
 * 而且都是「某个档位下间隔悄悄变成 0」这种只有肉眼才能发现的形态。
 *
 * 两个量都乘卡宽（比例），所以换 S/M/L 档位时观感一致 —— 这是 v1.2.1 定下的规矩。
 *
 * **优先级：间隔 > 步长**。旧实现反过来（先保步长、间隔当余量牺牲），
 * 于是卡越大手牌越宽，间隔就越先被牺牲掉，最后 M/L 档彻底没有分组。
 * 现在的顺序是：
 *   ① 按理想间隔（卡宽 20%）算步长，放得下就两全；
 *   ② 放不下 → 步长压到 `HAND_STEP_MIN`（角标仍可读），间隔按剩余空间等比例缩，
 *      但保底 `SUIT_GAP_MIN_RATIO`；
 *   ③ 连保底间隔都还溢出 → 让步长继续下探到 `HAND_STEP_HARD_MIN`，
 *      宁可把角标切掉一点，也不让手牌横向溢出（溢出会被 .felt 的 overflow:hidden 裁掉整张牌）。
 */
export function solveHandFit(
  avail: number,
  cardW: number,
  count: number,
  gapCount: number,
): HandFit {
  if (count <= 1 || !avail || !cardW) return { gap: 0, step: HAND_STEP_MAX }

  const steps = count - 1
  const gapMax = cardW * SUIT_GAP_RATIO
  const gapMin = cardW * SUIT_GAP_MIN_RATIO
  /** 没有分组间隔时没有「保角标」的包袱，可以压得更紧 */
  const stepFloor = gapCount > 0 ? HAND_STEP_MIN : 0.3

  let gap = gapMax
  let step = (avail - cardW - gapCount * gap) / (steps * cardW)

  if (step < stepFloor) {
    step = stepFloor
    if (gapCount > 0) {
      // ② 步长到底，间隔按剩余空间等比例缩（不高于理想值、不低于保底值）
      const room = avail - cardW - step * steps * cardW
      gap = Math.max(gapMin, Math.min(gapMax, room / gapCount))
    } else {
      // 整手牌只有一个分组：没有间隔可让，全部余量都留给步长
      gap = 0
    }
    // ③ 仍然放不下 ⇒ 让步长继续下探（间隔已经压到底了）
    const overflow = cardW + step * steps * cardW + gapCount * gap - avail
    if (overflow > 0.5) {
      step = Math.max(HAND_STEP_HARD_MIN, (avail - cardW - gapCount * gap) / (steps * cardW))
    }
  }

  // gapCount = 0 时没有分组，间隔值无意义，统一归零（别把理想值原样传出去）
  return { gap: gapCount > 0 ? Math.round(gap) : 0, step: Math.min(HAND_STEP_MAX, step) }
}

/** 把求解结果写到 `.hand` 的 CSS 变量上（DOM 侧只做这一件事） */
function fitHand(hand: HTMLElement, count: number, gapCount: number): void {
  if (count <= 1) return
  const cardW = hand.firstElementChild
    ? (hand.firstElementChild as HTMLElement).getBoundingClientRect().width
    : 92
  const avail = hand.clientWidth
  if (!avail || !cardW) return

  const { gap, step } = solveHandFit(avail, cardW, count, gapCount)
  hand.style.setProperty('--hand-gap', `${gap}px`)
  hand.style.setProperty('--hand-step', step.toFixed(3))
}

/**
 * 窗口尺寸变化后重算手牌重叠率。
 *
 * `fitHand` 只在 paint 时跑一次，把结果写成 `.hand` 上的内联 CSS 变量。
 * 之后改窗口大小不会重新 paint（改牌面尺寸会），内联值就留在旧宽度算出来的数上 ——
 * 从窄窗口拉宽后手牌会挤成一团、分组间隔也停在旧值，看着就像「间隔消失了」。
 * 这里只改 CSS 变量、不重建 DOM，代价可以忽略。
 */
export function refitHand(root: HTMLElement): void {
  const hand = root.querySelector<HTMLElement>('[data-slot="hand"]')
  if (!hand) return
  const count = hand.querySelectorAll('.card').length
  if (count <= 1) return
  fitHand(hand, count, hand.querySelectorAll('.card--gap').length)
}

/**
 * 侧家竖向牌背的重叠步长。
 *
 * 牌背 rotate(90°) 后**布局盒不变**（宽 52 / 高 72.8），只是视觉上转成了 72.8×52。
 * 布局盒仍然参与 flex 布局，所以步长必须按**布局高度**反算，
 * 否则整摞的布局高度会超出容器、压到下方「已出的牌」上。
 */
function fitSideStack(box: HTMLElement, count: number, cardW: number): void {
  if (count <= 1) return
  const avail = box.clientHeight
  if (!avail) return
  const layoutH = cardW * 1.4
  const step = Math.min(0.55, Math.max(SIDE_MIN_STEP, (avail - layoutH) / ((count - 1) * layoutH)))
  box.style.setProperty('--side-step', step.toFixed(3))
}

function bind(root: HTMLElement, s: GameState, act: Actions): void {
  /* 拖动音量滑条：置标志让 paint 别重绘，松手再解除。
     不这么做的话，每个 input 事件 dispatch 一次音量 → paint 整棵重建 →
     <input type=range> 被换成新元素 → 拖动立刻中断，只剩「点哪跳哪」。 */
  root.onpointerdown = (ev) => {
    const t = ev.target
    if (t instanceof HTMLInputElement && t.type === 'range') draggingRange = true
  }
  root.onpointerup = endRangeDrag
  root.onpointercancel = endRangeDrag
  // 指针移出窗口后松开时 root 收不到 pointerup，补一个 window 兜底（只绑一次）
  if (!windowDragBound) {
    windowDragBound = true
    window.addEventListener('pointerup', endRangeDrag)
    window.addEventListener('pointercancel', endRangeDrag)
  }

  root.onclick = (ev) => {
    const target = ev.target as HTMLElement
    // 设置标签页：只改 DOM、不 dispatch。
    // dispatch 会触发整棵重建 —— 切换标签这种纯视图动作没必要付这个代价，
    // 而且重建会把面板的滚动位置（虽然现在会恢复）和焦点都打断。
    const tabBtn = target.closest('[data-act="settingsTab"]') as HTMLElement | null
    if (tabBtn?.dataset.val) {
      const key = tabBtn.dataset.val as SettingsTab
      settingsTab = key
      const panel = tabBtn.closest('.panel') as HTMLElement | null
      if (panel !== null) {
        panel.dataset.settingsTab = key
        for (const b of panel.querySelectorAll<HTMLElement>('[data-act="settingsTab"]')) {
          const on = b.dataset.val === key
          b.classList.toggle('is-on', on)
          b.setAttribute('aria-selected', on ? 'true' : 'false')
        }
      }
      return
    }
    const cardNode = target.closest('.card[data-id]') as HTMLElement | null
    // **只认手牌**：出牌区/历史小牌也带 data-id（动画要靠它定位），
    // 但点它们不该被选中 —— 否则选完「出牌」按钮亮了、点下去又没反应
    // （v1.3.24 用户反馈：点对方已出的牌能选中）。
    if (cardNode?.dataset.id && cardNode.closest('.hand') !== null) {
      act.dispatch({ type: 'toggleSelect', id: Number(cardNode.dataset.id) })
      return
    }
    const trumpBtn = target.closest('[data-trump]') as HTMLElement | null
    if (trumpBtn?.dataset.trump) {
      const raw = trumpBtn.dataset.trump
      const trump: Trump = raw === 'NT' ? 'NT' : (Number(raw) as 0 | 1 | 2 | 3)
      act.dispatch({ type: 'declareTrump', trump })
      return
    }

    // 规则开关
    const sw = target.closest('[data-cfg]') as HTMLElement | null
    if (sw?.dataset.cfg) {
      const key = sw.dataset.cfg as keyof RuleConfig
      const current = s.pendingConfig[key]
      act.dispatch({ type: 'updateConfig', patch: { [key]: !current } })
      return
    }

    const btn = target.closest('[data-act]') as HTMLElement | null
    if (!btn) return
    const val = btn.dataset.val
    switch (btn.dataset.act) {
      case 'play':
        act.dispatch({ type: 'playSelected' })
        break
      case 'clear':
        act.dispatch({ type: 'clearSelect' })
        break
      case 'undo':
        act.undo()
        break
      case 'hint':
        act.hint()
        break
      case 'bury':
        act.dispatch({ type: 'bury', ids: [...s.selected] })
        break
      case 'passCounter':
        act.dispatch({ type: 'passCounter' })
        break
      case 'guard':
        act.dispatch({ type: 'guard' })
        break
      case 'passDeal':
        act.dispatch({ type: 'passDeal' })
        break
      case 'nextRound':
        act.dispatch({ type: 'nextRound' })
        break
      case 'askNewGame':
      case 'newGame': {
        // 出牌 / 埋底阶段先确认；定主阶段没什么可丢的，直接重开
        if (s.phase === 'play' || s.phase === 'bury') act.dispatch({ type: 'askNewGame' })
        else act.dispatch({ type: 'newGame' })
        break
      }
      case 'confirmNew':
        act.dispatch({ type: 'newGame' })
        break
      case 'cancelNew':
        act.dispatch({ type: 'cancelNewGame' })
        break
      case 'toggleFourColor':
        act.dispatch({ type: 'toggleFourColor' })
        break
      case 'openSettings':
        act.dispatch({ type: 'openSettings' })
        break
      case 'closeSettings':
        act.dispatch({ type: 'closeSettings' })
        break
      case 'toggleLog':
        act.dispatch({ type: 'toggleLog' })
        break
      case 'toggleAnimation':
        act.dispatch({ type: 'toggleAnimation' })
        break
      case 'toggleShowHistory':
        act.dispatch({ type: 'toggleShowHistory' })
        break
      case 'toggleHintSelects':
        act.dispatch({ type: 'toggleHintSelects' })
        break
      case 'toggleShowCounter':
        act.dispatch({ type: 'toggleShowCounter' })
        break
      case 'toggleSoundEnhanced':
        act.dispatch({ type: 'toggleSoundEnhanced' })
        break
      case 'toggleAutoVariation':
        act.dispatch({ type: 'toggleAutoVariation' })
        break
      case 'replayStart':
        if (val !== undefined) act.dispatch({ type: 'replayStart', index: Number(val) })
        break
      case 'replayStep':
        if (val !== undefined) act.dispatch({ type: 'replayStep', delta: Number(val) })
        break
      case 'replayExit':
        act.dispatch({ type: 'replayExit' })
        break
      case 'setAiLevel':
        if (val !== undefined) act.dispatch({ type: 'setAiLevel', level: Number(val) as AiLevel })
        break
      case 'setAiLevelSide':
        if (val !== undefined) {
          act.dispatch({
            type: 'setAiLevelSide',
            side: btn.dataset.side === 'partner' ? 'partner' : 'opponent',
            level: Number(val) as AiLevel,
          })
        }
        break
      case 'setAiSpeed':
        if (val !== undefined) act.dispatch({ type: 'setAiSpeed', ms: Number(val) })
        break
      case 'setCardSize':
        if (val !== undefined) act.dispatch({ type: 'setCardSize', size: val as CardSize })
        break
      case 'setAnimSpeed':
        if (val === 'slow' || val === 'normal' || val === 'fast') {
          act.dispatch({ type: 'setAnimSpeed', speed: val })
        }
        break
      default:
        break
    }
  }

  /* 声音：下拉与滑条用 change / input，不用 click */
  root.onchange = (ev) => {
    const el = ev.target as HTMLElement
    if (!(el instanceof HTMLSelectElement)) return
    if (el.dataset.sound !== 'theme') return
    if (isThemeKey(el.value)) act.dispatch({ type: 'setMusicTheme', theme: el.value })
  }

  root.oninput = (ev) => {
    const el = ev.target as HTMLElement
    if (!(el instanceof HTMLInputElement)) return
    const which = el.dataset.vol
    if (which !== 'master' && which !== 'bgm' && which !== 'sfx') return
    act.dispatch({ type: 'setVolume', which, value: Number(el.value) })
    // 滑条旁边的数字就地更新，不等整页重绘（拖动时不闪）
    const num = el.parentElement?.querySelector('.set-num')
    if (num) num.textContent = el.value
  }
}
