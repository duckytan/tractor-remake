/**
 * 牌面渲染（DOM + SVG）
 * 设计基准见 design/preview.html 与 docs/10-牌面与素材设计参考.md
 */

import type { Card, Suit } from '@core'

const SUIT_PATHS: Record<Suit, string[]> = {
  0: [
    // 黑桃
    'M50 10 C40 24 10 44 10 64 C10 77 19 85 29 83 C36 82 42 78 45 72 C44 80 41 88 36 95 L64 95 C59 88 56 80 55 72 C58 78 64 82 71 83 C81 85 90 77 90 64 C90 44 60 24 50 10 Z',
  ],
  1: [
    // 红心
    'M50 90 C50 90 10 62 10 36 C10 22 20 12 32 12 C41 12 47 18 50 26 C53 18 59 12 68 12 C80 12 90 22 90 36 C90 62 50 90 50 90 Z',
  ],
  2: [
    // 梅花
    'M30 30 a20 20 0 1 0 40 0 a20 20 0 1 0 -40 0',
    'M8 64 a20 20 0 1 0 40 0 a20 20 0 1 0 -40 0',
    'M52 64 a20 20 0 1 0 40 0 a20 20 0 1 0 -40 0',
    'M44 62 L56 62 L62 95 L38 95 Z',
  ],
  3: ['M50 6 L82 50 L50 94 L18 50 Z'], // 方片
}

const RANK_LABELS = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A']

interface PipLayout {
  readonly s: number
  readonly p: readonly (readonly [number, number] | readonly [number, number, 1])[]
}

const PIP_LAYOUT: Record<string, PipLayout> = {
  '2': { s: 0.28, p: [[50, 38], [50, 102, 1]] },
  '3': { s: 0.25, p: [[50, 34], [50, 70], [50, 106, 1]] },
  '4': { s: 0.24, p: [[34, 38], [66, 38], [34, 102, 1], [66, 102, 1]] },
  '5': { s: 0.24, p: [[34, 38], [66, 38], [50, 70], [34, 102, 1], [66, 102, 1]] },
  '6': { s: 0.22, p: [[34, 34], [66, 34], [34, 70], [66, 70], [34, 106, 1], [66, 106, 1]] },
  '7': { s: 0.22, p: [[34, 34], [66, 34], [50, 52], [34, 70], [66, 70], [34, 106, 1], [66, 106, 1]] },
  '8': { s: 0.22, p: [[34, 34], [66, 34], [50, 52], [34, 70], [66, 70], [50, 88, 1], [34, 106, 1], [66, 106, 1]] },
  '9': { s: 0.2, p: [[34, 30], [66, 30], [34, 57], [66, 57], [50, 70], [34, 83, 1], [66, 83, 1], [34, 110, 1], [66, 110, 1]] },
  '10': { s: 0.2, p: [[34, 30], [66, 30], [50, 43], [34, 57], [66, 57], [50, 97, 1], [34, 83, 1], [66, 83, 1], [34, 110, 1], [66, 110, 1]] },
}

const BACK_DEFS = `<defs>
  <pattern id="bk-diamond" width="13" height="13" patternUnits="userSpaceOnUse">
    <rect width="13" height="13" fill="#16325e"/>
    <path d="M6.5 0 L13 6.5 L6.5 13 L0 6.5 Z" fill="none" stroke="#3f7dd0" stroke-width="1.2" stroke-opacity="0.8"/>
    <circle cx="6.5" cy="6.5" r="1.25" fill="#6fa4e8" fill-opacity="0.65"/>
  </pattern>
  <pattern id="bk-dots" width="12" height="12" patternUnits="userSpaceOnUse">
    <rect width="12" height="12" fill="#12294f"/>
    <circle cx="6" cy="6" r="1.5" fill="#3f6db0"/>
    <circle cx="0" cy="0" r="1.5" fill="#3f6db0"/>
    <circle cx="12" cy="0" r="1.5" fill="#3f6db0"/>
    <circle cx="0" cy="12" r="1.5" fill="#3f6db0"/>
    <circle cx="12" cy="12" r="1.5" fill="#3f6db0"/>
  </pattern>
</defs>`

let defsInjected = false

/** 注入 SVG <pattern> 定义（只做一次） */
export function ensureDefs(): void {
  if (defsInjected) return
  defsInjected = true
  const host = document.createElement('div')
  host.style.position = 'absolute'
  host.style.width = '0'
  host.style.height = '0'
  host.style.overflow = 'hidden'
  host.innerHTML = `<svg aria-hidden="true">${BACK_DEFS}</svg>`
  document.body.appendChild(host)
}

function suitMark(suit: Suit, cx: number, cy: number, scale: number, flip = false): string {
  const paths = SUIT_PATHS[suit].map((d) => `<path d="${d}"/>`).join('')
  const tx = (cx - 50 * scale).toFixed(2)
  const ty = (cy - 50 * scale).toFixed(2)
  const rot = flip ? ' rotate(180 50 50)' : ''
  return `<g transform="translate(${tx},${ty}) scale(${scale})${rot}">${paths}</g>`
}

function cornerIndex(rank: string, suit: Suit): string {
  const size = rank.length > 1 ? 15 : 21
  const ls = rank.length > 1 ? -1 : 0
  return `<text x="7" y="23" font-size="${size}" font-weight="600" letter-spacing="${ls}">${rank}</text>`
    + suitMark(suit, 13, 33, 0.155)
}

export interface CardVisual {
  readonly value: number
}

/** 牌值 → 花色（王返回 null） */
const suitOf = (v: number): Suit | null => (v >= 52 ? null : (Math.floor(v / 13) as Suit))
const rankOf = (v: number): string | null => (v >= 52 ? null : (RANK_LABELS[v % 13] as string))

