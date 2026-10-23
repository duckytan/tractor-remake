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
import type { GameState } from '@app/state'
import { cardEl } from './card'

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
    const raw = Math.min(1, (now - t0) / FLY_MS)

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
  window.setTimeout(finish, FLY_MS + 400)
}
