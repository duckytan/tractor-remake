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
import { backEl, cardEl } from './card'
import { newBackIndex } from '@app/view'
import type { Seat } from '@core'
import { justResolved, newPlaysSince } from './fxDiff'
import type { PlayLike } from './fxDiff'

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

/** AI 牌背的飞行时长（比人类手牌略短：同一 tick 三家一起飞，太长会糊成一团） */
const BACK_FLY_MS = 260

/** 正在飞的牌（按 `card.id`）。`render()` 用它把「还没落地」的真牌藏起来 */
const inFlight = new Set<number>()

/** 这张牌是不是还在飞（render 用） */
export function isInFlight(id: number): boolean {
  return inFlight.has(id)
}

/**
 * 正在飞的 **AI 牌背**，key = `座位:序号`。
 *
 * 牌背没有 card id（它不代表具体某张牌），所以单独一个集合；
 * `render` 按它给对应的牌背加 `.card--incoming` 先藏起来。
 */
const flyingBacks = new Set<string>()

export function isBackInFlight(seat: number, idx: number): boolean {
  return flyingBacks.has(`${seat}:${idx}`)
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

  const deck = root.querySelector<HTMLElement>('[data-slot="deck"]')
  if (deck === null) return

  // ① 三家的牌背：逐张发牌是「每 tick 四家各得 1 张」，所以同一 tick 三家一起飞。
  //    先做这一步再处理人类手牌 —— 下面有几处 early return（手牌越界等），
  //    放在后面会被那些分支跳过。
  flySeatBacks(root, s, prev, deck)

  // ② 人类手牌：从牌堆飞到手上
  const hand = s.hands[HUMAN_SEAT] as readonly Card[]
  const card = hand[s.revealed - 1]
  if (card === undefined) return

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

/* ---------- 收墩：落点怎么选 ----------
 *
 * 旧实现是「四家的牌都飞向赢家的手牌区 / 牌背区」，两个毛病：
 *   1. 人类出牌区就贴在手牌正上方，飞到手上必然压住自己的牌（玩家反馈的遮挡）；
 *   2. 隐喻也不对 —— 收墩的牌**不进手牌**，只记分。
 *
 * 现在改成「朝赢家方向、在桌面内部收拢一小段就消失」。
 */

/** 收墩落点离桌面并集中心的距离 = 并集短边 × 这个比例 */
const COLLECT_OFFSET_RATIO = 0.4

/** 收墩落点的牌宽 = 出发牌宽 × 这个系数（视觉上「收成一叠」） */
const COLLECT_SHRINK = 0.5

/** 收墩时每张牌的错峰间隔（ms）与总上限 —— 让「扫成一堆」有层次，而不是四张同时平移 */
const COLLECT_STAGGER = 16
const COLLECT_STAGGER_MAX = 72

/** 同屏最多允许几批收墩动画重叠（AI 瞬时速度下会墩接墩） */
const COLLECT_MAX_BATCH = 2

/** 正在跑的收墩批次数 */
let collecting = 0

/** 座位方向单位向量（0=南/下、1=西/左、2=北/上、3=东/右） */
const SEAT_DIR: Record<number, readonly [number, number]> = {
  0: [0, 1],
  1: [-1, 0],
  2: [0, -1],
  3: [1, 0],
}

/**
 * 收墩落点绝不允许压到的 UI。
 *
 * `.seat-tag` 必须在内：它不只出现在三家座位上方，**桌面正中那条
 * 「南（你）· 25 张」也是 `.seat-tag`**（挂在 `.seat--center` 里）。
 * 少写这一条，落点就会正好压在自己的名字牌上。
 */
const KEEP_OUT_SEL = [
  '[data-slot="hand"]',
  '[data-slot="handbar"]',
  '[data-slot="back-1"]',
  '[data-slot="back-2"]',
  '[data-slot="back-3"]',
  '.seat-tag',
  '.topbar',
  '.scorebar',
]

/** 落点方框的额外余量（幽灵牌有 drop-shadow，贴边也算压住） */
const KEEP_OUT_PAD = 4

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
    const box = root.querySelector<HTMLElement>(`[data-slot="back-${seat}"]`)
    if (box === null) continue
    // 取**最后一张牌背**而不是整块牌背区：牌背区是一整条（实测 239×64），
    // 拿它当起飞点会让幽灵牌的起始宽度变成整条区的宽度 —— 一张 239px 的巨牌
    // 先糊在牌背上再缩回去。这张「最新长出来的牌背」才是这张牌的视觉起点。
    const backs = box.querySelectorAll<HTMLElement>('.card')
    const el = backs[backs.length - 1] ?? box
    seats.set(seat, el.getBoundingClientRect())
  }
  const southHand =
    root.querySelector<HTMLElement>('[data-slot="hand"]')?.getBoundingClientRect() ?? null
  return { hand, plays, seats, southHand, histLen: prevState.history.length }
}

