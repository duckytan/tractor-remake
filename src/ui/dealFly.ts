/**
 * 发牌飞行轨迹（FE-1 的剩余部分）
 *
 * ## 为什么不能只用 CSS 动画
 *
 * `render()` 每次 paint 都整棵重建（`root.innerHTML = ...`），卡牌元素是全新的。
 * 挂在上面的 `animation` 会在下一个发牌 tick（55ms）随元素一起被丢掉 ——
 * 原来那个 `.card--deal`（0.3s 的 dealIn）实际只播了一个 tick，玩家看到的
 * 仍然是「牌凭空出现在手上」。所以飞行牌必须挂在一个**不随 render 重建**的
 * 容器上：这里用 `document.body` 下的固定定位层，结束后自毁。
 *
 * ## 为什么终点要每帧重算
 *
 * 手牌是居中排布的，每多发一张整排都会重排（`fitHand` 还会按张数反算重叠率）。
 * 开局时量好的坐标，300ms 后早就不是那张牌的位置了 —— 牌会落在一个空位上。
 * 所以每帧重新量一次目标元素（一次 `querySelector`，同时最多 6 张在飞，代价可忽略）。
 *
 * ## 真牌为什么要藏起来
 *
 * 不藏的话会看到「牌已经在手上了，同时还有一张在飞」。真牌在飞行期间由
 * `.card--incoming` 占位但不可见，落地那一帧才显形；因为终点是每帧重算的，
 * 显形时它正好落在飞行牌最后的位置上，没有跳变。
 */

import type { Card } from '@core'
import { HUMAN_SEAT } from '@app/state'
import type { AnimSpeed, GameState } from '@app/state'
import { ANIM_SPEED_SCALE } from '@app/state'
import { cardEl } from './card'

/**
 * 动画速度倍率（慢 1.6 / 中 1 / 快 0.6）。
 * 由 `render()` 每次 paint 时按 `state.animSpeed` 写入，所有卡牌动画的时长都乘它。
 */
let animScale = 1

export function setAnimScale(speed: AnimSpeed): void {
  animScale = ANIM_SPEED_SCALE[speed] ?? 1
}

/** 把基准时长换算成当前档位的时长（ms） */
export function animMs(base: number): number {
  return Math.round(base * animScale)
}

/**
 * 飞行时长。
 * 明显长于一个发牌 tick（`DEAL_INTERVAL_MS = 55`）⇒ 同时会有好几张在飞，
 * 和真人发牌一样是连续的一串，而不是一张一张「跳」。
 */
const FLY_MS = 320

/** 弧线抬升幅度（px）。让牌走一条抛物线，而不是直线平移 */
const ARC_LIFT = 24

/** 正在飞的牌（按 `card.id`）。`render()` 用它把「还没落地」的真牌藏起来 */
const inFlight = new Set<number>()

/** 这张牌是不是还在飞（render 用） */
export function isInFlight(id: number): boolean {
  return inFlight.has(id)
}

/** 上一次 paint 时的发牌进度，用来判断这一 tick 新发了哪一张 */
let lastRevealed = 0

/** 飞行层。挂在 body 下 —— 必须脱离 `root`，否则会被 `root.innerHTML` 清掉 */
let layer: HTMLElement | null = null

function ensureLayer(): HTMLElement {
  if (layer !== null && layer.isConnected) return layer
  layer = document.createElement('div')
  layer.className = 'deal-fly'
  layer.setAttribute('aria-hidden', 'true')
  document.body.appendChild(layer)
  return layer
}

const easeOut = (t: number): number => 1 - (1 - t) ** 3

/**
 * 每次 paint 之后调用一次，判断这一帧要不要起飞一张牌。
 *
 * 只在「正常逐张发牌」时起飞：`revealed` 恰好 +1。
 * 亮主后 `applyDeclare` 会把剩下的牌一次性补满（一次跳十几张），
 * 那种批量落袋不该逐张飞 —— 十几张同时糊在桌上反而更乱，直接跳过。
 */
