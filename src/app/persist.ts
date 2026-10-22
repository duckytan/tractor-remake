/**
 * 存档：偏好设置 + 当前局进度
 * 规则依据：FR-17
 *
 * 版本不匹配或解析失败时一律降级为 null，绝不抛异常。
 */

import type { GameState } from './state'
import { STATE_VERSION } from './state'

const KEY_STATE = 'tractor.state.v1'
const KEY_PREFS = 'tractor.prefs.v1'

export interface Prefs {
  readonly aiLevel: 0 | 1 | 2
  readonly aiSpeedMs: number
  readonly fourColor: boolean
}

const DEFAULT_PREFS: Prefs = { aiLevel: 1, aiSpeedMs: 420, fourColor: false }

export function loadPrefs(): Prefs {
  try {
    const raw = localStorage.getItem(KEY_PREFS)
    if (!raw) return DEFAULT_PREFS
    const o = JSON.parse(raw) as Partial<Prefs>
    return {
      aiLevel: o.aiLevel === 0 || o.aiLevel === 2 ? o.aiLevel : 1,
      aiSpeedMs: typeof o.aiSpeedMs === 'number' ? o.aiSpeedMs : DEFAULT_PREFS.aiSpeedMs,
      fourColor: o.fourColor === true,
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
    return o
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
