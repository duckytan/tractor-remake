/**
 * 游戏状态与动作定义
 *
 * 状态必须可 JSON 序列化：不存 PowerTable、不存函数、不存 Map/Set。
 * 牌力表由 (trump, levelRank, forcedNT, config) 现算 —— 见 ctxOf()。
 */

import type { AiLevel } from '@ai/policy'
import type { ThemeKey } from '@audio/scenes'
import type {
  Card,
  LevelRank,
  Play,
  PlayRejectReason,
  RuleConfig,
  RuleContext,
  Seat,
  SettleResult,
  Trump,
} from '@core'
import { DEFAULT_RULE_CONFIG, DEAL_TOTAL, buildPowerTable } from '@core'

/** 状态结构版本。改动 GameState 形状时 +1，旧存档自动作废 */
/**
 * 存档格式版本（游戏局内状态，与 prefs 的 PREFS_VERSION 是两套）。
 *
 * v2 → v3（v1.3.3）：发牌结构改变 —— 底牌不再在发牌时单独分离，
 * 庄家直接拿 33 张（四家各 25 + 庄家多拿 8）。旧存档的 `hands`/`bottom`
 * 形状与新代码不兼容（旧档庄家 25 张 + bottom 8 张），一律拒绝读档、开新局。
 */
export const STATE_VERSION = 3
export const HUMAN_SEAT: Seat = 0

export type Phase = 'contract' | 'bury' | 'play' | 'settle' | 'over'

/** 牌面尺寸档位（FR-18） */
export type CardSize = 'S' | 'M' | 'L'

/**
 * 动画速度档位。
 *
 * 所有卡牌动画（发牌飞行、出牌飞行、收墩归位、手牌重排）的时长都乘以
 * `ANIM_SPEED_SCALE[speed]`，见 `ui/dealFly.ts`。
 * 只影响「观感」，不改变任何规则时序（AI 速度是另一个设置项 `aiSpeedMs`）。
 */
export type AnimSpeed = 'slow' | 'normal' | 'fast'

/** 动画速度倍率：慢 1.6× / 中 1× / 快 0.6× */
export const ANIM_SPEED_SCALE: Record<AnimSpeed, number> = {
  slow: 1.6,
  normal: 1,
  fast: 0.6,
}

/** 牌面像素宽度 → CSS 变量 --card-w */
export const CARD_SIZE_PX: Record<CardSize, number> = { S: 120, M: 150, L: 190 }

export interface TrickRecord {
  readonly leader: Seat
  readonly plays: readonly { readonly seat: Seat; readonly cards: readonly Card[] }[]
  readonly winner: Seat
  readonly score: number
}

