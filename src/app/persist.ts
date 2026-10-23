/**
 * 存档：偏好设置 + 当前局进度
 * 规则依据：FR-17
 *
 * 版本不匹配或解析失败时一律降级为 null，绝不抛异常。
 */

import type { GameState } from './state'
import { STATE_VERSION } from './state'
import type { CardSize } from './state'
import { DEFAULT_RULE_CONFIG, HAND_SIZE } from '@core'
import type { RuleConfig } from '@core'
import type { AiLevel } from '@ai/policy'

const KEY_STATE = 'tractor.state.v1'
const KEY_PREFS = 'tractor.prefs.v1'

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
  showHistory: true,
  hintSelects: false,
}

/** 逐字段校验，任何非法值都退回默认 —— 存档损坏不能让游戏起不来 */
function sanitizeConfig(o: unknown): RuleConfig {
  if (!o || typeof o !== 'object') return DEFAULT_RULE_CONFIG
  const r = o as Record<string, unknown>
  const bool = (v: unknown, d: boolean): boolean => (typeof v === 'boolean' ? v : d)
  const d = DEFAULT_RULE_CONFIG
  return {
    allowSelfCounter: bool(r.allowSelfCounter, d.allowSelfCounter),
    twoAsPermanent: bool(r.twoAsPermanent, d.twoAsPermanent),
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
    const o = JSON.parse(raw) as Partial<Prefs> & { readonly aiLevel?: unknown }
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
      ruleConfig: sanitizeConfig(o.ruleConfig),
      cardSize,
      animation: o.animation !== false,
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
    localStorage.setItem(KEY_PREFS, JSON.stringify(p))
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
      // 发牌进度是瞬时状态：读档一律视为「已发完」，避免卡在半副牌
      revealed: HAND_SIZE,
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