export function trackDealAnimation(root: HTMLElement, s: GameState): void {
  const prev = lastRevealed
  lastRevealed = s.revealed

  if (!s.animation) return
  if (s.phase !== 'contract') return
  if (s.revealed !== prev + 1) return

  const hand = s.hands[HUMAN_SEAT] as readonly Card[]
  const card = hand[s.revealed - 1]
  if (card === undefined) return

  const deck = root.querySelector<HTMLElement>('[data-slot="deck"]')
  if (deck === null) return

  // 手牌重建后是全新元素，所以每次都要重新查，不能缓存
  const findTarget = (): HTMLElement | null =>
    root.querySelector<HTMLElement>(`[data-slot="hand"] [data-id="${card.id}"]`)

  const target = findTarget()
  if (target === null) return

  const box = target.getBoundingClientRect()
  const width = box.width
  if (width <= 0) return

  // 先量尺寸再藏：`visibility: hidden` 仍然占位，布局不变，不会让整排手牌抖动
  target.style.visibility = 'hidden'
  inFlight.add(card.id)

  const from = deck.getBoundingClientRect()
  const startCx = from.left + from.width / 2
  const startCy = from.top + from.height / 2

  const el = cardEl(card, { width: Math.round(width), cls: 'deal-fly__card' })
  el.style.left = `${startCx - width / 2}px`
  el.style.top = `${startCy - box.height / 2}px`
  ensureLayer().appendChild(el)

  // 牌堆上的牌比手牌小 ⇒ 起飞时缩小，落位时恢复到 1
  const deckScale = Math.max(0.35, Math.min(1, from.width / width))

  const dur = animMs(FLY_MS)
  const t0 = performance.now()
  let done = false

  const finish = (): void => {
    if (done) return
    done = true
    el.remove()
    inFlight.delete(card.id)
    const t = findTarget()
    if (t !== null) t.style.visibility = 'visible'
  }

  const frame = (now: number): void => {
    if (done) return
    const raw = Math.min(1, (now - t0) / dur)

    const cur = findTarget()
    if (cur === null) {
      finish()
      return
    }
    const r = cur.getBoundingClientRect()
    const endCx = r.left + r.width / 2
    const endCy = r.top + r.height / 2

    const t = easeOut(raw)
    const lift = Math.sin(raw * Math.PI) * ARC_LIFT
    const cx = startCx + (endCx - startCx) * t
    const cy = startCy + (endCy - startCy) * t - lift
    const scale = deckScale + (1 - deckScale) * t

    el.style.transform =
      `translate(${cx - startCx}px, ${cy - startCy}px) ` +
      `scale(${scale}) rotate(${(-7 * (1 - t)).toFixed(2)}deg)`

    if (raw >= 1) {
      finish()
      return
    }
    requestAnimationFrame(frame)
  }

  requestAnimationFrame(frame)
  // 兜底：标签页切到后台时 rAF 会暂停，没有这个兜底真牌会一直藏着不显形
  window.setTimeout(finish, dur + 400)
}

/* ============================================================
 * 出牌 / 收墩 / 手牌重排（v1.3.8）
 *
 * 与发牌飞行共用同一套「幽灵牌」机制：真牌先藏（inFlight + .card--incoming），
 * 飞行层里放一张等尺寸的克隆牌做抛物线运动，落地那帧再把真牌揭开。
 * 原因同发牌：`render()` 每次 paint 都重建 DOM，挂在元素上的 CSS animation
 * 会在下一次 paint 随元素一起消失。
 * ============================================================ */

/** 出牌飞行基准时长（中速） */
const PLAY_FLY_MS = 280
/** 收墩归位基准时长 */
const COLLECT_MS = 340
/** 手牌重排（FLIP）基准时长 */
const FLIP_MS = 200

export interface FxPlay {
  readonly cards: readonly Card[]
  readonly rects: readonly DOMRect[]
}

/** paint 之前的「动画前」快照，paint 之后用它对比出新出的牌 / 刚结算的墩 */
export interface FxSnapshot {
  /** 人类手牌：卡 id → 矩形（出牌的起飞点） */
  readonly hand: Map<number, DOMRect>
  /** 本墩各家已出的牌（收墩的起飞点） */
  readonly plays: Map<number, FxPlay>
  /** 三家 AI 的牌背区（AI 出牌的起飞点 / 收墩的落点） */
  readonly seats: Map<number, DOMRect>
  /** 人类手牌区（兜底起飞点 / 收墩落点） */
  readonly southHand: DOMRect | null
  readonly histLen: number
}