export interface GameState {
  readonly version: number
  readonly phase: Phase
  readonly config: RuleConfig
  readonly seed: number
  readonly step: number
  readonly round: number
  /** 队 0（座位 0/2）与队 1（座位 1/3）的级牌 */
  readonly levels: { readonly a: LevelRank; readonly b: LevelRank }
  readonly dealer: Seat
  readonly trump: Trump
  readonly forcedNT: boolean
  /** 当前定主人（首次亮主或最后一次反主的人）；null = 还没人亮主 */
  readonly trumpDeclarer: Seat | null
  /**
   * 当前定主已投入的级牌张数：0 = 还没人亮主，1 = 单张亮主，2 = 反主 / 加固。
   *
   * 2 副牌每门级牌只有 2 张 ⇒ 门槛 `counterNeed(2) = 3` **永远不可达**，
   * 所以实际只有两级（1 → 2 → 锁死），UI 不许出现「第三级」这种表述。
   */
  readonly trumpCount: number
  /** 加固者（把 trumpCount 从 1 抬到 2 的队友）；null = 没加固 */
  readonly guardBy: Seat | null
  /** 已经问过人类的亮主花色（同一门不重复打断） */
  readonly askedTrumps: readonly Trump[]
  /** 本局已用过的定主（含首次亮主）。反主不得重复用同一门，保证流程终止 */
  readonly usedTrumps: readonly Trump[]
  /** 是否正等人类反主（此时人类还持有别门花色的级牌） */
  readonly counterPending: boolean
  /** 人类当前可以反成的主（空数组 = 无反主选项）。UI 只按这份清单置灰按钮 */
  readonly counterOptions: readonly Trump[]
  /** 人类首次亮主可选的主（空 = 不可选）。UI 只按这份清单置灰按钮 */
  readonly declareOptions: readonly Trump[]
  /**
   * 人类当前能否「加固」（把定主张数从 1 抬到 2）。
   *
   * 规则判定在 app 层（`canGuard`），UI 只看这个布尔量，不许自己推。
   */
  readonly guardOption: boolean
  /**
   * 发牌进度（0..`DEAL_TOTAL`，**全局轮次口径**，与人类是不是庄家无关）。
   * 前 25 轮每家各得 1 张，第 26..33 轮只有庄家得 1 张。
   * `hands` 里始终是完整手牌（庄家 33 张、旁家 25 张），UI 与亮主校验
   * 按「已揭示前缀」消费它；牌堆计数走 `dealtCount`（见 core/deal.ts）。
   */
  readonly revealed: number
  /** 中途暂停提示是否已触发过（人类第一次摸到级牌时置 true，只触发一次） */
  readonly declarePrompted: boolean
  /** 是否正暂停等人类决定「亮主 / 继续发牌」 */
  readonly dealPrompt: boolean
  /** 本局打的级别（= 庄家队的级牌） */
  readonly levelRank: LevelRank
  /** 四家手牌。埋底前庄家 33 张，埋底后都是 25 张 */
  readonly hands: readonly (readonly Card[])[]
  /** 底牌 8 张 */
  readonly bottom: readonly Card[]
  readonly bottomScore: number
  readonly trick: {
    readonly leader: Seat
    readonly plays: readonly Play[]
    /**
     * @deprecated **不要拿它做高亮**。它不是「本墩当前最大」，也不是「本墩赢家」。
     *
     * 实际行为（v1.3.29 复核后更正，旧注释写「从没被赋过值」是**错的**）：
     *   - 出牌途中：保持**上一墩**的赢家（`game.ts` 结算时把 `winner` 留在 trick 上
     *     传给下一墩），所以它是个**过期值** —— 比 `null` 更危险；
     *   - 本墩结算：由 `resolveTrick` 算出后写进 `history`，不是写这里。
     *
     * v1.3.24 之前座位标签的 `.is-win` 就是读了这个过期字段，所以一直亮错人。
     * 要「当前谁最大」请用 `app/view.ts` 的 `leadingSeat()`（内部走 `trickStanding`）。
     */
    readonly winner: Seat | null
  }
  readonly tricksDone: number
  readonly defenderScore: number
  readonly history: readonly TrickRecord[]
  /** 已选中但未出的牌 id */
  readonly selected: readonly number[]
  readonly lastReject: { readonly reason: PlayRejectReason; readonly detail: string } | null
  readonly notice: string | null
  readonly lastSettle: SettleResult | null
  /** 对家（座位 2 = 队友）的 AI 强度 */
  readonly aiLevelPartner: AiLevel
  /** 敌家（座位 1/3 = 对手）的 AI 强度 */
  readonly aiLevelOpponent: AiLevel
  readonly aiSpeedMs: number
  readonly fourColor: boolean
  /** 牌面尺寸档位 */
  readonly cardSize: CardSize
  /** 动画开关（关闭后 CSS 过渡全部禁用） */
  readonly animation: boolean
  /** 动画速度档位：慢 / 中 / 快（影响发牌、出牌、收墩、手牌重排的全部时长） */
  readonly animSpeed: AnimSpeed
  /**
   * 「重新开局」二次确认弹层是否打开。
   *
   * 出牌 / 埋底阶段点顶栏「新游戏」会先问一次 —— 那个按钮紧挨着「设置 / 记录」，
   * 误点一次就把整局进度清掉（含存档），代价太大。
   * 定主阶段（还没开打）不拦，直接重开。
   */
  readonly confirmNew: boolean
  /**
   * 记牌器开关（v1.3.14）：牌桌上方显示「未出的王 / 级牌 / 主牌 / 已出分」。
   *
   * **默认关**：记牌器是辅助工具，有人视为作弊（记牌本来是牌技的一部分），
   * 所以做成显式开关而不是默认开。
   */
  readonly showCounter: boolean
  /**
   * AI 是否「读牌」（直接看对手手牌）。
   *
   * **默认 true**，因为实测关掉它会让 L3 明显变弱：
   *   概率推断 vs 明牌偷看 = L2 49.3%（持平）/ L3 **27.0%**（大幅下降）
   *   （300 副 × 2 座位互换配对，`.tmp/measure-belief.ts`）
   *
   * 想玩得更公平就关掉 —— AI 只用「我的手牌 + 已出的牌 + 每家张数」推断
   * （`src/ai/belief.ts`），但强度会掉一档。详见 docs/15 KN-10。
   */
  readonly aiPeekHands: boolean
  /**
   * 逐墩回放：正在回放第几墩（`history` 的下标），null = 正常对局。
   *
   * 回放期间 AI 停手（`aiCanAct` 返回 false）、人类手牌不可点、
   * 出牌区显示的是**那一墩的历史出牌**而不是当前墩。
   * 瞬时状态，不进存档（`loadState` 一律置 null）。
   */
  readonly replayAt: number | null
  /** 手牌前方「最近几墩」历史牌条开关（体验项，立即生效） */
  readonly showHistory: boolean
  /**
   * 作弊：明牌显示其他三家的手牌。
   *
   * **纯展示项**，不改任何规则：只影响 `render` 里三家牌背画成牌背还是牌面。
   * 与 `aiPeekHands` 是两件独立的事 —— 那个控制 **AI 能不能看你**，
   * 这个控制 **你能不能看 AI**，互不影响（两个都开 = 双向明牌）。
   *
   * 默认关。排序走 `handView()`，与玩家手牌完全同一套规则
   *（主牌段 → 主花色 → 副牌花色，花色内降序，分组留间隔）。
   */
  readonly showOppHands: boolean
  /**
   * 提示即选中：开启后点「提示」会直接把提示的牌写进 `selected`。
   *
   * **默认 false**。开启时有两个已知副作用（属于预期行为，设置面板里已写明）：
   * ① 覆盖用户已选好的牌；② `selected` 会随存档一起持久化。
   */
  readonly hintSelects: boolean
  /**
   * 提示用哪套策略：
   * - `'safe'`（默认）= **稳妥人类风格**（`ai/safeHint.ts`）：不首出带分牌、能赢才抢、
   *   队友赢着就垫最小的。一眼能懂，强度低一档。
   * - `'ai'` = **最强 AI 的判断**（`choosePlay`，L3 + 残局搜索）：胜率更高，
   *   但会走「先跑小副牌、主牌留到最后控场」这类人类不会打的线路。
   *
   * 纯偏好，不影响规则与 AI 自己的出牌。
   */
  readonly hintStyle: HintStyle
  /**
   * 挂机模式：开启后**人类座位**的所有操作交给 AI（选牌 / 出牌 / 抢主 / 反主 / 扣底 / 下一局）。
   *
   * **作为偏好持久化**（不是瞬时状态）。原因：抢主发生在 `phase === 'contract'`，
   * 那一刻手牌操作条被定主面板整块盖住、点不到挂机按钮 —— 只有在出牌阶段打开挂机
   * 并让它跨局保留，下一局的抢主才可能自动进行。刷新后也保持，符合「挂机」的语义。
   */
  readonly autoPlay: boolean
  /**
   * 挂机时替人类出牌用哪一档 AI（弱 / 中 / 强 / 超强）。
   *
   * 与 `aiLevelPartner` / `aiLevelOpponent` 分开：那两档是「对手有多强」，
   * 这一档是「代打有多强」，玩家可能想「对手弱一点、我的代打强一点」。
   */
  readonly autoLevel: AiLevel
  /* ---------------- 声音（v1.4） ----------------
     全部是纯偏好，不参与任何规则判定。音频模块只读它们。 */

