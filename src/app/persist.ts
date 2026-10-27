/**
 * 存档：偏好设置 + 当前局进度
 * 规则依据：FR-17
 *
 * 版本不匹配或解析失败时一律降级为 null，绝不抛异常。
 */

import type { GameState } from './state'
import { STATE_VERSION, ctxOf } from './state'
import type { AnimSpeed, CardSize } from './state'
import { isThemeKey } from '@audio/scenes'
import type { ThemeKey } from '@audio/scenes'
import {
  CARD_VALUE_COUNT,
  DEAL_TOTAL,
  DECK_SIZE,
  DEFAULT_RULE_CONFIG,
  SEAT_COUNT,
  analyze,
} from '@core'
import type { Card, LevelRank, Play, Seat, Trump } from '@core'
import type { RuleConfig } from '@core'
import type { AiLevel } from '@ai/policy'

const KEY_STATE = 'tractor.state.v1'
const KEY_PREFS = 'tractor.prefs.v1'

/**
 * 存档格式版本（只描述 `tractor.prefs.v1` 的内容，不是游戏版本号）。
 *
 * v1 → v2（v1.2.2）：`twoAsPermanent` 的默认值从 `false` 改成 `true`。
 * 旧存档里的 `false` **大概率只是旧默认值的镜像**（v1.2.1 及以前每次状态变更都会把
 * `pendingConfig` 整体写回，而它初值就是当时的默认值）。但**无法区分**它是不是玩家
 * 真的手动关过 —— 旧档没留任何「用户改过什么」的痕迹。故按「镜像」处理：
 * 这是可接受的一次性取舍（极少数手动关过的玩家，升级后会被重新打开一次，再关即可），
 * 但不要在文档里把它写成「一定是镜像」的事实。
 * 若不迁移，老玩家升级后会一直是 `mode 0`，看起来「默认值根本没改」。
 *
 * **为什么不直接换 `KEY_PREFS`（比如升成 `tractor.prefs.v2`）**：
 * 换 key 等于把玩家的全部设置（AI 档位、牌面尺寸、动画开关、其余 7 个规则开关）
 * 一次性清零，代价远大于收益。这里只需要「一次性迁移一个字段」，加个版本号就够。
 *
 * **为什么只迁移 `twoAsPermanent` 一个字段**：
 * 本轮只有它改了默认值。其余字段的默认值没动 ⇒ 存档里的值（不管是旧默认的镜像还是
 * 玩家真调过的）与当前默认值不冲突，照旧认存档都不会错。
 * 反过来，若对所有字段都「重置成默认」，就会把玩家显式调过的设置一起抹掉 —— 绝不能那样做。
 */
export const PREFS_VERSION = 3

export interface Prefs {
  /** 对家（座位 2，队友）强度 */
  readonly aiLevelPartner: AiLevel
  /** 敌家（座位 1/3）强度 */
  readonly aiLevelOpponent: AiLevel
  readonly aiSpeedMs: number
  readonly fourColor: boolean
  /** 规则开关（FR-18 ④：设置持久化） */
  readonly ruleConfig: RuleConfig
  /** 牌面尺寸档位 */
  readonly cardSize: CardSize
  /** 动画开关 */
  readonly animation: boolean
  /** 动画速度档位：慢 / 中 / 快 */
  readonly animSpeed: AnimSpeed
  /** 手牌前方历史牌条开关 */
  readonly showHistory: boolean
  /** 作弊：明牌显示其他三家手牌（纯展示，不改规则） */
  readonly showOppHands: boolean
  /** 提示即选中 */
  readonly hintSelects: boolean
  /** 记牌器 */
  readonly showCounter: boolean
  /** AI 是否读牌（关掉后 AI 只用公开信息推断，更公平但更弱） */
  readonly aiPeekHands: boolean
  /* ---------------- 声音 ---------------- */
  readonly musicTheme: ThemeKey
  readonly soundEnhanced: boolean
  readonly autoVariation: boolean
  readonly volumeMaster: number
  readonly volumeBgm: number
  readonly volumeSfx: number
}