/**
 * 必须在 `render()` 之前调用 —— render 会重建整棵 DOM，旧元素就量不到了。
 *
 * `prevState` 必须是**上一次 paint 用的状态**（不是当前状态）：此时 DOM 还是
 * 上一帧的画面，本墩已出的牌要按上一帧的 `trick.plays` 来取。
 * 传当前状态会拿到「结算后已清空」的 trick ⇒ 收墩动画永远触发不了（踩过）。
 */
export function captureFx(root: HTMLElement, prevState: GameState): FxSnapshot {
  const hand = new Map<number, DOMRect>()
  for (const el of root.querySelectorAll<HTMLElement>('[data-slot="hand"] .card[data-id]')) {
    hand.set(Number(el.dataset.id), el.getBoundingClientRect())
  }
  const plays = new Map<number, FxPlay>()
  for (const play of prevState.trick.plays) {
    const slot = play.seat === HUMAN_SEAT ? 'plays-mine' : `plays-${play.seat}`
    const els = root.querySelectorAll<HTMLElement>(`[data-slot="${slot}"] .plays__now .card[data-id]`)
    const rects = [...els].map((el) => el.getBoundingClientRect())
    if (rects.length === 0) continue
    plays.set(play.seat, { cards: play.cards, rects })
  }
  const seats = new Map<number, DOMRect>()
  for (const seat of [1, 2, 3]) {
    const el = root.querySelector<HTMLElement>(`[data-slot="back-${seat}"]`)
    if (el !== null) seats.set(seat, el.getBoundingClientRect())
  }
  const southHand =
    root.querySelector<HTMLElement>('[data-slot="hand"]')?.getBoundingClientRect() ?? null
  return { hand, plays, seats, southHand, histLen: prevState.history.length }
}

/**
 * 一张幽灵牌从 `from` 飞到 `to`。
 * 尺寸从出发牌插值到落点牌（手牌比出牌区大 ⇒ 有「甩出去变小」的感觉）。
 */
function flyGhost(
  card: Card,
  from: DOMRect,
  to: DOMRect,
  dur: number,
  opts: { fade?: boolean; arc?: number } = {},
): void {
  const w0 = Math.round(from.width > 0 ? from.width : to.width)
  const w1 = Math.round(to.width > 0 ? to.width : w0)
  if (w0 <= 0 || w1 <= 0) return

  const sx = from.left + from.width / 2
  const sy = from.top + from.height / 2
  const tx = to.left + to.width / 2
  const ty = to.top + to.height / 2

  const el = cardEl(card, { width: w0, cls: 'deal-fly__card' })
  el.style.left = `${sx - w0 / 2}px`
  el.style.top = `${sy - (w0 * 1.4) / 2}px`
  ensureLayer().appendChild(el)

  const arc = opts.arc ?? 16
  const endScale = w1 / w0
  const t0 = performance.now()
  let done = false

  const frame = (now: number): void => {
    if (done) return
    const raw = Math.min(1, (now - t0) / dur)
    const t = easeOut(raw)
    const lift = Math.sin(raw * Math.PI) * arc
    const cx = sx + (tx - sx) * t
    const cy = sy + (ty - sy) * t - lift
    const sc = 1 + (endScale - 1) * t
    const rot = (opts.fade ? 10 : -6) * (1 - t)
    el.style.transform = `translate(${cx - sx}px, ${cy - sy}px) scale(${sc.toFixed(3)}) rotate(${rot.toFixed(2)}deg)`
    if (opts.fade) el.style.opacity = String(1 - t * 0.85)
    if (raw >= 1) {
      done = true
      el.remove()
      return
    }
    requestAnimationFrame(frame)
  }
  requestAnimationFrame(frame)
  // 兜底：标签页切后台时 rAF 会暂停，别把幽灵牌永远留在层里
  window.setTimeout(() => {
    if (!done) {
      done = true
      el.remove()
    }
  }, dur + 400)
}

