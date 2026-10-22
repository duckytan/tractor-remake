/**
 * 牌面渲染器 —— 设计预览用（无构建、无依赖）
 *
 * 坐标系统：卡面固定 100 × 140（比例 1 : 1.4，等同 poker size 63.5×88.9mm）
 * 花色 path 统一归一化到 0..100 的方框内，保证四种花色视觉重量一致。
 *
 * 整个文件包在 IIFE 里，只向 window 暴露 CardDesign，避免污染全局。
 */

;(function () {
  'use strict'

/* ---------- 花色 path ---------- */

const SUIT_PATHS = {
  spade: [
    'M50 10 C40 24 10 44 10 64 C10 77 19 85 29 83 C36 82 42 78 45 72 C44 80 41 88 36 95 L64 95 C59 88 56 80 55 72 C58 78 64 82 71 83 C81 85 90 77 90 64 C90 44 60 24 50 10 Z',
  ],
  heart: [
    'M50 90 C50 90 10 62 10 36 C10 22 20 12 32 12 C41 12 47 18 50 26 C53 18 59 12 68 12 C80 12 90 22 90 36 C90 62 50 90 50 90 Z',
  ],
  club: [
    'M30 30 a20 20 0 1 0 40 0 a20 20 0 1 0 -40 0',
    'M8 64 a20 20 0 1 0 40 0 a20 20 0 1 0 -40 0',
    'M52 64 a20 20 0 1 0 40 0 a20 20 0 1 0 -40 0',
    'M44 62 L56 62 L62 95 L38 95 Z',
  ],
  diamond: ['M50 6 L82 50 L50 94 L18 50 Z'],
}

const SUIT_NAME = { spade: '黑桃', heart: '红心', club: '梅花', diamond: '方片' }

/* ---------- 点数与 pip 布局 ---------- */

/**
 * 坐标写在 100×140 卡面上；第三项 1 = 该 pip 需倒置。
 *
 * 版面分区（关键约束，改动前先看这里）：
 *   角标区   左上 x 6..22  y 5..41      镜像后 右下 x 78..94 y 99..135
 *   可用 pip 区  x 26..74  y 24..118
 *   ⇒ 两列 pip 放在 x = 34 / 66，任何 pip 都不会碰到角标。
 *   ⇒ 单列 pip 放在 x = 50。
 */
const PIP_LAYOUT = {
  '2':  { s: 0.28, p: [[50, 38], [50, 102, 1]] },
  '3':  { s: 0.25, p: [[50, 34], [50, 70], [50, 106, 1]] },
  '4':  { s: 0.24, p: [[34, 38], [66, 38], [34, 102, 1], [66, 102, 1]] },
  '5':  { s: 0.24, p: [[34, 38], [66, 38], [50, 70], [34, 102, 1], [66, 102, 1]] },
  '6':  { s: 0.22, p: [[34, 34], [66, 34], [34, 70], [66, 70], [34, 106, 1], [66, 106, 1]] },
  '7':  { s: 0.22, p: [[34, 34], [66, 34], [50, 52], [34, 70], [66, 70], [34, 106, 1], [66, 106, 1]] },
  '8':  { s: 0.22, p: [[34, 34], [66, 34], [50, 52], [34, 70], [66, 70], [50, 88, 1], [34, 106, 1], [66, 106, 1]] },
  '9':  { s: 0.20, p: [[34, 30], [66, 30], [34, 57], [66, 57], [50, 70], [34, 83, 1], [66, 83, 1], [34, 110, 1], [66, 110, 1]] },
  '10': { s: 0.20, p: [[34, 30], [66, 30], [50, 43], [34, 57], [66, 57], [50, 97, 1], [34, 83, 1], [66, 83, 1], [34, 110, 1], [66, 110, 1]] },
}

const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A']
const SUITS = ['spade', 'heart', 'club', 'diamond']

/* ---------- 绘制基元 ---------- */

/** 在 (cx, cy) 处画一个花色，scale 为相对 100 单位的缩放 */
function suitMark(suit, cx, cy, scale, flip = false) {
  const paths = SUIT_PATHS[suit].map((d) => `<path d="${d}"/>`).join('')
  const tx = (cx - 50 * scale).toFixed(2)
  const ty = (cy - 50 * scale).toFixed(2)
  const rot = flip ? ' rotate(180 50 50)' : ''
  return `<g transform="translate(${tx},${ty}) scale(${scale})${rot}" fill="currentColor">${paths}</g>`
}

/** 角标（左上）：点数 + 小花色。整体收窄，避免与 pip 区相撞 */
function cornerIndex(rank, suit) {
  const size = rank.length > 1 ? 15 : 21
  const ls = rank.length > 1 ? -1 : 0
  return `<text x="7" y="23" font-size="${size}" font-weight="600" letter-spacing="${ls}">${rank}</text>`
    + suitMark(suit, 13, 33, 0.155)
}

/* ---------- 主渲染 ---------- */

/**
 * 生成一张牌
 * @param {{rank:string, suit?:string, joker?:'big'|'small'}} card
 * @param {{cls?:string, w?:number}} [opt]
 */
function cardHTML(card, opt = {}) {
  const cls = ['card', opt.cls || ''].filter(Boolean).join(' ')
  const style = opt.w ? ` style="--card-w:${opt.w}px"` : ''

  if (card.joker) {
    return `<div class="${cls}" data-joker="${card.joker}"${style}>
      <svg viewBox="0 0 100 140" class="card__face" aria-label="${card.joker === 'big' ? '大王' : '小王'}">
        <rect class="paper" x="0.5" y="0.5" width="99" height="139" rx="6"/>
        <rect class="inner" x="4" y="4" width="92" height="132" rx="3"/>
        <g class="ink">
          <text x="7" y="22" font-size="12" font-weight="600" letter-spacing="-0.2">JKR</text>
          <text x="50" y="36" font-size="6" text-anchor="middle" dominant-baseline="central" letter-spacing="1.2" class="joker-sub">JOKER</text>
          <text x="50" y="70" font-size="32" font-weight="600" text-anchor="middle" dominant-baseline="central">${card.joker === 'big' ? '大' : '小'}</text>
          <text x="50" y="104" font-size="32" font-weight="600" text-anchor="middle" dominant-baseline="central">王</text>
        </g>
        <g class="ink" transform="rotate(180 50 70)">
          <text x="7" y="22" font-size="12" font-weight="600" letter-spacing="-0.2">JKR</text>
        </g>
      </svg>
    </div>`
  }

  const { rank, suit } = card
  const layout = PIP_LAYOUT[rank]
  let pips = ''
  if (layout) {
    pips = layout.p.map(([x, y, flip]) => suitMark(suit, x, y, layout.s, !!flip)).join('')
  } else if (rank === 'A') {
    // 大花色居中偏下，必须完全避开角标区（y < 41）
    pips = suitMark(suit, 50, 80, 0.62)
  } else {
    // J / Q / K：中央字母 + 花边方框 + 下方花色（模拟人头牌的"画框"结构）
    pips = `<rect class="court" x="24" y="28" width="52" height="84" rx="3"/>`
      + `<text x="50" y="62" font-size="38" font-weight="600" text-anchor="middle" dominant-baseline="central">${rank}</text>`
      + suitMark(suit, 50, 100, 0.22)
  }

  return `<div class="${cls}" data-suit="${suit}" data-rank="${rank}"${style}>
    <svg viewBox="0 0 100 140" class="card__face" aria-label="${SUIT_NAME[suit]}${rank}">
      <rect class="paper" x="0.5" y="0.5" width="99" height="139" rx="6"/>
      <rect class="inner" x="4" y="4" width="92" height="132" rx="3"/>
      <g class="ink">
        ${cornerIndex(rank, suit)}
        ${pips}
      </g>
      <g class="ink" transform="rotate(180 50 70)">${cornerIndex(rank, suit)}</g>
    </svg>
  </div>`
}

/* ---------- 牌背 ---------- */

/**
 * 牌背图案用 SVG <pattern> 定义一次，全页共用。
 * 优点：细密可控、随卡面缩放（patternUnits=userSpaceOnUse 走 viewBox 单位）、
 *      不像 CSS 渐变那样受像素密度影响。
 */
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
  <pattern id="bk-diag" width="9" height="9" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
    <rect width="9" height="9" fill="#1a3a6b"/>
    <rect width="4.5" height="9" fill="#28548f"/>
  </pattern>
</defs>`

const BACK_STYLES = {
  1: { fill: 'url(#bk-diamond)', med: 16, ink: '#8fbcf5' },
  2: { fill: 'url(#bk-dots)',    med: 11, ink: '#5c93d8' },
  3: { fill: 'url(#bk-diag)',    med: 16, ink: '#9cc8f8' },
  4: { fill: '#241d47',          med: 22, ink: '#a79df0' },
}

/**
 * 牌背边框：点线带 + 细实线
 * 这一层是"像扑克牌"的关键 —— 只有图案的牌背看起来像壁纸，
 * 加上双线边框 + 点线带才有印刷品的味道。
 */
function backFrame() {
  return `<rect x="7" y="7" width="86" height="126" rx="2.5" fill="none"
            stroke="#ffffff" stroke-opacity="0.42" stroke-width="1.1" stroke-dasharray="1.6 2.4"/>`
    + `<rect x="10.5" y="10.5" width="79" height="119" rx="1.5" fill="none"
            stroke="#ffffff" stroke-opacity="0.26" stroke-width="0.5"/>`
}

/** 中心徽记：实心圆盘 + 内环 + 菱形 */
function medallion(cx, cy, r, ink) {
  return `<circle cx="${cx}" cy="${cy}" r="${r + 1.6}" fill="#08152b" fill-opacity="0.5"/>`
    + `<circle cx="${cx}" cy="${cy}" r="${r}" fill="#08152b" stroke="${ink}" stroke-width="1" stroke-opacity="0.95"/>`
    + `<circle cx="${cx}" cy="${cy}" r="${(r * 0.76).toFixed(2)}" fill="none" stroke="${ink}" stroke-width="0.55" stroke-opacity="0.65"/>`
    + `<path d="M${cx} ${cy - r * 0.5} L${cx + r * 0.46} ${cy} L${cx} ${cy + r * 0.5} L${cx - r * 0.46} ${cy} Z" fill="${ink}" fill-opacity="0.95"/>`
}

/** 牌背。白边 3.5%（接近真牌），点线边框 + 可选中心徽记 */
function backHTML(variant = 1, opt = {}) {
  const s = BACK_STYLES[variant] || BACK_STYLES[1]
  const cls = ['card', 'card--back', opt.cls || ''].filter(Boolean).join(' ')
  const style = opt.w ? ` style="--card-w:${opt.w}px"` : ''
  return `<div class="${cls}" data-back="${variant}"${style}>
    <svg viewBox="0 0 100 140" class="card__face" aria-label="牌背">
      <rect class="paper" x="0.5" y="0.5" width="99" height="139" rx="6"/>
      <rect x="3.5" y="3.5" width="93" height="133" rx="3.5" fill="${s.fill}"/>
      ${backFrame()}
      ${s.med ? medallion(50, 70, s.med, s.ink) : ''}
    </svg>
  </div>`
}

/** 一副完整牌（54 张） */
function fullDeck() {
  const out = []
  for (const suit of SUITS) for (const rank of RANKS) out.push({ rank, suit })
  out.push({ joker: 'small' }, { joker: 'big' })
  return out
}

window.CardDesign = {
  cardHTML, backHTML, backDefs: () => BACK_DEFS, fullDeck,
  SUITS, RANKS, SUIT_NAME, SUIT_PATHS, PIP_LAYOUT, BACK_STYLES,
}

})()
