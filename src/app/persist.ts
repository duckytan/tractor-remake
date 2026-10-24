/**
 * 存档：偏好设置 + 当前局进度
 * 规则依据：FR-17
 *
 * 版本不匹配或解析失败时一律降级为 null，绝不抛异常。
 */

import type { GameState } from './state'
import { STATE_VERSION } from './state'
import type { AnimSpeed, CardSize } from './state'
import { DEFAULT_RULE_CONFIG, HAND_SIZE } from '@core'
import type { Card } from '@core'
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
export const PREFS_VERSION = 2

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
  /** 提示即选中 */
  readonly hintSelects: boolean
}

const DEFAULT_PREFS: Prefs = {
  aiLevelPartner: 1,
  aiLevelOpponent: 1,
  aiSpeedMs: 420,
  fourColor: false,
  ruleConfig: DEFAULT_RULE_CONFIG,
  cardSize: 'M',
  animation: true,
  animSpeed: 'normal',
  showHistory: true,
  hintSelects: false,
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
    // v1.2.2 之前的存档没有 prefsVersion（读作 0）⇒ 视作旧档。
    // 用「小于」而不是「不等于」：将来升到 v3 时，v2 的存档不该被当成旧档再迁移一次。
    // 注意变量名不要叫 legacy —— 下面 `o.aiLevel` 那个「旧存档只有单档 AI 难度」的兜底
    // 已经占用了 `legacy` 这个名字。
    const version = typeof o.prefsVersion === 'number' ? o.prefsVersion : 0
    const isLegacyArchive = version < PREFS_VERSION
    const cardSize: CardSize = o.cardSize === 'S' || o.cardSize === 'L' ? o.cardSize : 'M'
    // 四档：0 弱 / 1 中 / 2 强 / 3 超强；非法值回落 1（别把「超强」降级成「普通」）
    const level = (v: unknown): AiLevel => (v === 0 || v === 2 || v === 3 ? v : 1)
    // 旧存档只有单档 aiLevel ⇒ 两侧都继承它
    const legacy = o.aiLevel
    return {
      aiLevelPartner: o.aiLevelPartner === undefined ? level(legacy) : level(o.aiLevelPartner),
      aiLevelOpponent: o.aiLevelOpponent === undefined ? level(legacy) : level(o.aiLevelOpponent),
      aiSpeedMs:
        typeof o.aiSpeedMs === 'number' && Number.isFinite(o.aiSpeedMs)
          ? Math.max(0, Math.min(5000, o.aiSpeedMs))
          : DEFAULT_PREFS.aiSpeedMs,
      fourColor: o.fourColor === true,
      ruleConfig: sanitizeConfig(o.ruleConfig, isLegacyArchive),
      cardSize,
      animation: o.animation !== false,
      // 动画速度：老档没有这个字段 ⇒ 中速
      animSpeed:
        o.animSpeed === 'slow' || o.animSpeed === 'fast'
          ? o.animSpeed
          : DEFAULT_PREFS.animSpeed,
      // 缺字段按默认：历史牌条默认开、提示即选中默认关
      showHistory: o.showHistory !== false,
      hintSelects: o.hintSelects === true,
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

export function loadState(): GameState | null {
  try {
    const raw = localStorage.getItem(KEY_STATE)
    if (!raw) return null
    const o = JSON.parse(raw) as GameState
    if (o.version !== STATE_VERSION) return null
    if (!Array.isArray(o.hands) || o.hands.length !== 4) return null
    // 定主阶段不恢复存档：declareOptions 依赖手牌重新计算，
    // 恢复后必然得到空清单 ⇒ 亮主按钮全灰，等于把玩家锁死在定主界面。
    // 定主只是开局的头几秒，重新发牌比恢复更划算。
    if (o.phase === 'contract') return null
    // hintIds 是纯视觉的瞬时状态，不跨会话恢复 ——
    // 否则刷新后会看到上一局残留的「提示」高亮。
    // 反主 / 亮主相关的几个字段同样做兜底（版本升级前的存档缺字段）。
    return {
      ...o,
      hintIds: [],
      trumpDeclarer: o.trumpDeclarer ?? null,
      usedTrumps: Array.isArray(o.usedTrumps) ? o.usedTrumps : [],
      counterPending: o.counterPending === true,
      counterOptions: Array.isArray(o.counterOptions) ? o.counterOptions : [],
      declareOptions: Array.isArray(o.declareOptions) ? o.declareOptions : [],
      // 发牌进度是瞬时状态：读档一律视为「已发完」。「已发完」= 人类手牌全长
      //（庄家 33 张、旁家 25 张 —— 底牌不单独分离，见 core/deal.ts），
      // 写死 25 会把庄家的最后 8 张切掉、埋底界面只显示 25 张。
      revealed: Array.isArray(o.hands[0])
        ? (o.hands[0] as readonly Card[]).length
        : HAND_SIZE,
      declarePrompted: true,
      dealPrompt: false,
      // 体验项由 Prefs 覆盖（见 main.ts），这里只做形状兜底
      showHistory: o.showHistory !== false,
      hintSelects: o.hintSelects === true,
    }
  } catch {
    return null
  }
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
