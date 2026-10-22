/**
 * 存档：偏好设置 + 当前局进度
 * 规则依据：FR-17
 *
 * 版本不匹配或解析失败时一律降级为 null，绝不抛异常。
 */

import type { GameState } from './state'
import { STATE_VERSION } from './state'
import type { CardSize } from './state'
import { DEFAULT_RULE_CONFIG } from '@core'
import type { RuleConfig } from '@core'

const KEY_STATE = 'tractor.state.v1'
const KEY_PREFS = 'tractor.prefs.v1'

export interface Prefs {
  readonly aiLevel: 0 | 1 | 2
  readonly aiSpeedMs: number
  readonly fourColor: boolean
  /** 规则开关（FR-18 ④：设置持久化） */
  readonly ruleConfig: RuleConfig
  /** 牌面尺寸档位 */
  readonly cardSize: CardSize
  /** 动画开关 */
  readonly animation: boolean
}

const DEFAULT_PREFS: Prefs = {
  aiLevel: 1,
  aiSpeedMs: 420,
  fourColor: false,
  ruleConfig: DEFAULT_RULE_CONFIG,
  cardSize: 'M',
  animation: true,
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
    guardJA: bool(r.guardJA, d.guardJA),
    guardKingLevel: bool(r.guardKingLevel, d.guardKingLevel),
  }
}

export function loadPrefs(): Prefs {
  try {
    const raw = localStorage.getItem(KEY_PREFS)
    if (!raw) return DEFAULT_PREFS
    const o = JSON.parse(raw) as Partial<Prefs>
    const cardSize: CardSize = o.cardSize === 'S' || o.cardSize === 'L' ? o.cardSize : 'M'
    return {
      aiLevel: o.aiLevel === 0 || o.aiLevel === 2 ? o.aiLevel : 1,
      aiSpeedMs:
        typeof o.aiSpeedMs === 'number' && Number.isFinite(o.aiSpeedMs)
          ? Math.max(0, Math.min(5000, o.aiSpeedMs))
          : DEFAULT_PREFS.aiSpeedMs,
      fourColor: o.fourColor === true,
      ruleConfig: sanitizeConfig(o.ruleConfig),
      cardSize,
      animation: o.animation !== false,
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
    // hintIds 是纯视觉的瞬时状态，不跨会话恢复 ——
    // 否则刷新后会看到上一局残留的「提示」高亮。
    return { ...o, hintIds: [] }
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