  /** 音乐主题：四季之一（默认春） */
  readonly musicTheme: ThemeKey
  /** 增强音效：BGM 改用 Tone.js 引擎（需要联网或本地 tone.min.js） */
  readonly soundEnhanced: boolean
  /** 根据剧情自动变奏：关掉就永远同一套编排、不转调 */
  readonly autoVariation: boolean
  /** 总音量 0..100 */
  readonly volumeMaster: number
  /** BGM 音量 0..100 */
  readonly volumeBgm: number
  /** 音效音量 0..100 */
  readonly volumeSfx: number

  /** 设置弹层是否打开 */
  readonly settingsOpen: boolean
  /** 对局记录弹层是否打开 */
  readonly logOpen: boolean
  /**
   * 提示高亮的牌 id。
   *
   * **纯视觉状态，不参与任何规则判定**（FR-19 ③：提示不改变游戏状态）。
   * 与 `selected` 分开：selected 是「我要出的牌」，hintIds 只是「看，这手能出」。
   * 任何会改变局面的动作都应顺手清掉它。
   */
  readonly hintIds: readonly number[]
  /**
   * 待生效的规则配置。
   * FR-18 ③：规则开关改动在下一局生效，当前局不生效。
   * 所以 UI 改的是这份 pending 值，startRound 时才合并进 config。
   */
  readonly pendingConfig: RuleConfig
}

