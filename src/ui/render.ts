/**
 * 界面渲染
 *
 * 策略：每次状态变化重建 DOM。牌桌最多约 200 个节点，重建成本可忽略，
 * 换来的是「渲染 = state 的纯函数」这种简单性。
 */

import type { Card, LevelRank, Play, RuleConfig, Seat, Trump } from '@core'
import { checkPlay, teamOf } from '@core'
import type { Action, CardSize, GameState } from '@app/state'
import { CARD_SIZE_PX, HUMAN_SEAT, ctxOf, seatToPlay } from '@app/state'
import { backEl, cardEl, ensureDefs } from './card'

export interface Actions {
  readonly dispatch: (a: Action) => void
  readonly hint: () => void
}

const SUIT_LABEL = ['♠ 黑桃', '♥ 红心', '♣ 梅花', '♦ 方片']
const SEAT_LABEL = ['南（你）', '西', '北', '东']
const SEAT_CLASS: Record<Seat, string> = { 0: 'center', 1: 'west', 2: 'north', 3: 'east' }

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
  root.dataset.fourColor = s.fourColor ? 'true' : 'false'
  root.dataset.cardSize = s.cardSize
  root.dataset.anim = s.animation ? 'on' : 'off'

  const turn = seatToPlay(s)

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

    <main class="felt">
      <div class="seat seat--north" data-slot="north"></div>
      <div class="seat seat--west" data-slot="west"></div>
      <div class="seat seat--center" data-slot="center"></div>
      <div class="seat seat--east" data-slot="east"></div>
      <div class="south">
        <div class="status" data-slot="status"></div>
        <div class="hand" data-slot="hand"></div>
        <div class="hand-bar" data-slot="handbar"></div>
      </div>
    </main>

    <div class="overlay" data-slot="overlay"></div>
    <div class="toast" data-slot="toast"></div>
  `

  const q = <T extends HTMLElement>(slot: string) => root.querySelector(`[data-slot="${slot}"]`) as T

  /* ---- 三家对家 ---- */
  for (const seat of [1, 2, 3] as Seat[]) {
    const box = q(SEAT_CLASS[seat])
    const hand = s.hands[seat] as readonly Card[]
    const play = s.trick.plays.find((p) => p.seat === seat)
    const isWinner = s.trick.winner === seat

    box.innerHTML = `<div class="seat-tag${isWinner ? ' is-win' : ''}">
        ${SEAT_LABEL[seat]} · ${hand.length} 张 · ${teamLabel(s, teamOf(seat))}
        ${turn === seat ? '<span class="turn-dot"></span>' : ''}
      </div>
      <div class="back-row" data-slot="back-${seat}"></div>
      <div class="played" data-slot="played-${seat}"></div>`

    const backRow = box.querySelector(`[data-slot="back-${seat}"]`) as HTMLElement
    const show = Math.min(hand.length, 13)
    for (let i = 0; i < show; i++) backRow.appendChild(backEl(1, { width: 46 }))

    const playedBox = box.querySelector(`[data-slot="played-${seat}"]`) as HTMLElement
    if (play) playedBox.appendChild(cardWrap(play.cards, { width: 74 }))
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
    if (play) playedBox.appendChild(cardWrap(play.cards, { width: 74 }))
  }

  /* ---- 状态栏 ---- */
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
    const myHand = s.hands[HUMAN_SEAT] as readonly Card[]
    const selected = new Set(s.selected)
    const hinted = new Set(s.hintIds)
    const canAct = s.phase === 'play' && turn === HUMAN_SEAT
    const burying = s.phase === 'bury'

    for (const c of myHand) {
      const on = selected.has(c.id)
      const isHint = hinted.has(c.id)
      const cls = [on ? 'card--selected' : '', isHint ? 'card--hint' : ''].filter(Boolean).join(' ')
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
    if (myHand.length === 0) hand.innerHTML = '<div class="hand-empty">手牌已出完</div>'

    // 手牌重叠率按容器宽度反算，保证任意张数都铺得下且角标可见
    fitHand(hand, myHand.length)
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
    if (s.settingsOpen) {
      ov.innerHTML = settingsPanel(s)
    } else if (s.logOpen) {
      ov.innerHTML = logPanel(s)
    } else if (s.phase === 'contract') {
      ov.innerHTML = `
        <div class="panel">
          <h2>定主</h2>
          <p class="muted">本局打 <b>${levelLabel(s.levelRank)}</b>${s.forcedNT ? '（打王级强制无将）' : ''}</p>
          <div class="trump-grid">
            ${[0, 1, 2, 3].map((t) => `<button class="btn trump-btn${t === 0 ? ' is-red' : t === 1 ? ' is-red' : ''}" data-trump="${t}">${SUIT_LABEL[t]}</button>`).join('')}
            <button class="btn trump-btn" data-trump="NT" ${s.forcedNT ? 'disabled' : ''}>无将</button>
          </div>
        </div>`
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
    if (msg) {
      t.className = `toast is-show${s.lastReject ? ' is-error' : ''}`
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
  const sw = (key: string, label: string, desc: string, on: boolean): string => `
    <div class="set-row">
      <span>${label}<small class="set-desc">${desc}</small></span>
      <button class="switch" role="switch" aria-checked="${on ? 'true' : 'false'}" data-cfg="${key}" aria-label="${label}"></button>
    </div>`

  const seg = (act: string, name: string, opts: { v: string; label: string; on: boolean }[]): string => `
    <div class="seg" role="group" aria-label="${name}">
      ${opts.map((o) => `<button data-act="${act}" data-val="${o.v}" class="${o.on ? 'is-on' : ''}" aria-pressed="${o.on ? 'true' : 'false'}">${o.label}</button>`).join('')}
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
      ${sw('guardJA', 'J,A 必打', '升级时不可跳过这些级牌', c.guardJA)}
      ${sw('guardKingLevel', '打王必打', '升级时不可跳过打王级', c.guardKingLevel)}
    </div>

    <div class="set-group">
      <h3>体验</h3>
      <div class="set-row">
        <span>AI 难度</span>
        ${seg('setAiLevel', 'AI 难度', [
          { v: '0', label: '简单', on: s.aiLevel === 0 },
          { v: '1', label: '普通', on: s.aiLevel === 1 },
          { v: '2', label: '困难', on: s.aiLevel === 2 },
        ])}
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
    </div>

    <div class="set-foot">
      「必打」是<b>升级时禁止跳级</b>的限制，与出牌无关（见规则书 §10.3）。
    </div>

    <button class="btn btn--primary" data-act="closeSettings">完成</button>
  </div>`
}

/** 对局记录面板（FR-20） */
function logPanel(s: GameState): string {
  const tricks = [...s.history].reverse()
  const items = tricks
    .map((t, i) => {
      const rows = t.plays
        .map((p) => {
          const txt = p.cards
            .map((c) => cardText(c))
            .join(' ')
          return `<div class="log-play${p.seat === t.winner ? ' is-winner' : ''}">
            <em>${SEAT_LABEL[p.seat]}</em><span>${escapeHtml(txt)}</span>
          </div>`
        })
        .join('')
      const no = s.history.length - i
      return `<div class="log-trick${t.plays.some((p) => p.seat === t.winner) ? ' is-win' : ''}">
        <div class="log-trick-head">
          <span>第 ${no} 墩</span>
          <b>${SEAT_LABEL[t.winner]} 赢 · ${t.score} 分</b>
        </div>
        <div class="log-plays">${rows}</div>
      </div>`
    })
    .join('')

  return `<div class="panel panel--wide" role="dialog" aria-label="对局记录">
    <h2>对局记录</h2>
    <p class="muted">已打完 ${s.history.length} 墩（仅内存，不写存档）</p>
    ${items ? `<div class="log-list">${items}</div>` : '<div class="log-empty">还没有打完的墩</div>'}
    <button class="btn btn--primary" data-act="toggleLog">关闭</button>
  </div>`
}

/** 牌面文字摘要：♠A ♥10 … */
function cardText(c: Card): string {
  const suit = '♠♥♣♦'[c.value % 13 >= 0 ? Math.floor(c.value / 13) : 0] as string
  const rank = RANK_TEXT[c.value % 13] as string
  if (c.value === 52) return '小王'
  if (c.value === 53) return '大王'
  return `${suit}${rank}`
}

const RANK_TEXT = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'] as const

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
 */
function fitHand(hand: HTMLElement, count: number): void {
  if (count <= 1) return
  const cardW = hand.firstElementChild
    ? (hand.firstElementChild as HTMLElement).getBoundingClientRect().width
    : 92
  const avail = hand.clientWidth
  if (!avail || !cardW) return
  const step = Math.min(0.58, Math.max(0.3, (avail - cardW) / ((count - 1) * cardW)))
  hand.style.setProperty('--hand-step', step.toFixed(3))
}

function bind(root: HTMLElement, s: GameState, act: Actions): void {  root.onclick = (ev) => {
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
      case 'hint':
        act.hint()
        break
      case 'bury':
        act.dispatch({ type: 'bury', ids: [...s.selected] })
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
      case 'setAiLevel':
        if (val !== undefined) act.dispatch({ type: 'setAiLevel', level: Number(val) as 0 | 1 | 2 })
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
