/**
 * 界面渲染
 *
 * 两条渲染路径：
 *   ① `render()` —— 整棵 `root` 重建（骨架 + 逐槽填充）。状态的结构性变化走这里。
 *   ② `patchSelection()` —— **只切手牌的 class 与操作条的状态**，不动 DOM 结构。
 *      选牌 / 提示是纯视觉状态，走整棵重建会把焦点、`<input>` 拖动、动画状态
 *      一起丢掉（docs/37 E-2 实测：键盘选牌后 activeElement 变成 BODY）。
 *
 * 分层铁律：本文件只消费 app 层算好的视图数据（handView / trickLogView /
 * pastPlaysView），不出现 power / 主牌判定等规则概念。
 */

import type { Card, LevelRank, Play, PlayResult, RuleConfig, RuleContext, Seat, Trump } from '@core'
import { DEAL_TOTAL, DECK_SIZE, GUARD_NEED, checkPlay, dealtCount, isSameTeam } from '@core'
import type { AiLevel } from '@ai/policy'
import { THEMES, THEME_ORDER, isThemeKey } from '@audio/scenes'
import type { Action, CardSize, GameState } from '@app/state'
import { CARD_SIZE_PX, HUMAN_SEAT, ctxOf, seatToPlay } from '@app/state'
import { gapCountOf, handView } from '@app/handView'
import { hintExplain } from '@app/hintView'
import { statsLine } from '@app/stats'
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
import { backEl, cardEl, cardName, cardSpokenName, ensureDefs } from './card'
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

/* ---------- 明牌作弊（showOppHands）的几何 ----------
   三家各 25 张要全部摊开（牌背模式只露 10 张），所以牌面必须比牌背小一号，
   否则一列 25 张纵向能到 500px、直接盖住出牌区。 */
/** 明牌小牌宽度占卡宽的比例（窄屏再压一档：北家横排 25 张才铺得下） */
const REVEAL_RATIO = 0.34
const REVEAL_RATIO_NARROW = 0.26
/** 横排（北家）每张露出的宽度比例：左上角标约占 24%，45% 既能看清点数又留足重叠 */
const REVEAL_STEP_RATIO = 0.45
/**
 * 竖排（西/东）步长下限 = 牌高的 29.5%（M 档小牌 71px 高 ⇒ 21px）。
 *
 * 不是拍脑袋：左上角标在 SVG 里占 y 8~40（点数 8~23、花色 26~40），
 * 牌高 71px 时花色下沿落在 20.3px —— 露出少于 21px 就只剩点数、看不见花色，
 * ♠K 和 ♥K 分不出来。宁可多折一列也不能少露这 1px。
 * 按比例而不是写死 px：手机档卡宽只有 44px，写死 21px 会变成「牌间空隙」。
 */
const REVEAL_MIN_STEP_RATIO = 0.295
/** 小牌宽度下限：手机档卡宽 44px × 0.26 = 11px，点数都糊了，至少给 30px */
const REVEAL_MIN_W = 30
/** 分组间隔占小牌宽的比例（与玩家手牌的分组间隔同一意图，只是跟着小牌缩放） */
const REVEAL_GAP_RATIO = 0.35
/** AI 四档（弱 / 中 / 强 / 超强） */
const AI_LEVEL_OPTS = [
  { v: '0', label: '弱' },
  { v: '1', label: '中' },
  { v: '2', label: '强' },
  { v: '3', label: '超强' },
] as const

/** 顶栏用的短标签（对手档位；队友档位在设置里看） */
const AI_LEVEL_LABEL: Record<AiLevel, string> = { 0: '弱', 1: '中', 2: '强', 3: '超强' }

/** 级牌标签：下标与 `core/cards.ts` 的 rank 序一致（0 = 2 … 12 = A） */
const LEVEL_LABELS = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'] as const

/**
 * 级牌显示名。
 *
 * `LevelRank` 不是 rank 下标：1 = A、2 = 2 … 11 = J、12 = Q、13 = K、18 = 打王级。
 * 映射公式与 `core/cards.ts` 的 `levelRankToRankIndex` **必须一致**（`(lr+11)%13`）。
 *
 * v1.3.29 之前这里是 `return String(lr)`，于是打 J/Q/K 时顶栏显示
 * 「打 11 / 打 12 / 打 13」—— 玩家看到的是内部编号（docs/31 遗留 P2，docs/35 F1 修）。
 */