export type Action =
  | { readonly type: 'newGame'; readonly seed?: number }
  | { readonly type: 'declareTrump'; readonly trump: Trump }
  | { readonly type: 'guard' }
  | { readonly type: 'revealTick' }
  | { readonly type: 'passDeal' }
  | { readonly type: 'passCounter' }
  | { readonly type: 'bury'; readonly ids: readonly number[] }
  | { readonly type: 'toggleSelect'; readonly id: number }
  | { readonly type: 'setSelection'; readonly ids: readonly number[] }
  | { readonly type: 'clearSelect' }
  | { readonly type: 'playSelected' }
  | { readonly type: 'aiStep' }
  | { readonly type: 'nextRound' }
  | { readonly type: 'updateConfig'; readonly patch: Partial<RuleConfig> }
  | { readonly type: 'setAiLevel'; readonly level: AiLevel }
  | { readonly type: 'setAiLevelSide'; readonly side: 'partner' | 'opponent'; readonly level: AiLevel }
  | { readonly type: 'setAiSpeed'; readonly ms: number }
  | { readonly type: 'toggleFourColor' }
  | { readonly type: 'dismissNotice' }
  | { readonly type: 'openSettings' }
  | { readonly type: 'closeSettings' }
  | { readonly type: 'setCardSize'; readonly size: CardSize }
  | { readonly type: 'setAnimSpeed'; readonly speed: AnimSpeed }
  | { readonly type: 'askNewGame' }
  | { readonly type: 'cancelNewGame' }
  | { readonly type: 'toggleAnimation' }
  | { readonly type: 'toggleShowHistory' }
  | { readonly type: 'toggleShowOppHands' }
  | { readonly type: 'toggleHintSelects' }
  | { readonly type: 'setHintStyle'; readonly style: HintStyle }
  | { readonly type: 'toggleAutoPlay' }
  | { readonly type: 'setAutoLevel'; readonly level: AiLevel }
  | { readonly type: 'autoStep' }
  | { readonly type: 'autoPlayTurn' }
  | { readonly type: 'toggleShowCounter' }
  | { readonly type: 'toggleAiPeek' }
  | { readonly type: 'setMusicTheme'; readonly theme: ThemeKey }
  | { readonly type: 'toggleSoundEnhanced' }
  | { readonly type: 'toggleAutoVariation' }
  | { readonly type: 'setVolume'; readonly which: 'master' | 'bgm' | 'sfx'; readonly value: number }
  | { readonly type: 'replayStart'; readonly index: number }
  | { readonly type: 'replayStep'; readonly delta: number }
  | { readonly type: 'replayExit' }
  | { readonly type: 'toggleLog' }
  | { readonly type: 'showHint'; readonly ids: readonly number[] }
  | { readonly type: 'hintSelect'; readonly ids: readonly number[] }
  | { readonly type: 'clearHint' }