const DEFAULT_PREFS: Prefs = {
  aiLevelPartner: 3,
  aiLevelOpponent: 3,
  aiSpeedMs: 420,
  fourColor: false,
  ruleConfig: DEFAULT_RULE_CONFIG,
  cardSize: 'M',
  animation: true,
  animSpeed: 'normal',
  showHistory: true,
  showOppHands: false,
  hintSelects: false,
  showCounter: false,
  aiPeekHands: true,
  musicTheme: 'spring',
  soundEnhanced: false,
  autoVariation: true,
  volumeMaster: 75,
  volumeBgm: 40,
  volumeSfx: 80,
}

/**
 * 逐字段校验，任何非法值都退回默认 —— 存档损坏不能让游戏起不来。
 *
 * @param o 存档里的 `ruleConfig` 原始值（类型未知，可能是任何东西）
 * @param legacy 是否为 v1.2.2 之前的旧档（无 `prefsVersion`）。为真时
 *   `twoAsPermanent` 改用**当前默认值**，其余字段一律照旧认存档。
 */
function sanitizeConfig(o: unknown, legacy: boolean): RuleConfig {
  if (!o || typeof o !== 'object') return DEFAULT_RULE_CONFIG
  const r = o as Record<string, unknown>
  const bool = (v: unknown, d: boolean): boolean => (typeof v === 'boolean' ? v : d)
  const d = DEFAULT_RULE_CONFIG
  return {
    allowSelfCounter: bool(r.allowSelfCounter, d.allowSelfCounter),
    // v1.2.2 把 twoAsPermanent 的默认值从 false 改成 true（对齐原版）。
    // 旧档里的 false 大概率只是旧默认值的镜像；无法区分它是不是玩家的显式选择，
    // 故按镜像处理（可接受的一次性取舍）⇒ 升级时改用新默认。
    // 新档（带 prefsVersion）则完全尊重存档值：玩家自己关掉的不能给他打开。
    twoAsPermanent: legacy ? d.twoAsPermanent : bool(r.twoAsPermanent, d.twoAsPermanent),
    allowPartnerGuard: bool(r.allowPartnerGuard, d.allowPartnerGuard),
    allowCounterNT: bool(r.allowCounterNT, d.allowCounterNT),
    guardScoreLevels: bool(r.guardScoreLevels, d.guardScoreLevels),
    guardJack: bool(r.guardJack, d.guardJack),
    guardAce: bool(r.guardAce, d.guardAce),
    guardKingLevel: bool(r.guardKingLevel, d.guardKingLevel),
  }
}