export function levelLabel(lr: LevelRank): string {
  if (lr === 18) return '打王'
  return (LEVEL_LABELS[(lr + 11) % 13] ?? '?') as string
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
  if (isSameTeam(seat, s.dealer)) {
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

/**
 * 手牌元素的复用缓存：`id → { el, sig }`。
 *
 * 牌面是一整张内联 SVG（约 1.4KB），25 张 = 35KB / 25 次 `innerHTML`。
 * 整棵重建时每出一张牌就把 25 张全序列化一遍 —— 实测单次 render 16ms，
 * 其中一半以上花在这里（docs/34 D-3）。
 *
 * 签名（`sig`）只包含**影响牌面外观的类名**：选中/提示/飞行中/分组间隔/可点态。
 * 签名没变就直接搬同一个节点（`appendChild` 移动而非复制），变了才重建。
 *
 * 放模块级而不是函数内：`render()` 每次调用都是新的栈帧，缓存必须跨调用存活。
 */
const handCardCache = new Map<number, { el: HTMLElement; sig: string }>()

/**
 * 「挂机」按钮（在手牌操作条上，悔牌左侧）。
 *
 * 按钮文案随状态变：`挂机` ⇄ `挂机中`。用 `aria-pressed` 同步状态，
 * 读屏用户也能知道现在是不是在挂机（不只靠文字颜色）。
 */
function autoBtn(s: GameState): string {
  return `<button class="btn${s.autoPlay ? ' btn--on' : ''}" data-act="autoPlay" aria-pressed="${
    s.autoPlay ? 'true' : 'false'
  }" title="${s.autoPlay ? '挂机中：所有操作由 AI 代打，点一下取消' : '挂机：让 AI 替你出牌、抢主、扣底'}">${
    s.autoPlay ? '挂机中' : '挂机'
  }</button>`
}

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
        <span>第 <b>${esc(s.round)}</b> 局</span>
        <span>打 <b>${esc(levelLabel(s.levelRank))}</b></span>
        <span>主 <b>${esc(trumpLabel(s.trump))}</b></span>
        <span>庄 <b>${esc(SEAT_LABEL[s.dealer])}</b></span>
        <!-- AI 档位必须可见（v1.3.29）：它以前只藏在设置面板里，用户根本不知道
             自己一直在打「中」档 —— 「AI 太弱智」的反馈和「L3 已经很强」的事实
             完全对不上。顺带补上「主」「庄」两处漏掉的 esc。 -->
        <span class="meta-ai" title="对手 AI 强度（设置 → 牌局 可改）">AI <b>${esc(AI_LEVEL_LABEL[s.aiLevelOpponent])}</b></span>
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

    <main class="felt${s.showOppHands ? ' felt--reveal' : ''}">
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
  // 明牌作弊要排序 ⇒ 需要规则上下文（主牌 / 级牌）。只算一次，手牌区共用。
  const ruleCtx = ctxOf(s)
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
        ${esc(SEAT_LABEL[seat])} · ${esc(hand.length)} 张 · ${roleTag(s, seat)}
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
    // 作弊「查看别人手牌」：整手摊成明牌（牌背模式只露 10 张），
    // 发牌期间仍按「已发到几张」逐张长出来。纯展示，不影响任何规则判定。
    if (s.showOppHands) {
      const shown =
        s.phase === 'contract' ? Math.min(hand.length, dealtCardsFor(s, seat)) : hand.length
      fillRevealRow(backRow, hand.slice(0, shown), side, cardW, seat, ruleCtx)
      continue
    }
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
        ${esc(SEAT_LABEL[HUMAN_SEAT])} · ${esc(held)} 张 · ${roleTag(s, HUMAN_SEAT)}
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
    const teamA = `队A ${esc(levelLabel(s.levels.a))}`
    const teamB = `队B ${esc(levelLabel(s.levels.b))}`
    bar.innerHTML = `
      <span>${teamA}</span><i></i>
      <span>${teamB}</span><i></i>
      <span>闲家得分 <b>${esc(s.defenderScore)}</b> / 200</span><i></i>
      <span>${
        s.phase === 'settle' || s.phase === 'over'
          ? // 一墩出对子/拖拉机时一次耗多张牌，实际墩数会少于 25。
            // 结算时还写「第 23 / 25 墩」会让人以为没打完。
            `共 ${esc(s.history.length)} 墩`
          : // **出牌中不写分母**（v1.3.29 · docs/37 E-8）：
            // 一局实际只打 19~25 墩（对子/拖拉机/甩牌一墩吃多张），
            // 写「第 3 / 25 墩」会让人以为还有 22 墩，结算时突然变成「共 24 墩」。
            // 分母写死 25 是**上限**不是实际值，干脆不写。
            `第 ${esc(s.tricksDone + (s.phase === 'play' ? 1 : 0))} 墩`
      }</span>
      ${s.bottomScore > 0 ? `<i></i><span>底分 <b>${esc(s.bottomScore)}</b></span>` : ''}
    `
  }

  /* ---- 我的手牌 ---- */
  {
    const hand = q('hand')
    const fullHand = s.hands[HUMAN_SEAT] as readonly Card[]
    // 逐张发牌：只渲染已经发到手上的那部分（hands 里始终是完整的 25 张）
    const myHand = s.revealed < fullHand.length ? fullHand.slice(0, s.revealed) : fullHand
    const items = handView(myHand, ruleCtx)
    const selected = new Set(s.selected)
    const hinted = new Set(s.hintIds)
    // 回放期间手牌不可点（看的是历史墩，点牌没有意义）
    const canAct = s.phase === 'play' && turn === HUMAN_SEAT && s.replayAt === null
    const burying = s.phase === 'bury'
    /** 本帧要显示的手牌节点（复用缓存），最后一次性比对 / 提交，见下方注释 */
    const els: HTMLElement[] = []

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
        burying ? 'is-pickable' : canAct ? '' : 'card--disabled',
      ]
        .filter(Boolean)
        .join(' ')
      // **牌面元素复用**（v1.3.29 · docs/34 D-3）。
      //
      // 一张牌的 DOM 里有一整张内联 SVG（约 1.4KB），25 张就是 35KB / 25 次 innerHTML。
      // 整棵重建的旧实现每出一张牌就把 25 张全重新序列化一遍 —— 这是 16ms/次的主要来源。
      // 这里按 `id + 类名签名` 复用：签名没变就沿用同一个节点，变了才重建。
      // 出牌时只有被出的那张从列表里消失，其余 24 张零成本。
      const sig = cls
      const cached = handCardCache.get(c.id)
      const el =
        cached !== undefined && cached.sig === sig
          ? cached.el
          : (() => {
              const fresh = cardEl(c, { cls, id: c.id })
              handCardCache.set(c.id, { el: fresh, sig })
              return fresh
            })()
      if (burying || canAct) {
        el.tabIndex = 0
        el.setAttribute('role', 'button')
        el.setAttribute('aria-pressed', on ? 'true' : 'false')
        // 牌面名必须进 label（docs/37 E-4）：`aria-label` 会覆盖内部 SVG 的
        // 「黑桃2」，只写「第 N 张牌」等于告诉视障用户「这是一张牌」就没了。
        // 牌名缓存到 dataset.name，`patchSelection` 增量更新时不必再算一遍。
        el.dataset.name = cardSpokenName(c)
        el.setAttribute('aria-label', handCardLabel(el.dataset.name, c.id, isHint))
      } else {
        el.removeAttribute('role')
        el.removeAttribute('aria-pressed')
        el.removeAttribute('tabindex')
      }
      els.push(el)
    }
    // **一次 `replaceChildren` 代替 25 次 `appendChild`**（v1.3.34）。
    //
    // 旧实现逐张 `appendChild`：25 次调用 = 25 条 DOM 变更记录、25 次样式失效，
    // 而 Chrome 对 `replaceChildren` 有「整排替换」的快速路径，只失效一次。
    // 注意 `render()` 是整棵 `root.innerHTML` 重建，这里拿到的 `.hand` 本来就是**空节点**，
    // 所以没有「节点已在正确位置」这种可以跳过的情况 —— 能省的只有调用次数，不是插入本身。
    // 实测（6 倍降频，点「记录」= 整棵 render 但手牌未变，20 次）：
    //   点击→布局完成 均值 5.69 → 5.23ms、p95 8.4 → 6.7ms；
    //   样式重算 2.66 → 2.25ms/次。
    if (els.length === 0) {
      hand.innerHTML = '<div class="hand-empty">手牌已出完</div>'
    } else {
      hand.replaceChildren(...els)
    }
    // 出掉的牌要清出缓存，否则一局下来 Map 会留下 100 多个游离节点
    const alive = new Set(items.map((it) => it.card.id))
    for (const id of handCardCache.keys()) {
      if (!alive.has(id)) handCardCache.delete(id)
    }

    // 手牌重叠率按容器宽度反算（分组间隔一起计入），保证任意张数都铺得下且角标可见
    // 花色分组间隔 = 卡宽的 20%（与 CSS 的 --suit-gap 同源，避免两处各写一个数）
    fitHand(hand, items.length, gapCountOf(items))
  }

  /* ---- 手牌操作条 ---- */
  {
    const bar = q('handbar')
    if (s.phase === 'bury') {
      bar.innerHTML = `
        ${autoBtn(s)}
        <span class="hint-text" data-slot="hint-text">选 8 张扣底（已选 ${esc(s.selected.length)} / 8）</span>
        <button class="btn btn--primary" data-act="bury" ${s.selected.length === 8 ? '' : 'disabled'}>扣底</button>`
    } else if (s.phase === 'play') {
      const myTurn = turn === HUMAN_SEAT
      const rep = replaySummary(s)
      if (rep !== null) {
        bar.innerHTML = `
          <button class="btn" data-act="replayStep" data-val="-1" ${rep.isFirst ? 'disabled' : ''}>◀ 上一墩</button>
          <span class="hint-text" data-slot="hint-text">回放 第 ${esc(rep.index + 1)} / ${esc(rep.total)} 墩 · ${esc(rep.winnerLabel)} 赢${
            rep.score > 0 ? ` · ${esc(rep.score)} 分` : ''
          }</span>
          <button class="btn" data-act="replayStep" data-val="1" ${rep.isLast ? 'disabled' : ''}>下一墩 ▶</button>
          <button class="btn btn--primary" data-act="replayExit">退出回放</button>`
        return
      }
      // 有提示时，操作条直接写「这一手在干什么」——玩家看不懂建议的原因就在这
      // （v1.3.32：提示与 AI 同源后会走「看起来没道理但胜率高」的线，必须给理由）
      const hint = myTurn ? hintExplain(s) : null
      bar.innerHTML = `
        <!-- data-slot 是 patchSelection() 的稳定锚点：选牌时只改文本 / innerHTML /
             disabled，按钮元素本身不重建 ⇒ 焦点与 hover 都不丢 -->
        <span class="hint-text" data-slot="hint-text"${hint ? ` title="${esc(hint.detail)}"` : ''}>${
          myTurn ? esc(hint?.text ?? '轮到你了') : `${esc(SEAT_LABEL[turn ?? 0])} 出牌中…`
        }</span>
        <span data-slot="legality">${legalityBadge(s)}</span>
        ${autoBtn(s)}
        <button class="btn" data-act="undo" ${act.canUndo ? '' : 'disabled'}>悔牌</button>
        <button class="btn" data-act="clear" ${s.selected.length ? '' : 'disabled'}>取消</button>
        <button class="btn" data-act="hint" ${myTurn ? '' : 'disabled'} title="${hint ? esc(hint.detail) : '给出一手建议（与 AI 同一个决策引擎）'}">提示</button>
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
        ? ` · 当前主 <b>${esc(trumpLabel(s.trump))}</b> · <b>${esc(s.trumpCount)}</b> 张`
        : stillDealing
          ? // 「已发」按人类自己的到手张数算（第 26..33 轮是庄家独得，人类不涨）
            ` · 已发 <b>${esc(Math.min(s.revealed, totalHand))}</b> / ${esc(totalHand)} 张，摸到级牌可以先抢`
          : ''
      // 无将按钮为什么是灰的：只在「发完后首次定主」的面板上解释。
      // 中途面板（stillDealing）本来就不列无将，反主面板也不列，说这句反而误导。
      const ntNeedsJoker =
        !countering && !stillDealing && !s.forcedNT && !allowed.has('NT')
      const note =
        s.guardBy !== null
          ? `<p class="trump-note">已加固：反主门槛升到 <b>${esc(need)}</b> 张（锁死）</p>`
          : countering && s.counterOptions.length > 0
            ? `<p class="trump-note">反主需 <b>${esc(need)}</b> 张该门级牌</p>`
            : ntNeedsJoker
              ? '<p class="trump-note">无将需持<b>一对王</b>（一对小王 或 一对大王）</p>'
              : ''
      const guardBtn = s.guardOption
        ? `<div class="trump-actions"><button class="btn btn--primary guard-btn" data-act="guard">加固（需 ${esc(GUARD_NEED)} 张同花色级牌）</button></div>`
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
          <p class="muted">本局打 <b>${esc(levelLabel(s.levelRank))}</b>${s.forcedNT ? '（打王级强制无将）' : ''}${stateText}</p>
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
  const progress = s.phase === 'bury' ? '还没扣底' : `第 ${esc(s.tricksDone + 1)} 墩`
  return `<div class="panel" role="dialog" aria-label="重新开局确认">
    <h2>重新开局？</h2>
    <p class="muted">第 ${esc(s.round)} 局 · ${esc(progress)} · 当前进度会丢失（存档一并清掉）。</p>
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
    `<span class="counter__item${slot.left === 0 ? ' is-done' : ''}">${esc(label)} <b>${esc(slot.left)}</b>/${esc(slot.total)}</span>`
  return `<div class="counter" data-slot="counter" title="记牌器：未出 / 总数（底牌 8 张谁也不知道，算在「未出」里）">
      ${item('大王', c.bigJoker)}
      ${item('小王', c.smallJoker)}
      ${item('主级', c.levelTrump)}
      ${item('副级', c.levelOff)}
      ${item('主', c.trumps)}
      <span class="counter__item${c.pointsPlayed >= c.pointsTotal ? ' is-done' : ''}">分 <b>${esc(c.pointsPlayed)}</b>/${esc(c.pointsTotal)}</span>
    </div>`
}

export function settlePanel(s: GameState): string {
  const r = s.lastSettle
  if (!r) return ''
  const over = s.phase === 'over'
  const rows: string[] = []
  rows.push(`<div class="row"><span>闲家得分</span><b>${esc(r.defenderScore)}</b></div>`)
  rows.push(`<div class="row"><span>${r.dealerChanged ? '闲家上台' : '庄家方继续'}</span><b>${esc(r.levels)} 级</b></div>`)
  if (r.actualLevels !== r.levels) {
    rows.push(
      `<div class="row"><span>必打截断</span><b>实际升 ${esc(r.actualLevels)} 级${r.guardLevel ? `（停在 ${esc(levelLabel(r.guardLevel))}）` : ''}</b></div>`,
    )
  }
  rows.push(`<div class="row"><span>下一局</span><b>${esc(SEAT_LABEL[r.newDealer])}坐庄</b></div>`)
  rows.push(`<div class="row"><span>级牌</span><b>队A ${esc(levelLabel(r.newLevels.a))} · 队B ${esc(levelLabel(r.newLevels.b))}</b></div>`)

  // 累计战绩：玩家自己判断"AI 强不强"的唯一外部依据（详见 app/stats.ts）
  const line = statsLine()

  return `<div class="panel">
    <h2>${over ? `游戏结束 · ${r.winnerTeam === 0 ? '队A' : '队B'} 获胜` : '本局结算'}</h2>
    ${rows.join('')}
    ${line ? `<div class="row row--stats"><span>战绩</span><b>${esc(line)}</b></div>` : ''}
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
    return `<span class="legality is-bad">✕ ${esc(result.detail)}</span>`
  }
  if (result.adjusted) {
    return `<span class="legality is-warn">⚠ ${esc(result.detail)}（将只出 ${result.cards.length} 张）</span>`
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
  /**
   * 规则开关：写 pendingConfig，下一局生效。
   *
   * `data-cfg` 同时挂在**整行**和开关上：点开关时 `closest` 命中最内层的开关，
   * 点同一行的文字/说明时命中最内层的行 —— 两处都能切换（docs/37 E-3：
   * 原来只有 40×22 的开关本体可点，点文字没反应，移动端很容易点空）。
   */
  const sw = (key: string, label: string, desc: string, on: boolean): string => `
    <div class="set-row" data-cfg="${key}">
      <span>${esc(label)}<small class="set-desc">${esc(desc)}</small></span>
      <button class="switch" role="switch" aria-checked="${on ? 'true' : 'false'}" data-cfg="${key}" aria-label="${esc(label)}"></button>
    </div>`

  /** 体验开关：直接改 state，立即生效（整行可点，理由同上） */
  const swAct = (act: string, label: string, desc: string, on: boolean): string => `
    <div class="set-row" data-act="${act}">
      <span>${esc(label)}<small class="set-desc">${esc(desc)}</small></span>
      <button class="switch" role="switch" aria-checked="${on ? 'true' : 'false'}" data-act="${act}" aria-label="${esc(label)}"></button>
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
        <span>挂机 AI<small class="set-desc">开启挂机后，代你出牌 / 抢主 / 扣底的强度</small></span>
        ${seg('setAutoLevel', '挂机 AI 难度', AI_LEVEL_OPTS.map((o) => ({ ...o, on: s.autoLevel === Number(o.v) })))}
      </div>
      <div class="set-row">
        <span>AI 出牌速度<small class="set-desc">快一点更好打；想看清每张牌就调慢</small></span>
        ${seg('setAiSpeed', 'AI 出牌速度', AI_SPEED_OPTS.map((o) => ({ ...o, on: o.v === nearestSpeed(s.aiSpeedMs) })))}
      </div>
      ${swAct('toggleAiPeek', 'AI 读牌', '开启时对手 AI 能看到你的手牌（默认，强度更高）；关闭后对手只用公开信息推断。只影响对手，不影响你的提示', s.aiPeekHands)}
      ${swAct('toggleShowOppHands', '查看别人手牌', '作弊：其他三家手牌以明牌显示（排序与你的手牌一致）。只影响画面，不改变规则与 AI 行为', s.showOppHands)}`,
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
      <div class="set-row">
        <span>提示风格<small class="set-desc">稳妥 = 像人一样打（不首出带分牌、能赢才抢）；最强 = AI 的判断，胜率更高但线路更像机器</small></span>
        ${seg('setHintStyle', '提示风格', [
          { v: 'safe', label: '稳妥', on: s.hintStyle === 'safe' },
          { v: 'ai', label: '最强', on: s.hintStyle === 'ai' },
        ])}
      </div>
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

/**
 * HTML 转义。
 *
 * **为什么要有这一层**（docs/38 G-1）：`render()` 是「拼字符串 → innerHTML」，
 * 任何被内插进模板的值都会被当成 HTML 解析。状态里理论上「一定是数字」的字段
 * （`round` / `defenderScore` / `tricksDone` …）在旧 `loadState` 下没有任何校验，
 * 一份被篡改的存档就能把 `<img onerror>` 送进 DOM 并执行。
 *
 * 现在入口已经做了字段级校验（见 `app/persist.ts` 的 `loadStateDetailed`），
 * 但**出口仍然要转义** —— 将来只要新增一个玩家可输入的字段（昵称、房间名），
 * 忘了校验就是真漏洞。两层都做才算收口。
 *
 * 接受 `unknown` 而不是 `string`：这样 `${esc(x)}` 对数字/布尔/undefined 也能直接用，
 * 不必在每个调用点先判类型。
 */
function esc(v: unknown): string {
  if (v === null || v === undefined) return ''
  return String(v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** 手牌元素的可读名称：「黑桃2，第 52 张牌（提示）」 */
function handCardLabel(name: string, id: number, isHint: boolean): string {
  return `${name}，第 ${id} 张牌${isHint ? '（提示）' : ''}`
}

/**
 * **增量**更新选牌 / 提示相关的视觉状态，不重建 DOM。
 *
 * 为什么需要它（docs/37 E-2、docs/34 D-1/D-3）：
 *   - `render()` 是整棵重建，选一张牌会把那个 `.card` 元素销毁 → **焦点掉到 BODY**，
 *     键盘用户每选一张就要重新 Tab 十几下；再按回车也取消不了（事件目标没了）。
 *   - 一次选牌要写 71 次 `innerHTML` / 72KB 字符串（整棵骨架 + 逐槽填充），
 *     而选牌是**最高频操作**，这笔开销纯属浪费。
 *
 * 只动两类东西：
 *   ① 手牌：`.card--selected` / `.card--hint` 类 + `aria-pressed` / `aria-label`
 *   ② 操作条：`data-slot="hint-text"` 文本、`data-slot="legality"` 内容、
 *      以及三个按钮的 `disabled`（按钮元素本身不替换 ⇒ 焦点/hover 都保住）
 *
 * 调用方保证：**只有 `selected` / `hintIds` 变了**才走这里（见 `main.ts` 的
 * `onlySelectionChanged`）。其它任何字段变化都必须走完整 `render()`。
 */
export function patchSelection(root: HTMLElement, s: GameState): void {
  const selected = new Set(s.selected)
  const hinted = new Set(s.hintIds)

  const hand = root.querySelector<HTMLElement>('[data-slot="hand"]')
  if (hand !== null) {
    for (const el of hand.querySelectorAll<HTMLElement>('.card[data-id]')) {
      const id = Number(el.dataset.id)
      if (!Number.isFinite(id)) continue
      const on = selected.has(id)
      const isHint = hinted.has(id)
      el.classList.toggle('card--selected', on)
      el.classList.toggle('card--hint', isHint)
      // 不可操作的牌没有 role=button，也就没有 aria 状态要维护
      if (el.getAttribute('role') === 'button') {
        el.setAttribute('aria-pressed', on ? 'true' : 'false')
        el.setAttribute('aria-label', handCardLabel(el.dataset.name ?? '', id, isHint))
      }
    }
  }

  const bar = root.querySelector<HTMLElement>('[data-slot="handbar"]')
  if (bar === null) return
  const n = s.selected.length
  const myTurn = seatToPlay(s) === HUMAN_SEAT

  if (s.phase === 'bury') {
    const hintText = bar.querySelector<HTMLElement>('[data-slot="hint-text"]')
    if (hintText !== null) hintText.textContent = `选 8 张扣底（已选 ${n} / 8）`
  }
  const legality = bar.querySelector<HTMLElement>('[data-slot="legality"]')
  if (legality !== null && s.phase === 'play') legality.innerHTML = legalityBadge(s)

  /* 提示是**纯视觉状态**，走的是增量路径（只改 hintIds）⇒ 操作条上的理由必须在这里更新，
     否则点「提示」后手牌高亮了、理由还是「轮到你了」（回放分支的文案不能覆盖，跳过）。 */
  if (s.phase === 'play' && s.replayAt === null) {
    const hintText = bar.querySelector<HTMLElement>('[data-slot="hint-text"]')
    const hint = myTurn ? hintExplain(s) : null
    if (hintText !== null) {
      hintText.textContent = myTurn
        ? (hint?.text ?? '轮到你了')
        : `${SEAT_LABEL[seatToPlay(s) ?? 0]} 出牌中…`
      if (hint) hintText.title = hint.detail
      else hintText.removeAttribute('title')
    }
    const hintBtn = bar.querySelector<HTMLButtonElement>('[data-act="hint"]')
    if (hintBtn !== null) {
      hintBtn.title = hint?.detail ?? '给出一手建议（与 AI 同一个决策引擎）'
    }
  }

  const setDisabled = (act: string, disabled: boolean): void => {
    const b = bar.querySelector<HTMLButtonElement>(`[data-act="${act}"]`)
    if (b !== null) b.disabled = disabled
  }
  setDisabled('bury', n !== 8)
  setDisabled('clear', n === 0)
  setDisabled('play', !(myTurn && n > 0))
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

/**
 * 明牌作弊：把一家的手牌画成**正面小牌**（`showOppHands` 开启时代替牌背）。
 *
 * 排序**必须**走 `handView()` —— 那是玩家手牌用的同一套展示序
 *（主牌段 → 主花色 → 副牌花色，花色内降序 + 分组间隔）。
 * ui 层不许自己判主牌 / 牌力（分层铁律，见 docs/07-编码规范.md）。
 *
 * 几何上的两个坑：
 * - **西/东不能沿用牌背的 rotate(90°)**：牌背转过来无所谓，牌面转了只露一条边，
 *   点数就认不出来了。所以侧家改成「竖排 + 牌面正立」，每张露左上角标。
 * - 侧家 25 张要按可用高度反算步长（思路同 `fitSideStack`），否则会溢出到出牌区上。
 */
function fillRevealRow(
  box: HTMLElement,
  cards: readonly Card[],
  side: boolean,
  cardW: number,
  seat: Seat,
  ctx: RuleContext,
): void {
  // 明牌的叠放规则与牌背完全不同（步长变量也不同），直接换容器类名
  box.className = side ? 'reveal-row reveal-row--side' : 'reveal-row'

  const narrow = window.innerWidth <= 900
  const w = Math.max(
    REVEAL_MIN_W,
    Math.round(cardW * (narrow ? REVEAL_RATIO_NARROW : REVEAL_RATIO)),
  )
  const h = Math.round(w * 1.4)
  const minStep = Math.round(h * REVEAL_MIN_STEP_RATIO)
  const items = handView(cards, ctx)

  // 步长 = 每张露出的长度（px）。先定容器变量，再塞牌，避免中途 reflow 两次。
  let step: number
  const gapPx = Math.round(w * REVEAL_GAP_RATIO)
  const gapN = items.filter((it) => it.gapBefore).length
  if (side) {
    // 竖排：可用高度 = 座位总高 - 座位标签（`.seat` 是 grid item，被拉伸到整行高，
    // 而明牌容器自身在 flex 里是内容高度，量它只会得到 0 —— v1.3.30 踩过）。
    const seatEl = box.closest('.seat') as HTMLElement | null
    const tagH = seatEl?.querySelector('.seat-tag')?.getBoundingClientRect().height ?? 0
    const avail = seatEl ? Math.max(120, Math.round(seatEl.clientHeight - tagH - 6)) : 0
    const fit =
      items.length > 1 && avail > 0
        ? (avail - h - gapN * gapPx) / (items.length - 1)
        : h * REVEAL_STEP_RATIO
    step = Math.max(minStep, Math.min(Math.round(h * 0.5), Math.round(fit)))
    // 一列塞不下就靠 `flex-flow: column wrap` 折到下一列（顺序仍是「先上后下、先左后右」）。
    // **列高按「均分」反算**，否则 25 张会排成 19+6 那种一头沉的形状 ——
    // 先算需要几列，再把牌平均分到各列。
    const need = items.length * step + gapN * gapPx
    const cols = avail > 0 ? Math.max(1, Math.ceil(need / avail)) : 1
    const perCol = Math.ceil(items.length / cols)
    // 分组间隔按张数摊到每张上，列高留 10px 余量（否则刚好卡边界会多折一列）
    const gapShare = (perCol * gapN * gapPx) / items.length
    const colH = Math.min(avail, Math.ceil(perCol * step + gapShare) + 10)
    // avail 为 0（容器还没布局）时不写列高，退回 CSS 的 auto（单列，不会把牌压成 0 高）
    if (avail > 0) box.style.setProperty('--mini-col-h', `${colH}px`)
  } else {
    // 横排：北家那一行宽度由内容决定（grid 里是 auto 列），
    // 所以按「最多占视口一半、且不超过 680px」反算，避免把东西两家挤没。
    const maxW = Math.min(680, Math.max(240, window.innerWidth * 0.52))
    const fit = items.length > 1 ? (maxW - w) / (items.length - 1) : w
    step = Math.round(Math.max(w * 0.2, Math.min(w * REVEAL_STEP_RATIO, fit)))
  }
  box.style.setProperty('--mini-w', `${w}px`)
  box.style.setProperty('--mini-h', `${h}px`)
  box.style.setProperty('--mini-step', `${step}px`)
  box.style.setProperty('--mini-gap', `${gapPx}px`)

  for (let i = 0; i < items.length; i++) {
    const it = items[i] as (typeof items)[number]
    const el = cardEl(it.card, {
      width: w,
      id: it.card.id,
      // 分组间隔 + 飞行中占位：与玩家手牌同一套语义（发牌动画按 .card--incoming 揭面）
      cls: [it.gapBefore ? 'card--gap' : '', isBackInFlight(seat, i) ? 'card--incoming' : '']
        .filter(Boolean)
        .join(' '),
      title: cardName(it.card),
    })
    el.dataset.reveal = String(seat)
    box.appendChild(el)
  }
}

function bind(root: HTMLElement, s: GameState, act: Actions): void {
  /* 拖动音量滑条：置标志让 paint 别重绘，松手再解除。
     不这么做的话，每个 input 事件 dispatch 一次音量 → paint 整棵重建 →
     <input type=range> 被换成新元素 → 拖动立刻中断，只剩「点哪跳哪」。 */
  root.onpointerdown = (ev) => {
    const t = ev.target
    if (t instanceof HTMLInputElement && t.type === 'range') draggingRange = true
    // **鼠标点手牌不抢焦点**（v1.3.29 修复）。
    //
    // 手牌是 `tabindex=0` + `role=button`（NFR-10 要求键盘可选），所以浏览器
    // 点它时会把它设为 activeElement。于是「点一张牌 → 按空格」命中的是
    // `onCard` 分支（空格 = 切换选中）⇒ **取消选中而不是出牌**，
    // 用户看到的是「点了牌按空格没反应」。
    // 阻止 pointerdown 的默认行为可以阻止聚焦，而 click 事件照常触发 ——
    // 键盘用户走 Tab 聚焦不受影响。
    if (t instanceof Element && t.closest('.hand .card[data-id]') !== null) ev.preventDefault()
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
      case 'setHintStyle':
        if (val === 'safe' || val === 'ai') act.dispatch({ type: 'setHintStyle', style: val })
        break
      case 'autoPlay':
        act.dispatch({ type: 'toggleAutoPlay' })
        break
      case 'setAutoLevel':
        if (val === '0' || val === '1' || val === '2' || val === '3') {
          act.dispatch({ type: 'setAutoLevel', level: Number(val) as AiLevel })
        }
        break
      case 'toggleShowCounter':
        act.dispatch({ type: 'toggleShowCounter' })
        break
      case 'toggleAiPeek':
        act.dispatch({ type: 'toggleAiPeek' })
        break
      case 'toggleShowOppHands':
        act.dispatch({ type: 'toggleShowOppHands' })
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