/** 提示策略（见 `GameState.hintStyle`） */
export type HintStyle = 'safe' | 'ai'

/** 由状态推导规则上下文（牌力表现算） */
export function ctxOf(state: GameState): RuleContext {
  return {
    power: buildPowerTable({
      mode: state.config.twoAsPermanent ? 1 : 0,
      levelRank: state.levelRank,
      trump: state.trump,
      forcedNT: state.forcedNT,
    }),
    trump: state.trump,
    levelRank: state.levelRank,
    forcedNT: state.forcedNT,
    config: state.config,
  }
}

/** 该谁出牌 */
export function seatToPlay(state: GameState): Seat | null {
  if (state.phase !== 'play') return null
  const { plays, leader } = state.trick
  if (plays.length === 0) return leader
  const last = plays[plays.length - 1] as Play
  return ((last.seat + 1) % 4) as Seat
}

export const isHumanTurn = (state: GameState): boolean => seatToPlay(state) === HUMAN_SEAT

export const dealerTeam = (state: GameState): 0 | 1 => (state.dealer % 2) as 0 | 1

export const emptyState = (): GameState => ({
  version: STATE_VERSION,
  phase: 'contract',
  config: DEFAULT_RULE_CONFIG,
  seed: 1,
  step: 0,
  round: 1,
  levels: { a: 2, b: 2 },
  dealer: 0,
  trump: 'NT',
  forcedNT: false,
  trumpDeclarer: null,
  trumpCount: 0,
  guardBy: null,
  askedTrumps: [],
  usedTrumps: [],
  counterPending: false,
  counterOptions: [],
  declareOptions: [],
  guardOption: false,
  // 空状态：发牌进度视为已满（33 轮全部发完）
  revealed: DEAL_TOTAL,
  declarePrompted: true,
  dealPrompt: false,
  levelRank: 2,
  hands: [[], [], [], []],
  bottom: [],
  bottomScore: 0,
  trick: { leader: 0, plays: [], winner: null },
  tricksDone: 0,
  defenderScore: 0,
  history: [],
  selected: [],
  lastReject: null,
  notice: null,
  lastSettle: null,
  aiLevelPartner: 3,
  aiLevelOpponent: 3,
  aiSpeedMs: 420,
  fourColor: false,
  cardSize: 'M',
  animation: true,
  animSpeed: 'normal',
  confirmNew: false,
  showCounter: false,
  aiPeekHands: true,
  musicTheme: 'spring',
  soundEnhanced: false,
  autoVariation: true,
  volumeMaster: 75,
  volumeBgm: 40,
  volumeSfx: 80,
  replayAt: null,
  showHistory: true,
  showOppHands: false,
  hintSelects: false,
  hintStyle: 'safe',
  autoPlay: false,
  autoLevel: 3,
  settingsOpen: false,
  logOpen: false,
  hintIds: [],
  pendingConfig: DEFAULT_RULE_CONFIG,
})