export function loadPrefs(): Prefs {
  try {
    const raw = localStorage.getItem(KEY_PREFS)
    if (!raw) return DEFAULT_PREFS
    const o = JSON.parse(raw) as Partial<Prefs> & {
      readonly aiLevel?: unknown
      readonly prefsVersion?: unknown
    }
    // 没有 prefsVersion（读作 0）= v1.2.2 之前的存档。
    //
    // **迁移必须按「版本区间」判断，不能用 `version < PREFS_VERSION`**：
    // 那样每升一次版本，所有历史迁移都会对旧档**重跑一遍** ——
    // 比如 v1.2.2 的 `twoAsPermanent` 迁移会把玩家显式关掉的开关又打开。
    // 所以每个迁移各自记一个门槛版本。
    const version = typeof o.prefsVersion === 'number' ? o.prefsVersion : 0
    /** v1.2.2 迁移：`twoAsPermanent` 默认值 false → true */
    const legacyRuleConfig = version < 2
    /** v1.3.29 迁移：AI 档位默认「中」→「超强」 */
    const legacyAiLevel = version < 3
    const cardSize: CardSize = o.cardSize === 'S' || o.cardSize === 'L' ? o.cardSize : 'M'
    // 四档：0 弱 / 1 中 / 2 强 / 3 超强；非法值回落 1（别把「超强」降级成「普通」）
    // 非法/缺失值回落到**当前默认档**（不是硬编码 1 —— 默认改过一次，
    // 硬编码会让「字段缺失」永远回到旧默认，与 `DEFAULT_PREFS` 悄悄分叉）。
    const level = (v: unknown, d: AiLevel = DEFAULT_PREFS.aiLevelOpponent): AiLevel =>
      v === 0 || v === 1 || v === 2 || v === 3 ? v : d
    /**
     * v1.3.29 的档位迁移：把「中」抬到「超强」。
     *
     * 为什么敢这么做：档位 1 既可能是玩家显式选的，也可能只是**旧默认值**的镜像，
     * 存档里没有留「改过什么」的痕迹 —— 与 v1.2.2 的 `twoAsPermanent` 是同一类取舍。
     * 这里按「旧默认」处理，因为默认值已经从「中」改成「超强」，
     * 不迁移的话老玩家会一直停在「中」档，永远碰不到新做的 AI 能力
     * （残局搜索、甩牌、L3 精确判定全都只在「超强」档生效）。
     * 想调回去只要在设置里点一下。
     */
    const migrateLevel = (v: AiLevel): AiLevel => (legacyAiLevel && v === 1 ? 3 : v)
    // 旧存档只有单档 aiLevel ⇒ 两侧都继承它
    const legacyAi = o.aiLevel
    /** 音量：0..100 整数，非法值回落默认 */
    const vol = (v: unknown, d: number): number =>
      typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.min(100, Math.round(v))) : d
    return {
      aiLevelPartner: migrateLevel(
        o.aiLevelPartner === undefined ? level(legacyAi) : level(o.aiLevelPartner),
      ),
      aiLevelOpponent: migrateLevel(
        o.aiLevelOpponent === undefined ? level(legacyAi) : level(o.aiLevelOpponent),
      ),
      aiSpeedMs:
        typeof o.aiSpeedMs === 'number' && Number.isFinite(o.aiSpeedMs)
          ? Math.max(0, Math.min(5000, o.aiSpeedMs))
          : DEFAULT_PREFS.aiSpeedMs,
      fourColor: o.fourColor === true,
      ruleConfig: sanitizeConfig(o.ruleConfig, legacyRuleConfig),
      cardSize,
      animation: o.animation !== false,
      // 动画速度：老档没有这个字段 ⇒ 中速
      animSpeed:
        o.animSpeed === 'slow' || o.animSpeed === 'fast'
          ? o.animSpeed
          : DEFAULT_PREFS.animSpeed,
      // 缺字段按默认：历史牌条默认开、提示即选中默认关
      showHistory: o.showHistory !== false,
      // 作弊开关默认关：老存档没有这个字段 ⇒ 不能突然把三家手牌摊开
      showOppHands: o.showOppHands === true,
      hintSelects: o.hintSelects === true,
      showCounter: o.showCounter === true,
      // 缺字段按「读牌」处理：旧存档没有这个字段，默认行为不能变
      aiPeekHands: o.aiPeekHands !== false,
      // 声音：主题非法值回落默认（春），音量夹到 0..100
      musicTheme: isThemeKey(o.musicTheme) ? o.musicTheme : DEFAULT_PREFS.musicTheme,
      soundEnhanced: o.soundEnhanced === true,
      autoVariation: o.autoVariation !== false,
      volumeMaster: vol(o.volumeMaster, DEFAULT_PREFS.volumeMaster),
      volumeBgm: vol(o.volumeBgm, DEFAULT_PREFS.volumeBgm),
      volumeSfx: vol(o.volumeSfx, DEFAULT_PREFS.volumeSfx),
    }
  } catch {
    return DEFAULT_PREFS
  }
}

export function savePrefs(p: Prefs): void {
  try {
    // 写入时打上存档版本号，下次 loadPrefs 就知道「这份存档已经迁移过了」。
    // 注意：调用方（main.ts）不需要知道这个字段，版本号是纯粹的存储细节。
    localStorage.setItem(KEY_PREFS, JSON.stringify({ ...p, prefsVersion: PREFS_VERSION }))
  } catch {
    /* 隐私模式下可能不可写，忽略 */
  }
}