/** 只需要位置与尺寸 —— DOMRect 结构兼容，方便手搓「虚拟落点」 */
interface RectLike {
  readonly left: number
  readonly top: number
  readonly width: number
  readonly height: number
}

interface Box {
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
}

/** 一组矩形的并集包围盒（中心 + 宽高）；空集返回 null */
function unionBox(rects: readonly RectLike[]): Box | null {
  let l = Infinity
  let t = Infinity
  let r = -Infinity
  let b = -Infinity
  for (const q of rects) {
    if (q.width <= 0 || q.height <= 0) continue
    l = Math.min(l, q.left)
    t = Math.min(t, q.top)
    r = Math.max(r, q.left + q.width)
    b = Math.max(b, q.top + q.height)
  }
  if (!Number.isFinite(l)) return null
  return { x: (l + r) / 2, y: (t + b) / 2, w: r - l, h: b - t }
}

/**
 * 这个落点（按 w1 宽的牌算出的方框）会不会压到 UI？
 * 每墩只查一次，`querySelectorAll` 的代价可忽略。
 *
 * **桌面正中那条「南（你）· 25 张」不算**：它挂在 `.seat--center` 里，
 * 位置就是桌面几何中心 —— 而四家出牌区的并集中心也在那儿。
 * 把它算进禁入区，等于要求「收墩落点不许在桌面中间」，那所有方向都会被
 * 逼得退回原点。而且收墩不改手牌张数，牌扫过它 0.2 秒没有任何信息损失，
 * 就像真人用手把牌从桌上抹走会扫过桌心一样。
 */
function hitsKeepOut(cx: number, cy: number, w1: number): boolean {
  const h = w1 * 1.4
  const l = cx - w1 / 2 - KEEP_OUT_PAD
  const r = cx + w1 / 2 + KEEP_OUT_PAD
  const t = cy - h / 2 - KEEP_OUT_PAD
  const b = cy + h / 2 + KEEP_OUT_PAD
  for (const sel of KEEP_OUT_SEL) {
    for (const el of document.querySelectorAll<HTMLElement>(sel)) {
      if (el.closest('.seat--center') !== null) continue
      const q = el.getBoundingClientRect()
      if (q.width <= 0 || q.height <= 0) continue
      if (l < q.right && r > q.left && t < q.bottom && b > q.top) return true
    }
  }
  return false
}

/**
 * 收墩落点：桌面（本墩四家出牌区的并集）中心，朝**赢家方向**推出一段。
 *
 * 为什么不用「赢家出牌区的中心」：本墩的第 4 张牌是在同一次 reduce 里出的，
 * `captureFx` 量的时候桌上还没有它，`prev.plays` 里就缺这一家。
 * 早先的兜底拿 `box + dir*0.35*boxSize` 去估那家的位置，实测会把西家估到
 * 桌面中央（因为 box 中心本身就偏了），于是牌正好压在自己的名字牌上。
 *
 * 只依赖「并集中心 + 座位方向」就没有这个问题：缺哪家的 rect 都不影响中心，
 * 方向是常量表，四个方向同一套公式 —— 天然对称。
 *
 * `off` 取「并集短边的 28%」与「2.2 个牌高」的较小值：前者保证大桌面上推得
 * 够远（不会停在中央信息条上），后者保证小窗口下不会一步跨进牌背区。
 */
function collectAnchor(prev: FxSnapshot, winner: number, w1: number): { x: number; y: number } {
  const all: RectLike[] = []
  for (const p of prev.plays.values()) all.push(...p.rects)
  const box = unionBox(all)
  const dir = SEAT_DIR[winner] ?? [0, 0]

  if (box === null) {
    // 兜底（正常收墩一定有牌）：视口中心朝赢家方向推一点
    const r = Math.min(window.innerWidth, window.innerHeight) * 0.12
    return { x: window.innerWidth / 2 + dir[0] * r, y: window.innerHeight / 2 + dir[1] * r }
  }

  const off = Math.min(Math.min(box.w, box.h) * COLLECT_OFFSET_RATIO, w1 * 1.4 * 2.2)
  // 推出去会压到 UI 就按 15% 一档往回退
  for (let f = 1; f >= 0; f -= 0.15) {
    const x = box.x + dir[0] * off * f
    const y = box.y + dir[1] * off * f
    if (!hitsKeepOut(x, y, w1)) return { x, y }
  }
  // 连并集中心都撞（极小窗口）：只能落在桌面正中
  return { x: box.x, y: box.y }
}

