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
import { GUARD_NEED, checkPlay, teamOf } from '@core'
import type { AiLevel } from '@ai/policy'
import type { Action, CardSize, GameState } from '@app/state'
import { CARD_SIZE_PX, HUMAN_SEAT, ctxOf, seatToPlay } from '@app/state'
import { gapCountOf, handView } from '@app/handView'
import { pastPlaysView, trickLogView } from '@app/view'
import { backEl, cardEl, ensureDefs } from './card'
import { isInFlight } from './dealFly'

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
/** 历史小牌宽度占卡宽的比例（M 档 150 × 0.16 = 24px） */
const TINY_RATIO = 0.16
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

/** 队名：庄家队 / 闲家队 */
function teamLabel(s: GameState, team: 0 | 1): string {
  return teamOf(s.dealer) === team ? '庄' : '闲'
}

function cardWrap(cards: readonly Card[], o: { cls?: string; width?: number } = {}): HTMLElement {
  const box = document.createElement('div')
  box.className = 'cards'
  for (const c of cards) box.appendChild(cardEl(c, o))
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
): void {
  // 侧家的竖向堆叠步长要用到本墩牌的宽度
  box.style.setProperty('--played-w', `${playedW}px`)
  const now = box.querySelector('.plays__now') as HTMLElement
  const past = box.querySelector('.plays__past') as HTMLElement
  const play = s.trick.plays.find((p) => p.seat === seat)
  if (play) now.appendChild(cardWrap(play.cards, { width: playedW }))
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
  for (const seat of [1, 2, 3] as Seat[]) {
    const box = q(SEAT_CLASS[seat])
    const hand = s.hands[seat] as readonly Card[]
    const isWinner = s.trick.winner === seat
    // 西（1）/ 东（3）竖向堆叠，北（2）保持横向
    const side = seat === 1 || seat === 3

    box.innerHTML = `<div class="seat-tag${isWinner ? ' is-win' : ''}">
        ${SEAT_LABEL[seat]} · ${hand.length} 张 · ${teamLabel(s, teamOf(seat))}
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
        backEl(1, { width: side ? sideW : Math.round(cardW * NORTH_BACK_RATIO) }),
      )
    }
    if (side) fitSideStack(backRow, show, sideW)
  }

  /* ---- 中央：牌堆 + 人类座位信息（本墩的牌已挪到南家自己的出牌区） ---- */
  {
    const box = q('center')
    const isWinner = s.trick.winner === HUMAN_SEAT
    const full = (s.hands[HUMAN_SEAT] as readonly Card[]).length
    // 逐张发牌期间「手上几张」按已发到的算，别一上来就写 25
    const held = s.phase === 'contract' ? Math.min(full, s.revealed) : full
    // 牌堆：100 张发给四家（每家 25），另 8 张底牌开局就已扣下、不参与逐张发牌。
    // 它同时是发牌飞行轨迹的起点（见 ui/dealFly.ts），发完即消失。
    const left = Math.max(0, 100 - s.revealed * 4)
    const deck =
      s.phase === 'contract' && left > 0
        ? `<div class="deck" data-slot="deck" aria-hidden="true">
        <i class="deck__layer"></i><i class="deck__layer"></i><i class="deck__layer"></i>
        <span class="deck__count">${left}</span>
      </div>`
        : ''
    box.innerHTML = `<div class="seat-tag${isWinner ? ' is-win' : ''}">
        ${SEAT_LABEL[HUMAN_SEAT]} · ${held} 张 · ${teamLabel(s, 0)}
      </div>${deck}`
  }

  /* ---- 南家（你）：自己的出牌区在手牌正前方 ---- */
  {
    fillPlays(q('plays-mine'), s, HUMAN_SEAT, playedW, tinyW)
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
      <span>第 ${s.tricksDone + (s.phase === 'play' ? 1 : 0)} / 25 墩</span>
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
    const canAct = s.phase === 'play' && turn === HUMAN_SEAT
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
    // 发牌暂停提示时把手牌露出来（否则遮罩+模糊让人看不清自己有什么牌）
    ov.dataset.mode = s.phase === 'contract' && s.dealPrompt ? 'deal' : ''
    if (s.settingsOpen) {
      ov.innerHTML = settingsPanel(s)
    } else if (s.logOpen) {
      ov.innerHTML = logPanel(s)
    } else if (s.phase === 'contract') {
      const totalHand = (s.hands[HUMAN_SEAT] as readonly Card[]).length
      const stillDealing = s.revealed < totalHand
      if (stillDealing && !s.dealPrompt) {
        // 正在逐张发牌且还没到该决定的时候 —— 不弹面板，把牌桌让出来
        ov.innerHTML = ''
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
          ? ` · 已发 <b>${s.revealed}</b> / ${totalHand} 张，摸到级牌可以先抢`
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
      ov.innerHTML = `
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
        </div>`
      }
    } else if (s.phase === 'settle' || s.phase === 'over') {
      ov.innerHTML = settlePanel(s)
    } else {
      ov.innerHTML = ''
    }
  }

  /* ---- 提示条 ---- */
  {
    const t = q('toast')
    const msg = s.lastReject?.detail ?? s.notice
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

function settlePanel(s: GameState): string {
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
    <button class="btn btn--primary" data-act="nextRound">${over ? '再来一局' : '下一局'}</button>
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

/** 设置面板（FR-18） */
function settingsPanel(s: GameState): string {
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

  return `<div class="panel panel--wide" role="dialog" aria-label="设置">
    <h2>设置</h2>
    <p class="muted">规则开关改动在<b>下一局</b>生效；体验项立即生效。</p>

    <div class="set-group">
      <h3>规则</h3>
      ${sw('allowSelfCounter', '允许自反', '同队也可反主', c.allowSelfCounter)}
      ${sw('twoAsPermanent', '2 为常主', '两张 2 恒为主牌', c.twoAsPermanent)}
      ${sw('allowPartnerGuard', '允许对家保', '对家可保级', c.allowPartnerGuard)}
      ${sw('allowCounterNT', '允许反无将', '主动亮无将可被花色反（打王级除外）', c.allowCounterNT)}
      ${sw('guardScoreLevels', '5,10,K 必打', '升级时不可跳过这些级牌', c.guardScoreLevels)}
      ${sw('guardJack', 'J 必打', '升级时不可跳过 J', c.guardJack)}
      ${sw('guardAce', 'A 必打', '升级时不可跳过 A', c.guardAce)}
      ${sw('guardKingLevel', '打王必打', '升级时不可跳过打王级', c.guardKingLevel)}
    </div>

    <div class="set-group">
      <h3>体验</h3>
      <div class="set-row">
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
        <span>AI 速度</span>
        ${seg('setAiSpeed', 'AI 速度', [
          { v: '0', label: '瞬时', on: s.aiSpeedMs === 0 },
          { v: '300', label: '慢', on: s.aiSpeedMs === 300 },
          { v: '800', label: '中', on: s.aiSpeedMs === 800 },
        ])}
      </div>
      <div class="set-row">
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
      ${swAct('toggleShowHistory', '各家出牌留痕', `各家面前显示最近 ${PAST_DEPTH} 墩的历史小牌`, s.showHistory)}
      ${swAct('toggleHintSelects', '提示即选中', '点「提示」直接选中提示的牌（会覆盖已选牌，并写入存档）', s.hintSelects)}
    </div>

    <div class="set-foot">
      「必打」是<b>升级时禁止跳级</b>的限制，与出牌无关（见规则书 §10.3）。
    </div>

    <button class="btn btn--primary" data-act="closeSettings">完成</button>
  </div>`
}

/** 对局记录面板（FR-20）：按墩分组，标赢家、得分高亮、花色着色 */
function logPanel(s: GameState): string {
  const tricks = trickLogView(s)
  const items = tricks
    .map(
      (t) => `<div class="log-trick" data-win-team="${t.winnerTeam}">
        <div class="log-trick__head">
          <span class="log-trick__no">第 ${t.no} 墩</span>
          <span class="log-trick__win">${t.winnerLabel} 赢</span>
          ${t.score > 0 ? `<span class="log-trick__pts is-score">${t.score} 分</span>` : ''}
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
    <button class="btn btn--primary" data-act="toggleLog">关闭</button>
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
  root.onclick = (ev) => {
    const target = ev.target as HTMLElement
    const cardNode = target.closest('.card[data-id]') as HTMLElement | null
    if (cardNode?.dataset.id) {
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
      case 'newGame':
        act.dispatch({ type: 'newGame' })
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
      default:
        break
    }
  }
}