/* ============================================================
   对局存档的字段级校验
   ------------------------------------------------------------
   历史教训（docs/33 C4-01、docs/38 G-1/G-3）：
   旧实现只校验 3 个条件（version / hands 是 4 元数组 / phase !== 'contract'），
   剩下 40 多个字段全部裸奔。后果是「能 JSON.parse 但字段不全或类型错」的存档
   会被原样放行，然后在**渲染路径上**炸掉（白屏），或者更糟 ——
   数字字段被塞成 HTML 字符串，拼进 `innerHTML` 后**执行脚本**。

   所以这里改成「**声明式字段校验 + 不合法整份丢弃**」：
   - 任何一项不过 ⇒ 返回 null，回落 `newGame()`，绝不让半坏的状态进运行时；
   - 数字字段一律要求 `Number.isFinite`，顺带堵住 `NaN` / `Infinity` 污染；
   - 牌值 / 牌 id 必须在合法区间内（`0..53` / `0..107`），且**同 id 不得重复**；
   - `Play.analysis` 是**派生数据**，不信存档，重新算（见 `rebuildPlayAnalysis`）。
   ============================================================ */

/** 加载失败的原因。给玩家一句人话提示，而不是静默重开。 */
export type LoadIssue =
  /** 没有存档 */
  | null
  /** 存档格式版本不匹配（旧版本 / 未来版本） */
  | 'version'
  /** 存档内容不合法（字段缺失 / 类型错误 / 值越界 / 重复牌） */
  | 'corrupt'
  /** 定主阶段的存档不恢复（见 `loadStateDetailed` 里的说明） */
  | 'contract-phase'

export interface LoadResult {
  readonly state: GameState | null
  readonly issue: LoadIssue
}

const PHASES: readonly string[] = ['contract', 'bury', 'play', 'settle', 'over']

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const isInt = (v: unknown): v is number => isNum(v) && Number.isInteger(v)
const isBool = (v: unknown): v is boolean => typeof v === 'boolean'
const isSeat = (v: unknown): v is Seat => v === 0 || v === 1 || v === 2 || v === 3
const isSeatOrNull = (v: unknown): v is Seat | null => v === null || isSeat(v)
const isTrump = (v: unknown): v is Trump => v === 0 || v === 1 || v === 2 || v === 3 || v === 'NT'
/** `LevelRank` 只有 1..13 与 18（打王级）—— **没有 14~17** */
const isLevelRank = (v: unknown): v is LevelRank => isInt(v) && ((v >= 1 && v <= 13) || v === 18)

const isCard = (v: unknown): v is Card =>
  isObj(v) &&
  isInt(v.id) &&
  v.id >= 0 &&
  v.id < DECK_SIZE &&
  isInt(v.value) &&
  v.value >= 0 &&
  v.value < CARD_VALUE_COUNT

/** 一组牌：必须是数组、每张合法、且**同 id 不重复**（重复牌会让合法性判定失真） */
function isCardArray(v: unknown): v is Card[] {
  if (!Array.isArray(v)) return false
  const seen = new Set<number>()
  for (const c of v) {
    if (!isCard(c)) return false
    if (seen.has(c.id)) return false
    seen.add(c.id)
  }
  return true
}

const isTrumpArray = (v: unknown): v is Trump[] => Array.isArray(v) && v.every(isTrump)

/** `{ seat, cards }` 形状（出牌 / 历史墩里的每一项） */
const isPlayLike = (v: unknown): v is { seat: Seat; cards: Card[] } =>
  isObj(v) && isSeat(v.seat) && isCardArray(v.cards)

function isTrickRecord(v: unknown): boolean {
  if (!isObj(v)) return false
  if (!isSeat(v.leader) || !isSeat(v.winner)) return false
  if (!isNum(v.score)) return false
  if (!Array.isArray(v.plays) || v.plays.length > SEAT_COUNT) return false
  return v.plays.every(isPlayLike)
}

/**
 * `Play.analysis` 是**派生数据**：它完全由 `cards` + `RuleContext` 决定。
 *
 * 存档里存着它只是为了序列化方便。读档时若原样信任，一份被篡改的 analysis
 * 就能绕过全部牌型校验（例如把散对说成拖拉机）。所以一律**重算**。
 */
function rebuildPlayAnalysis(
  plays: readonly { readonly seat: Seat; readonly cards: readonly Card[] }[],
  state: GameState,
): Play[] {
  if (plays.length === 0) return []
  const ctx = ctxOf(state)
  return plays.map((p) => ({ seat: p.seat, cards: p.cards, analysis: analyze(p.cards, ctx) }))
}