function faceSVG(card: Card): string {
  const v = card.value
  if (v >= 52) {
    const big = v === 53
    return `<svg viewBox="0 0 100 140" class="card__face" aria-label="${big ? '大王' : '小王'}">
      <rect class="paper" x="0.5" y="0.5" width="99" height="139" rx="6"/>
      <rect class="inner" x="4" y="4" width="92" height="132" rx="3"/>
      <g class="ink">
        <text x="7" y="22" font-size="12" font-weight="600" letter-spacing="-0.2">JKR</text>
        <text x="50" y="36" font-size="6" text-anchor="middle" dominant-baseline="central" letter-spacing="1.2" class="joker-sub">JOKER</text>
        <text x="50" y="70" font-size="32" font-weight="600" text-anchor="middle" dominant-baseline="central">${big ? '大' : '小'}</text>
        <text x="50" y="104" font-size="32" font-weight="600" text-anchor="middle" dominant-baseline="central">王</text>
      </g>
      <g class="ink" transform="rotate(180 50 70)">
        <text x="7" y="22" font-size="12" font-weight="600" letter-spacing="-0.2">JKR</text>
      </g>
    </svg>`
  }

  const suit = suitOf(v) as Suit
  const rank = rankOf(v) as string
  const layout = PIP_LAYOUT[rank]

  let pips: string
  if (layout) {
    pips = layout.p.map(([x, y, f]) => suitMark(suit, x, y, layout.s, f === 1)).join('')
  } else if (rank === 'A') {
    pips = suitMark(suit, 50, 80, 0.62)
  } else {
    pips = `<rect class="court" x="24" y="28" width="52" height="84" rx="3"/>`
      + `<text x="50" y="62" font-size="38" font-weight="600" text-anchor="middle" dominant-baseline="central">${rank}</text>`
      + suitMark(suit, 50, 100, 0.22)
  }

  const suitName = ['黑桃', '红心', '梅花', '方片'][suit]
  return `<svg viewBox="0 0 100 140" class="card__face" aria-label="${suitName}${rank}">
    <rect class="paper" x="0.5" y="0.5" width="99" height="139" rx="6"/>
    <rect class="inner" x="4" y="4" width="92" height="132" rx="3"/>
    <g class="ink">${cornerIndex(rank, suit)}${pips}</g>
    <g class="ink" transform="rotate(180 50 70)">${cornerIndex(rank, suit)}</g>
  </svg>`
}

export interface CardElOptions {
  readonly cls?: string
  readonly width?: number
  readonly id?: number
  readonly title?: string
}

export function cardEl(card: Card, o: CardElOptions = {}): HTMLElement {
  const el = document.createElement('div')
  const suit = suitOf(card.value)
  el.className = ['card', o.cls].filter(Boolean).join(' ')
  if (suit !== null) el.dataset.suit = String(suit)
  if (card.value >= 52) el.dataset.joker = card.value === 53 ? 'big' : 'small'
  if (o.width) el.style.setProperty('--card-w', `${o.width}px`)
  if (o.id !== undefined) el.dataset.id = String(o.id)
  if (o.title) el.title = o.title
  el.innerHTML = faceSVG(card)
  return el
}

export function backEl(variant: 1 | 2 = 1, o: CardElOptions = {}): HTMLElement {
  const el = document.createElement('div')
  el.className = ['card', 'card--back', o.cls].filter(Boolean).join(' ')
  el.dataset.back = String(variant)
  if (o.width) el.style.setProperty('--card-w', `${o.width}px`)
  const fill = variant === 1 ? 'url(#bk-diamond)' : 'url(#bk-dots)'
  el.innerHTML = `<svg viewBox="0 0 100 140" class="card__face" aria-label="牌背">
    <rect class="paper" x="0.5" y="0.5" width="99" height="139" rx="6"/>
    <rect x="3.5" y="3.5" width="93" height="133" rx="3.5" fill="${fill}"/>
    <rect x="7" y="7" width="86" height="126" rx="2.5" fill="none" stroke="#fff" stroke-opacity="0.42" stroke-width="1.1" stroke-dasharray="1.6 2.4"/>
    <rect x="10.5" y="10.5" width="79" height="119" rx="1.5" fill="none" stroke="#fff" stroke-opacity="0.26" stroke-width="0.5"/>
  </svg>`
  return el
}

/** 牌名（调试 / 无障碍） */
export function cardName(c: Card): string {
  const v = c.value
  if (v === 52) return '小王'
  if (v === 53) return '大王'
  return `${['♠', '♥', '♣', '♦'][Math.floor(v / 13)]}${RANK_LABELS[v % 13]}`
}

/**
 * 牌名（**口语版**，给屏幕阅读器用）。
 *
 * 和 `cardName` 的区别：花色写成汉字而不是符号。屏幕阅读器读「♠2」常常读成
 * 「黑桃符号 2」或者干脆跳过符号，读「黑桃2」才稳定。
 *
 * 为什么需要它（docs/37 E-4）：手牌元素的 `aria-label` 之前只写「第 105 张牌」，
 * 而 `aria-label` 会**覆盖**内部 SVG 上的牌面名称 —— 视障用户能 Tab 到手牌，
 * 却完全不知道手里是什么牌，等于这个游戏对他们不可玩。
 */
export function cardSpokenName(c: Card): string {
  const v = c.value
  if (v === 52) return '小王'
  if (v === 53) return '大王'
  return `${['黑桃', '红心', '梅花', '方片'][Math.floor(v / 13)]}${RANK_LABELS[v % 13]}`
}
