/**
 * 界面渲染
 *
 * 策略：每次状态变化重建 DOM。牌桌最多约 200 个节点，重建成本可忽略，
 * 换来的是「渲染 = state 的纯函数」这种简单性。
 *
 * 分层铁律：本文件只消费 app 层算好的视图数据（handView / trickLogView /
 * recentTricksView），不出现 power / 主牌判定等规则概念。
 */

import type { Card, LevelRank, Play, RuleConfig, Seat, Trump } from '@core'
import { checkPlay, teamOf } from '@core'
import type { AiLevel } from '@ai/policy'
import type { Action, CardSize, GameState } from '@app/state'
import { CARD_SIZE_PX, HUMAN_SEAT, ctxOf, seatToPlay } from '@app/state'
import { gapCountOf, handView } from '@app/handView'
import { recentTricksView, trickLogView } from '@app/view'
import { backEl, cardEl, ensureDefs } from './card'

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

/** 手牌前方历史牌条显示几墩 */
const RECENT_DEPTH = 3
/** 侧家（西/东）竖向牌背最多显示几张 —— 竖向更吃高度，比北家的 13 少 */
const SIDE_SHOW = 10
/** 侧家牌背宽度（竖向排列，视觉高度 = 该值） */
const SIDE_CARD_W = 52
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
  // 已出的牌：矮屏（<=780px）缩小一档，给两侧竖向牌堆腾出纵向空间
  const playedW = window.innerHeight <= 780 ? 58 : 74

  root.innerHTML = `
    <header class="topbar">
      <div class="brand">拖拉机 · 重制版</div>
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
        <div class="recent" data-slot="recent"></div>
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
  const sideW = window.innerWidth <= 900 ? 40 : window.innerHeight <= 780 ? 38 : SIDE_CARD_W
  for (const seat of [1, 2, 3] as Seat[]) {
    const box = q(SEAT_CLASS[seat])
    const hand = s.hands[seat] as readonly Card[]
    const play = s.trick.plays.find((p) => p.seat === seat)
    const isWinner = s.trick.winner === seat
    // 西（1）/ 东（3）竖向堆叠，北（2）保持横向
    const side = seat === 1 || seat === 3

    box.innerHTML = `<div class="seat-tag${isWinner ? ' is-win' : ''}">
        ${SEAT_LABEL[seat]} · ${hand.length} 张 · ${teamLabel(s, teamOf(seat))}
        ${turn === seat ? '<span class="turn-dot"></span>' : ''}
      </div>
      <div class="back-row${side ? ' back-row--side' : ''}" data-slot="back-${seat}"></div>
      <div class="played${side ? ' played--side' : ''}" data-slot="played-${seat}"></div>`

    const playedBox = box.querySelector(`[data-slot="played-${seat}"]`) as HTMLElement
    if (play) playedBox.appendChild(cardWrap(play.cards, { width: playedW }))
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
    for (let i = 0; i < show; i++) backRow.appendChild(backEl(1, { width: side ? sideW : 46 }))
    if (side) fitSideStack(backRow, show, sideW)
  }

  /* ---- 中央：我出的牌 ---- */
  {
    const box = q('center')
    const play = s.trick.plays.find((p) => p.seat === HUMAN_SEAT)
    const isWinner = s.trick.winner === HUMAN_SEAT
    box.innerHTML = `<div class="seat-tag${isWinner ? ' is-win' : ''}">
        ${SEAT_LABEL[HUMAN_SEAT]} · ${(s.hands[HUMAN_SEAT] as readonly Card[]).length} 张 · ${teamLabel(s, 0)}
      </div>
      <div class="played" data-slot="played-mine"></div>`
    const playedBox = box.querySelector('[data-slot="played-mine"]') as HTMLElement
    if (play) playedBox.appendChild(cardWrap(play.cards, { width: playedW }))
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

  /* ---- 手牌前方：最近几墩历史牌条 ---- */
  {
    const box = q('recent')
    const tricks = s.showHistory ? recentTricksView(s, RECENT_DEPTH) : []
    // 红线：这里刻意放在 .hand 之外、且不给小牌 data-id ——
    // 否则 e2e 的 `#app .hand .card` 计数与 clickHandCards 会被历史牌污染。
    for (const t of tricks) {
      const item = document.createElement('div')
      item.className = 'recent__trick'
      const no = document.createElement('span')
      no.className = 'recent__no'
      no.textContent = `第${t.no}墩`
      const cards = document.createElement('div')
      cards.className = 'recent__cards'
      for (const p of t.plays) {
        const play = document.createElement('div')
        play.className = 'recent__play'
        play.dataset.seat = String(p.seat)
        for (const c of p.cards) play.appendChild(cardEl(c, { width: 22, cls: 'card--tiny' }))
        cards.appendChild(play)
      }
      item.append(no, cards)
      box.appendChild(item)
    }
    // 提示条要浮在手牌区之上，历史牌条的高度随墩数变化 ⇒ 实测后回写变量
    root.style.setProperty('--recent-h', tricks.length ? `${box.offsetHeight + 6}px` : '0px')
  }

  /* ---- 我的手牌 ---- */
  {
    const hand = q('hand')
    const fullHand = s.hands[HUMAN_SEAT] as readonly Card[]
    // 逐张发牌：只渲染已经发到手上的那部分（hands 里始终是完整的 25 张）
    const myHand = s.revealed < fullHand.length ? fullHand.slice(0, s.revealed) : fullHand
    const dealing = s.phase === 'contract' && s.revealed < fullHand.length
    const items = handView(myHand, ctxOf(s))
    const newest = dealing ? items.length - 1 : -1
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
        i === newest ? 'card--deal' : '',
        item.gapBefore ? 'card--gap' : '',
      ]
        .filter(Boolean)
        .join(' ')
      const el = cardEl(c, {
        cls,
        id: c.id,
      })
      if (i === newest) el.style.setProperty('--i', '0')
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
    fitHand(hand, items.length, gapCountOf(items), s.cardSize === 'S' ? 10 : 14)
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
      const note =
        s.guardBy !== null
          ? `<p class="trump-note">已加固：反主门槛升到 <b>${need}</b> 张（锁死）</p>`
          : countering && s.counterOptions.length > 0
            ? `<p class="trump-note">反主需 <b>${need}</b> 张该门级牌</p>`
            : ''
      const guardBtn = s.guardOption
        ? `<div class="trump-actions"><button class="btn btn--primary guard-btn" data-act="guard">加固（需 ${need} 张同花色级牌）</button></div>`
        : ''
      const trumpBtn = (t: Trump, label: string, cls = ''): string => {
        const v = String(t)
        const disabled = !allowed.has(v)
        return `<button class="btn trump-btn${cls}" data-trump="${v}"${disabled ? ' disabled' : ''}>${label}</button>`
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

  if (result.ok) {
    return `<span class="legality is-ok">✓ 可以出</span>`
  }
  return `<span class="legality is-bad">✕ ${escapeHtml(result.detail)}</span>`
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
      ${sw('allowCounterNT', '允许反无将', '无将可被反', c.allowCounterNT)}
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
      ${swAct('toggleShowHistory', '历史牌条', `手牌前方显示最近 ${RECENT_DEPTH} 墩`, s.showHistory)}
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

/**
 * 按容器宽度反算手牌重叠率。
 * step = 每张牌前进的比例；下限 0.3 保证角标（占 0.3 卡宽）能露出来。
 *
 * 分组间隔会额外吃掉 `gapCount * gapPx` 的横向空间，必须一起算进来，
 * 否则 25 张牌会溢出容器。空间不够时按三档降级：14px → 6px → 刚好放得下的余量。
 */
function fitHand(hand: HTMLElement, count: number, gapCount: number, gapPx: number): void {
  if (count <= 1) return
  const cardW = hand.firstElementChild
    ? (hand.firstElementChild as HTMLElement).getBoundingClientRect().width
    : 92
  const avail = hand.clientWidth
  if (!avail || !cardW) return
  const MIN_STEP = gapCount > 0 ? 0.28 : 0.3
  /** 未夹紧的重叠率：< MIN_STEP 说明这个间隔放不下 */
  const raw = (gap: number): number => (avail - cardW - gapCount * gap) / ((count - 1) * cardW)
  let gap = gapPx
  if (gapCount > 0 && raw(gap) < MIN_STEP) gap = 6
  if (gapCount > 0 && raw(gap) < MIN_STEP) {
    // 还是放不下：把间隔压到「刚好还能放下」，宁可变窄也不溢出容器
    const room = avail - cardW - MIN_STEP * (count - 1) * cardW
    gap = Math.max(0, Math.min(gap, Math.floor(room / gapCount)))
  }
  const step = Math.min(0.58, Math.max(MIN_STEP, raw(gap)))
  hand.style.setProperty('--hand-gap', `${gap}px`)
  hand.style.setProperty('--hand-step', step.toFixed(3))
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