/**
 * 读存档并做完整校验。返回「状态 + 失败原因」，调用方可以据此给玩家提示。
 *
 * 为什么单独开一个 `loadStateDetailed` 而不是改 `loadState` 的返回值：
 * `loadState()` 被 12 处测试断言直接依赖（`expect(loadState()).toBeNull()`），
 * 改签名会把它们全部打断，而它们要验的东西（「坏档不崩」）和这里完全一致。
 * 所以保留旧签名作为薄封装，新逻辑放这里。
 */
export function loadStateDetailed(): LoadResult {
  let raw: string | null = null
  try {
    raw = localStorage.getItem(KEY_STATE)
  } catch {
    return { state: null, issue: null }
  }
  if (!raw) return { state: null, issue: null }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { state: null, issue: 'corrupt' }
  }
  if (!isObj(parsed)) return { state: null, issue: 'corrupt' }
  const o = parsed

  // ---- 版本闸：旧档 / 未来档都不做迁移，直接丢弃（并在 UI 上说明）----
  if (o.version !== STATE_VERSION) return { state: null, issue: 'version' }

  // ---- 阶段闸：定主阶段不恢复（declareOptions 依赖手牌重算，恢复后必然为空）----
  if (typeof o.phase !== 'string' || !PHASES.includes(o.phase)) {
    return { state: null, issue: 'corrupt' }
  }
  if (o.phase === 'contract') return { state: null, issue: 'contract-phase' }

  // ---- 规则字段（不合法就整份丢弃，不做「猜一个」）----
  if (!isObj(o.levels) || !isLevelRank(o.levels.a) || !isLevelRank(o.levels.b)) {
    return { state: null, issue: 'corrupt' }
  }
  if (!isSeat(o.dealer) || !isTrump(o.trump) || !isLevelRank(o.levelRank)) {
    return { state: null, issue: 'corrupt' }
  }
  if (!isBool(o.forcedNT)) return { state: null, issue: 'corrupt' }
  if (!isObj(o.config) || !isObj(o.pendingConfig)) return { state: null, issue: 'corrupt' }

  if (!isInt(o.seed) || !isInt(o.step) || !isInt(o.round) || o.round < 1) {
    return { state: null, issue: 'corrupt' }
  }
  if (!isInt(o.tricksDone) || o.tricksDone < 0) return { state: null, issue: 'corrupt' }
  if (!isInt(o.defenderScore) || o.defenderScore < 0) return { state: null, issue: 'corrupt' }
  if (!isInt(o.bottomScore) || o.bottomScore < 0) return { state: null, issue: 'corrupt' }
  if (!isInt(o.revealed) || o.revealed < 0 || o.revealed > DEAL_TOTAL) {
    return { state: null, issue: 'corrupt' }
  }
  if (!isInt(o.trumpCount) || o.trumpCount < 0 || o.trumpCount > 2) {
    return { state: null, issue: 'corrupt' }
  }
  if (!isSeatOrNull(o.trumpDeclarer) || !isSeatOrNull(o.guardBy)) {
    return { state: null, issue: 'corrupt' }
  }
  if (!isTrumpArray(o.askedTrumps) || !isTrumpArray(o.usedTrumps)) {
    return { state: null, issue: 'corrupt' }
  }
  if (!isTrumpArray(o.counterOptions) || !isTrumpArray(o.declareOptions)) {
    return { state: null, issue: 'corrupt' }
  }

  // ---- 牌：四家手牌 + 底牌 + 历史墩 + 当前墩 ----
  if (!Array.isArray(o.hands) || o.hands.length !== SEAT_COUNT) {
    return { state: null, issue: 'corrupt' }
  }
  if (!o.hands.every(isCardArray)) return { state: null, issue: 'corrupt' }
  if (!isCardArray(o.bottom)) return { state: null, issue: 'corrupt' }
  if (!Array.isArray(o.history) || !o.history.every(isTrickRecord)) {
    return { state: null, issue: 'corrupt' }
  }
  if (!isObj(o.trick) || !isSeat(o.trick.leader) || !isSeatOrNull(o.trick.winner)) {
    return { state: null, issue: 'corrupt' }
  }
  if (!Array.isArray(o.trick.plays) || o.trick.plays.length > SEAT_COUNT) {
    return { state: null, issue: 'corrupt' }
  }
  if (!o.trick.plays.every(isPlayLike)) return { state: null, issue: 'corrupt' }

  if (!isIntArray(o.selected) || !isIntArray(o.hintIds)) {
    return { state: null, issue: 'corrupt' }
  }

  const hands = o.hands as Card[][]
  const trickPlays = o.trick.plays as { seat: Seat; cards: Card[] }[]

  // ---- 108 张守恒（docs/33 C6-02）----
  //
  // 任意时刻「四家手牌 + 底牌 + 历史墩已出 + 当前墩已出」必须正好 108 张。
  // 少一张的存档会让一墩永远凑不满 4 手 —— 实测打 800 步也不结算，玩家看到的是「卡住」。
  // 这条同时兜住「多牌」与「重复牌跨数组」两种畸形。
  const totalCards =
    hands.reduce((n, h) => n + h.length, 0) +
    (o.bottom as Card[]).length +
    (o.history as GameState['history']).reduce(
      (n, r) => n + r.plays.reduce((m, p) => m + p.cards.length, 0),
      0,
    ) +
    trickPlays.reduce((n, p) => n + p.cards.length, 0)
  if (totalCards !== DECK_SIZE) return { state: null, issue: 'corrupt' }

  // ---- 组合成完整状态。能走到这里的字段已全部校验过，剩下的是「软字段」----
  const base: GameState = {
    ...(o as unknown as GameState),
    // 手牌数组用校验过的副本，避免外部引用被后续修改
    hands: hands.map((h) => h.slice()),
    bottom: (o.bottom as Card[]).slice(),
    trick: {
      leader: o.trick.leader,
      plays: [],
      winner: o.trick.winner,
    },
    history: o.history as GameState['history'],
    selected: (o.selected as number[]).slice(),
    hintIds: [],
    // 派生数据重算（不信任存档）
    lastReject: null,
    // 瞬时 UI 状态一律复位
    confirmNew: false,
    settingsOpen: false,
    logOpen: false,
    replayAt: null,
    dealPrompt: false,
    declarePrompted: true,
    counterPending: false,
    counterOptions: [],
    declareOptions: [],
    guardOption: false,
    // 发牌进度是瞬时状态：读档一律视为「已发完」= 人类手牌全长
    //（庄家 33 张、旁家 25 张 —— 底牌不单独分离，见 core/deal.ts），
    // 写死 25 会把庄家的最后 8 张切掉、埋底界面只显示 25 张。
    revealed: hands[0]!.length,
    // 体验项由 Prefs 覆盖（见 main.ts），这里只做形状兜底
    showHistory: o.showHistory !== false,
    showOppHands: o.showOppHands === true,
    hintSelects: o.hintSelects === true,
    showCounter: o.showCounter === true,
    animation: o.animation !== false,
  }

  // 当前墩的出牌要带 analysis（渲染 / 结算都要用），用校验过的牌重算
  const withPlays: GameState = {
    ...base,
    trick: { ...base.trick, plays: rebuildPlayAnalysis(trickPlays, base) },
  }
  return { state: withPlays, issue: null }
}

/** 整数数组（`selected` / `hintIds`）：元素必须是有限整数 */
function isIntArray(v: unknown): v is number[] {
  return Array.isArray(v) && v.every((x) => isInt(x) && x >= 0 && x < DECK_SIZE)
}

/**
 * 读存档（薄封装，保持旧签名）。
 *
 * 只关心「能不能恢复」，不关心失败原因 —— 需要提示玩家时用 `loadStateDetailed()`。
 */
export function loadState(): GameState | null {
  return loadStateDetailed().state
}

export function saveState(s: GameState): void {
  try {
    localStorage.setItem(KEY_STATE, JSON.stringify(s))
  } catch {
    /* 忽略 */
  }
}

export function clearState(): void {
  try {
    localStorage.removeItem(KEY_STATE)
  } catch {
    /* 忽略 */
  }
}