/** 手牌重排：出牌后整排重新居中，用 FLIP 滑过去而不是瞬移 */
function flipHand(root: HTMLElement, prev: FxSnapshot): void {
  const dur = animMs(FLIP_MS)
  for (const el of root.querySelectorAll<HTMLElement>('[data-slot="hand"] .card[data-id]')) {
    const id = Number(el.dataset.id)
    if (inFlight.has(id)) continue
    const before = prev.hand.get(id)
    if (before === undefined) continue
    const after = el.getBoundingClientRect()
    if (after.width === 0) continue
    const dx = before.left - after.left
    const dy = before.top - after.top
    if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue
    el.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }], {
      duration: dur,
      easing: 'cubic-bezier(.2,.8,.25,1)',
    })
  }
}

/**
 * 每次 paint 之后调用一次：出牌飞行、收墩归位、手牌重排。
 *
 * `prev` 是 paint **之前** `captureFx` 量到的快照。
 */
export function trackPlayFx(root: HTMLElement, s: GameState, prev: FxSnapshot): void {
  if (!s.animation || s.phase !== 'play') return

  // ① 出牌飞行：本墩新出现的牌，从「人类手牌 / AI 牌背」飞到出牌区
  for (const play of s.trick.plays) {
    const known = new Set(prev.plays.get(play.seat)?.cards.map((c) => c.id) ?? [])
    const slot = play.seat === HUMAN_SEAT ? 'plays-mine' : `plays-${play.seat}`
    const els = root.querySelectorAll<HTMLElement>(`[data-slot="${slot}"] .plays__now .card[data-id]`)
    for (const el of els) {
      const id = Number(el.dataset.id)
      if (known.has(id)) continue
      const card = play.cards.find((c) => c.id === id)
      if (card === undefined) continue
      const to = el.getBoundingClientRect()
      if (to.width <= 0) continue
      const from =
        play.seat === HUMAN_SEAT
          ? (prev.hand.get(id) ?? prev.southHand)
          : (prev.seats.get(play.seat) ?? null)
      if (from === null) continue

      // 真牌先藏：当前元素加 class，后续 paint 由 cardWrap 按 inFlight 继续藏
      inFlight.add(id)
      el.classList.add('card--incoming')
      const dur = animMs(PLAY_FLY_MS)
      flyGhost(card, from, to, dur, { arc: 14 })
      window.setTimeout(() => {
        inFlight.delete(id)
        const t = root.querySelector<HTMLElement>(
          `[data-slot="${slot}"] .plays__now .card[data-id="${id}"]`,
        )
        if (t !== null) t.classList.remove('card--incoming')
      }, dur)
    }
  }

  // ② 收墩归位：上一帧本墩有牌、这一帧刚结算 ⇒ 四家的牌飞向赢家并淡出
  if (s.history.length > prev.histLen && prev.plays.size > 0) {
    const rec = s.history[s.history.length - 1]
    const target = rec
      ? rec.winner === HUMAN_SEAT
        ? prev.southHand
        : (prev.seats.get(rec.winner) ?? null)
      : null
    if (target !== null && rec !== undefined) {
      const dur = animMs(COLLECT_MS)
      for (const { cards, rects } of prev.plays.values()) {
        cards.forEach((c, i) => {
          const r = rects[i]
          if (r !== undefined && r.width > 0) {
            flyGhost(c, r, target, dur, { fade: true, arc: 26 })
          }
        })
      }
      // 第 4 张牌：出牌与整墩结算发生在同一次 reduce 里，桌上从未出现过它。
      // 直接从「手牌 / 牌背」飞向赢家，否则这一张会凭空消失。
      for (const p of rec.plays) {
        if (prev.plays.has(p.seat)) continue
        const from =
          p.seat === HUMAN_SEAT
            ? (p.cards[0] !== undefined ? prev.hand.get(p.cards[0].id) : undefined) ?? prev.southHand
            : (prev.seats.get(p.seat) ?? null)
        if (from === null || from === undefined) continue
        for (const c of p.cards) flyGhost(c, from, target, dur, { fade: true, arc: 22 })
      }
    }
  }

  // ③ 手牌重排
  flipHand(root, prev)
}
