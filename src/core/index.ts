/**
 * 规则引擎对外唯一出口
 *
 * 外部只能从 '@core' 导入，不要深挖 '@core/cards' 这类内部路径
 * （见 docs/07-编码规范.md §2）。
 */

export * from './types'
export * from './cards'
export * from './rng'
export * from './deal'
export * from './analyze'
export * from './legality'
export * from './trick'
export * from './score'
export * from './settle'