/** 幽灵牌动画的可选项 */
interface GhostOpts {
  /** 是否淡出（收墩用） */
  fade?: boolean
  /**
   * 从行程的百分之几开始淡出（0~1）。默认 0 = 全程线性淡。
   * 收墩给 0.28：前 28% 保持清晰（让人看清牌被「扫」起来），之后迅速消失。
   */
  fadeFrom?: number
  /** 抛物线抬升幅度 */
  arc?: number
  /** 起始旋转角度（度），随行程归零 */
  spin?: number
}

/**
 * 一张幽灵牌从 `from` 飞到 `to`。
 * 尺寸从出发牌插值到落点牌（手牌比出牌区大 ⇒ 有「甩出去变小」的感觉）。
 */
function flyGhost(card: Card, from: RectLike, to: RectLike, dur: number, opts: GhostOpts = {}): void {
  const w0 = Math.round(from.width > 0 ? from.width : to.width)
  if (w0 <= 0) return
  animateGhost(cardEl(card, { width: w0, cls: 'deal-fly__card' }), w0, from, to, dur, opts)
}

/** 幽灵动画核心（牌面 / 牌背共用）：从 from 飞到 to，尺寸从 w0 插值到落点宽度 */
function animateGhost(
  el: HTMLElement,
  w0: number,
  from: RectLike,
  to: RectLike,
  dur: number,
  opts: GhostOpts = {},
): void {
  const w1 = Math.round(to.width > 0 ? to.width : w0)
  if (w0 <= 0 || w1 <= 0) return

  const sx = from.left + from.width / 2
  const sy = from.top + from.height / 2
  const tx = to.left + to.width / 2
  const ty = to.top + to.height / 2

  el.style.left = `${sx - w0 / 2}px`
  el.style.top = `${sy - (w0 * 1.4) / 2}px`
  ensureLayer().appendChild(el)

  const arc = opts.arc ?? 16
  const spin = opts.spin ?? (opts.fade ? 10 : -6)
  const fadeFrom = opts.fadeFrom ?? 0
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
    const rot = spin * (1 - t)
    el.style.transform = `translate(${cx - sx}px, ${cy - sy}px) scale(${sc.toFixed(3)}) rotate(${rot.toFixed(2)}deg)`
    if (opts.fade) {
      // 用 raw（线性时间）而不是 t（easeOut）：easeOut 会让 t 很早就接近 1，
      // 淡出变成「刚起飞就没了」，看不清是往哪个方向收的。
      const k = raw <= fadeFrom ? 1 : Math.max(0, 1 - (raw - fadeFrom) / (1 - fadeFrom))
      el.style.opacity = k.toFixed(3)
    }
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

/**
 * 人类某张牌在手牌里的位置。
 *
 * 找不到那张牌时**不要退回 `southHand`**：那是整排手牌的包围盒（实测 1244 宽），
 * 拿它当起飞点会让幽灵牌以整排的宽度出现 —— 一个横跨屏幕的巨大牌影。
 * 退而求其次用「任意一张手牌」的尺寸，它才是"一张牌"的真实大小。
 */
function handRectOf(prev: FxSnapshot, id: number): RectLike | null {
  const hit = prev.hand.get(id)
  if (hit !== undefined) return hit
  const any = prev.hand.values().next()
  return any.done ? prev.southHand : any.value
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

  const prevPlays: PlayLike[] = [...prev.plays.entries()].map(([seat, p]) => ({
    seat: seat as 0 | 1 | 2 | 3,
    cards: p.cards,
  }))

  // ① 出牌飞行：本墩新出现的牌，从「人类手牌 / AI 牌背」飞到出牌区
  for (const np of newPlaysSince(prevPlays, s.trick.plays)) {
    const slot = np.seat === HUMAN_SEAT ? 'plays-mine' : `plays-${np.seat}`
    for (const card of np.cards) {
      const id = card.id
      const el = root.querySelector<HTMLElement>(
        `[data-slot="${slot}"] .plays__now .card[data-id="${id}"]`,
      )
      if (el === null) continue
      const to = el.getBoundingClientRect()
      if (to.width <= 0) continue
      const from =
        np.seat === HUMAN_SEAT ? handRectOf(prev, id) : (prev.seats.get(np.seat) ?? null)
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

  // ② 收墩归位：上一帧本墩有牌、这一帧刚结算 ⇒ 四家的牌朝赢家方向收拢并淡出
  if (justResolved(prev.histLen, prevPlays, s.history.length)) {
    const rec = s.history[s.history.length - 1]
    if (rec !== undefined && collecting < COLLECT_MAX_BATCH) {
      // 起飞点：四家已出的牌（桌上看得见的那些）
      const launches: { card: Card; from: RectLike }[] = []
      for (const { cards, rects } of prev.plays.values()) {
        cards.forEach((c, i) => {
          const r = rects[i]
          if (r !== undefined && r.width > 0) launches.push({ card: c, from: r })
        })
      }
      // 第 4 张牌：出牌与整墩结算发生在同一次 reduce 里，桌上从未出现过它。
      // 直接从「手牌 / 牌背」飞向收墩点，否则这一张会凭空消失。
      for (const p of rec.plays) {
        if (prev.plays.has(p.seat)) continue
        const from =
          p.seat === HUMAN_SEAT
            ? handRectOf(prev, p.cards[0]?.id ?? -1)
            : (prev.seats.get(p.seat) ?? null)
        if (from === null || from === undefined) continue
        for (const c of p.cards) launches.push({ card: c, from })
      }

      if (launches.length > 0) {
        // 收成一叠：以最小出发宽度为准，各张按自己的起点缩放
        let minW = Infinity
        for (const l of launches) if (l.from.width > 0) minW = Math.min(minW, l.from.width)
        const w1 = Math.max(12, Math.round((Number.isFinite(minW) ? minW : 40) * COLLECT_SHRINK))
        const anchor = collectAnchor(prev, rec.winner, w1)
        const to: RectLike = {
          left: anchor.x - w1 / 2,
          top: anchor.y - (w1 * 1.4) / 2,
          width: w1,
          height: w1 * 1.4,
        }
        const dur = animMs(COLLECT_MS)
        collecting++
        window.setTimeout(
          () => {
            collecting = Math.max(0, collecting - 1)
          },
          dur + COLLECT_STAGGER_MAX + 80,
        )

        launches.forEach((l, i) => {
          const delay = Math.min(COLLECT_STAGGER_MAX, i * COLLECT_STAGGER)
          // arc 只给 6px：出牌区正上方就是该家的 `.seat-tag`，抬得越高越容易
          // 从标签上擦过去。收墩要的是「贴桌扫走」而不是「抛起来」。
          const go = (): void =>
            flyGhost(l.card, l.from, to, dur, { fade: true, fadeFrom: 0.28, arc: 6, spin: 7 })
          if (delay === 0) go()
          else window.setTimeout(go, delay)
        })
      }
    }
  }

  // ③ 手牌重排
  flipHand(root, prev)
}

/**
 * AI 三家的牌背飞行（v1.3.15）。
 *
 * 每 tick 四家各得 1 张（见 `app/view.ts` 的 `dealtCardsAt`），所以三家各自长出一张。
 * 牌背没有 card id，用 `座位:序号` 作 key 记在 `flyingBacks` 里，`render` 按它先藏。
 * 张数被布局上限截断时（侧家最多 10 张）没有新牌背可飞，直接跳过。
 */
function flySeatBacks(root: HTMLElement, s: GameState, prevRevealed: number, deck: HTMLElement): void {
  const from = deck.getBoundingClientRect()
  if (from.width <= 0) return
  const dur = animMs(BACK_FLY_MS)

  for (const seat of [1, 2, 3] as Seat[]) {
    const backs = root.querySelectorAll<HTMLElement>(`[data-slot="back-${seat}"] .card`)
    const idx = newBackIndex(s, seat, prevRevealed, backs.length)
    if (idx < 0) continue
    const el = backs[idx]
    if (el === undefined) continue
    const to = el.getBoundingClientRect()
    if (to.width <= 0) continue

    const key = `${seat}:${idx}`
    flyingBacks.add(key)
    el.classList.add('card--incoming')
    const w = Math.round(to.width)
    animateGhost(backEl(1, { width: w, cls: 'deal-fly__card' }), w, from, to, dur, { arc: 20 })
    window.setTimeout(() => {
      flyingBacks.delete(key)
      const t = root.querySelector<HTMLElement>(
        `[data-slot="back-${seat}"] .card:nth-child(${idx + 1})`,
      )
      if (t !== null) t.classList.remove('card--incoming')
    }, dur)
  }
}
