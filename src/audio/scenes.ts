/**
 * 声音系统的**纯数据与纯函数**。
 *
 * 铁律：本文件不许出现 `AudioContext` / `window` / `document` —— 全部可单测。
 * 音高一律用 **MIDI 号**（60 = C4），拍位是「乐句内的绝对拍数」。
 *
 * 主题与情绪预设的来源：
 *  - 四季主题移植自 `design/engine-ab.html`（同一项目的设计稿）
 *  - 和弦表与伴奏网格同源
 *  - 情绪预设（MOODS）是参考实现里的 8 组场景参数
 */

import type { Seat } from '@core'

/* ============================================================
   0. 基础
   ============================================================ */

/** C 大调音阶（音效按音级取音时用） */
export const SCALE = [0, 2, 4, 5, 7, 9, 11, 12] as const

/** 主题键：春夏秋冬 */
export type ThemeKey = 'spring' | 'summer' | 'autumn' | 'winter'

/** 场景键：对应游戏 Phase 的真实分支（见 docs/18 §2.2） */
export type SceneKey = 'calm' | 'play' | 'settle' | 'overWin' | 'overLose' | 'replay'

/** 一个音符：[拍位, MIDI, 时值(拍)] */
export type Note = readonly [beat: number, midi: number, dur: number]

/* ============================================================
   1. 和弦
   ============================================================ */

/**
 * 和弦表。`p` = 从低到高排好的 6 个声部：
 *   0 低音(根音下八度) 1 根音 2 三音 3 五音 4 根音高八度 5 三音高八度
 * 四个和弦同一套结构，所以伴奏网格的纵轴可以按「音级」标，换和弦自动跟着走。
 * 进行是 C - F - Am - G（I–IV–vi–V），温暖不闹。
 */
export interface Chord {
  readonly name: string
  readonly p: readonly number[]
}

export const CHORDS: readonly Chord[] = [
  { name: 'C', p: [36, 48, 52, 55, 60, 64] },
  { name: 'F', p: [41, 53, 57, 60, 65, 69] },
  { name: 'Am', p: [45, 57, 60, 64, 69, 72] },
  { name: 'G', p: [43, 55, 59, 62, 67, 71] },
]

export const CHORD_NAMES: readonly string[] = CHORDS.map((c) => c.name)

/* ============================================================
   2. 四季主题
   ============================================================ */

export interface Theme {
  readonly key: ThemeKey
  readonly name: string
  readonly desc: string
  /** 主奏音色（见 voices.ts 的 INST_LABEL） */
  readonly inst: string
  /** 主题自身几小节一轮 */
  readonly loopBars: number
  readonly melody: readonly Note[]
}

export const THEMES: Record<ThemeKey, Theme> = {
  /* 春 · 萌动 —— 低音起跳（纯四度上）→ 三连级进上行 → 落长音。
     五声音阶，避半音，明亮不刺；第 2 小节 A5 是唯一高点。 */
  spring: {
    key: 'spring',
    name: '春 · 萌动',
    desc: '长笛 · 五声音阶 · 上行起句',
    inst: 'flute',
    loopBars: 8,
    melody: [
      [0, 67, 1], [1, 72, 0.5], [1.5, 74, 0.5], [2, 76, 0.5], [2.5, 79, 1.5],
      [4, 76, 1], [5, 79, 0.5], [5.5, 81, 0.5], [6, 79, 1], [7, 76, 0.5],
      [8, 76, 0.5], [8.5, 74, 0.5], [9, 72, 1], [10, 69, 1], [11, 72, 0.5], [11.5, 74, 0.5],
      [12, 76, 0.5], [12.5, 74, 0.5], [13, 76, 1], [14, 74, 2],
      [16, 67, 1], [17, 72, 1], [18, 74, 1], [19, 76, 1],
      [20, 79, 1], [21, 77, 1], [22, 76, 1], [23, 74, 1],
      [24, 69, 1], [25, 74, 0.5], [25.5, 76, 0.5], [26, 79, 0.5], [26.5, 76, 1.5],
      [28, 74, 0.5], [28.5, 76, 0.5], [29, 74, 1], [30, 71, 2],
    ],
  },

  /* 夏 · 灼日 —— 同音反复（蝉声）→ 冲刺上行 → 高音砸下。
     节奏最密、音区最高（C5–A5），只在第 5 小节放慢做「树荫下」的对比。 */
  summer: {
    key: 'summer',
    name: '夏 · 灼日',
    desc: '钢琴 + 吉他 · 密节奏 · 高音区',
    inst: 'pianoGuitar',
    loopBars: 8,
    melody: [
      [0, 76, 0.5], [0.5, 76, 0.5], [1, 79, 0.5], [1.5, 81, 0.5], [2, 79, 1], [3, 76, 0.5], [3.5, 79, 0.5],
      [4, 81, 1], [5, 79, 0.5], [5.5, 77, 0.5], [6, 76, 1], [7, 77, 1],
      [8, 72, 0.5], [8.5, 76, 1], [9.5, 72, 0.5], [10, 79, 1], [11, 76, 1],
      [12, 79, 0.5], [12.5, 77, 0.5], [13, 74, 0.5], [13.5, 71, 0.5], [14, 74, 1], [15, 76, 1],
      [16, 79, 1], [17, 81, 1], [18, 79, 2],
      [20, 77, 0.5], [20.5, 79, 0.5], [21, 81, 1], [22, 79, 0.5], [22.5, 77, 0.5], [23, 76, 1],
      [24, 72, 0.5], [24.5, 72, 0.5], [25, 76, 0.5], [25.5, 79, 0.5], [26, 76, 1], [27, 76, 0.5], [27.5, 79, 0.5],
      [28, 79, 0.5], [28.5, 77, 0.5], [29, 76, 0.5], [29.5, 71, 0.5], [30, 74, 2],
    ],
  },

  /* 秋 · 落叶 —— 三度下行「叹息」，前半句落下、后半句留白。
     音区最低（E4–E5），长音最多；以 A 为中心，天然带小调色彩，但仍在 C 大调音阶内。 */
  autumn: {
    key: 'autumn',
    name: '秋 · 落叶',
    desc: '钢琴 · 叹息动机 · 下行慢句',
    inst: 'piano',
    loopBars: 8,
    melody: [
      [0, 76, 1], [1, 74, 0.5], [1.5, 72, 1.5], [3, 69, 1],
      [4, 72, 1], [5, 77, 1.5], [6.5, 76, 0.5], [7, 74, 0.5],
      [8, 76, 1], [9, 74, 0.5], [9.5, 72, 1.5], [11, 69, 1],
      [12, 71, 2], [14, 74, 2],
      [16, 76, 2], [18, 79, 2],
      [20, 77, 1], [21, 76, 1], [22, 74, 1], [23, 72, 1],
      [24, 69, 1], [25, 67, 0.5], [25.5, 64, 1.5], [27, 72, 1],
      [28, 67, 1], [29, 71, 0.5], [29.5, 74, 0.5], [30, 71, 2],
    ],
  },

  /* 冬 · 静雪 —— 高音单点（雪落到钟上）→ 五度大跳下行 → 长空。
     音区最高（B4–C6），音符最少、空拍最多；长笛气声在低音量下最像呼气成雾。 */
  winter: {
    key: 'winter',
    name: '冬 · 静雪',
    desc: '长笛 + 钢琴 · 稀疏长音 · 高音区',
    inst: 'flutePiano',
    loopBars: 8,
    melody: [
      [0, 84, 1], [1, 79, 0.5], [1.5, 84, 0.5], [2, 76, 2],
      [4, 81, 1], [5, 77, 1], [6, 74, 1.5],
      [8, 81, 0.5], [8.5, 79, 0.5], [9, 76, 1.5], [10.5, 72, 1.5],
      [12, 74, 1], [13, 71, 1], [14, 74, 1.5],
      [16, 84, 2], [18, 79, 2],
      [20, 81, 1.5], [21.5, 79, 0.5], [22, 77, 1.5],
      [24, 81, 1], [25, 76, 0.5], [25.5, 81, 0.5], [26, 74, 2],
      [28, 72, 1], [29, 71, 1], [30, 74, 2],
    ],
  },
}

/** 下拉框顺序（与参考实现的 SEASON_ORDER 一致） */
export const THEME_ORDER: readonly ThemeKey[] = ['spring', 'summer', 'autumn', 'winter']

/** 默认主题：春（参考实现 DEFAULT_SEASON = SEASON_ORDER[0]） */
export const DEFAULT_THEME: ThemeKey = 'spring'

export function isThemeKey(v: unknown): v is ThemeKey {
  return typeof v === 'string' && (THEME_ORDER as readonly string[]).includes(v)
}

/* ============================================================
   3. 伴奏网格与循环编排
   ============================================================ */

/**
 * 伴奏网格：一小节 8 个八分位置，每列一个 6 位掩码。
 * bit0 低音 / bit1 根音 / bit2 三音 / bit3 五音 / bit4 高八 / bit5 高三
 *
 * 定稿的这一型（与参考实现的 `ACC_PRESETS.pulse` 同型）：
 * 低音落在第 1 拍、第 2 拍后半、第 3 拍；五音+高三叠在第 2 / 4 拍。
 * 读作「咚 · 嗒 咚 咚 · 嗒」。
 */
export const ACC_BAR: readonly number[] = [
  1 << 0,               // 0  低音
  0,                    // 1  休止
  (1 << 3) | (1 << 5),  // 2  五音 + 高三（柱式）
  1 << 0,               // 3  低音
  1 << 0,               // 4  低音
  0,                    // 5  休止
  (1 << 3) | (1 << 5),  // 6  五音 + 高三（柱式）
  0,                    // 7  休止
]

/** 铺成 32 列（四小节同型） */
export const ACC_GRID: readonly number[] = Array.from({ length: 32 }, (_, i) => ACC_BAR[i % 8] as number)

/** 每一行自己的力度：低音是地基，越往上越轻；高三只当点缀 */
export const ROW_VEL: readonly number[] = [0.8, 0.92, 0.85, 0.82, 0.8, 0.74]

/** 变奏模式下每 8 小节从这几型里抽一个（移植参考实现） */
export const ARP_PATTERNS: readonly (readonly (number | null)[])[] = [
  [0, 4, 2, 4, 3, 3, 2, 3],
  [0, 2, 3, 4, 3, 2, 3, 4],
  [0, 4, 3, 2, 3, 4, 5, 4],
  [0, null, 2, null, 3, null, 4, null],
  [0, 2, 3, 2, 0, 2, 3, 2],
]

/**
 * 变奏周期：**固定 8 小节，不跟着循环长度走**。
 * 8 小节主题 + 8 小节变奏周期 = 第一遍纯主题、第二遍加装饰（A A′）。
 * 若让它跟着循环走（4 小节换一次），等于每十几秒换一副面孔，反而听不出主题是什么。
 */
export const VAR_PERIOD = 8

/** 尾句加花用的上行音阶 */
export const FILL_SCALE: readonly number[] = [60, 62, 64, 65, 67, 69, 71, 72]

/**
 * 循环编排：8 小节一段，6 段一轮 = 48 小节。
 * 旋律从头到尾只有一条（不变），新鲜感全来自配器。
 *
 *   mel  旋律出不出现
 *   rows 伴奏行掩码
 *   lh   左手和弦（根音+五音长音）
 *   pad  和声床
 *   shk  沙锤力度系数
 */
export interface Section {
  readonly tag: string
  readonly mel: 0 | 1
  readonly rows: number
  readonly lh: 0 | 1
  readonly pad: 0 | 1
  readonly shk: number
}

export const SECTIONS: readonly Section[] = [
  { tag: '起', mel: 1, rows: 0b000001, lh: 0, pad: 1, shk: 0.7 },
  { tag: '全奏', mel: 1, rows: 0b101001, lh: 1, pad: 1, shk: 1.0 },
  { tag: '全奏', mel: 1, rows: 0b101001, lh: 1, pad: 1, shk: 1.0 },
  { tag: '呼吸', mel: 0, rows: 0b001001, lh: 1, pad: 1, shk: 0.5 },
  { tag: '转调', mel: 1, rows: 0b101001, lh: 1, pad: 1, shk: 1.0 },
  { tag: '收尾', mel: 1, rows: 0b101001, lh: 0, pad: 1, shk: 0.8 },
]

/** 一段 = 8 小节 */
export const BARS_PER_SECTION = 8

/** 取第 `barIndex` 小节落在哪一段 */
export function sectionAt(barIndex: number): Section {
  const i = Math.floor(barIndex / BARS_PER_SECTION) % SECTIONS.length
  return SECTIONS[i] as Section
}

/* ============================================================
   4. 情绪预设与场景
   ============================================================ */

/** 一组场景参数（移植参考实现的 SCENES） */
export interface Mood {
  readonly t: string
  readonly bpm: number
  /** 整体移调（半音，负数为降） */
  readonly tp: number
  /** 伴奏分解层力度 */
  readonly gtr: number
  /** 左手和弦层力度 */
  readonly pno: number
  /** 主旋律力度 */
  readonly mel: number
  /** 密度：当作加花**概率**用，不是音量阈值 */
  readonly dens: number
  readonly verb: number
  readonly bright: number
  readonly shaker: number
  readonly pad: number
}

export const MOODS = {
  cafe: { t: '咖啡小憩', bpm: 66, tp: 0, gtr: 0.55, pno: 1.15, mel: 0.85, dens: 0.8, verb: 0.42, bright: 0.5, shaker: 0, pad: 0.28 },
  sunny: { t: '午后阳光', bpm: 72, tp: 0, gtr: 1.0, pno: 1.0, mel: 1.0, dens: 1.0, verb: 0.36, bright: 0.62, shaker: 0, pad: 0.2 },
  walk: { t: '微风散步', bpm: 80, tp: 0, gtr: 1.0, pno: 0.9, mel: 1.0, dens: 1.15, verb: 0.3, bright: 0.7, shaker: 0.3, pad: 0.12 },
  memory: { t: '回忆闪回', bpm: 62, tp: -2, gtr: 0.3, pno: 1.2, mel: 0.9, dens: 0.6, verb: 0.52, bright: 0.42, shaker: 0, pad: 0.34 },
  rain: { t: '窗外小雨', bpm: 68, tp: 0, gtr: 0.85, pno: 0.85, mel: 0.85, dens: 0.9, verb: 0.46, bright: 0.48, shaker: 0, pad: 0.24 },
  dusk: { t: '黄昏归途', bpm: 70, tp: -3, gtr: 1.05, pno: 0.95, mel: 0.95, dens: 1.0, verb: 0.44, bright: 0.52, shaker: 0.12, pad: 0.26 },
  tension: { t: '心事暗涌', bpm: 76, tp: -1, gtr: 0.9, pno: 1.05, mel: 0.95, dens: 1.25, verb: 0.34, bright: 0.6, shaker: 0.2, pad: 0.3 },
  men: { t: '素面时节', bpm: 126, tp: 0, gtr: 0.55, pno: 1.0, mel: 1.0, dens: 1.1, verb: 0.28, bright: 0.84, shaker: 0.2, pad: 0.12 },
} as const satisfies Record<string, Mood>

export type MoodKey = keyof typeof MOODS

/** 场景 → 一个情绪预设 + 速度/亮度偏移 */
export interface SceneMod {
  readonly name: string
  readonly mood: MoodKey
  readonly bpmMul: number
  readonly dBright: number
}

export const SCENE_MOD: Record<SceneKey, SceneMod> = {
  calm: { name: '定主 · 埋底', mood: 'cafe', bpmMul: 1.0, dBright: 0 },
  play: { name: '出牌', mood: 'sunny', bpmMul: 1.0, dBright: 0 },
  settle: { name: '结算', mood: 'walk', bpmMul: 1.0, dBright: 0 },
  // 终局两版：胜 = 明亮释放；负 = 降 2 度 + 更暗（memory 自带 tp:-2）
  overWin: { name: '终局 · 胜', mood: 'walk', bpmMul: 1.06, dBright: 0.1 },
  overLose: { name: '终局 · 负', mood: 'memory', bpmMul: 0.94, dBright: -0.1 },
  // 回放：只留 pad + 极稀疏，让「复盘」听得清
  replay: { name: '逐墩回放', mood: 'cafe', bpmMul: 0.92, dBright: -0.08 },
}

export const SCENE_ORDER: readonly SceneKey[] = ['calm', 'play', 'settle', 'overWin', 'overLose', 'replay']

/** 合成后的实际参数：情绪预设打底，场景做速度/亮度偏移 */
export interface SceneParams {
  readonly name: string
  readonly bpm: number
  readonly tp: number
  readonly bright: number
  readonly gtr: number
  readonly pno: number
  readonly melV: number
  readonly dens: number
  readonly verb: number
  readonly shaker: number
  readonly pad: number
}

export function sceneParams(scene: SceneKey): SceneParams {
  const md = SCENE_MOD[scene]
  const mo = MOODS[md.mood] as Mood
  return {
    name: md.name,
    bpm: mo.bpm * md.bpmMul,
    tp: mo.tp,
    bright: Math.max(0, Math.min(1, mo.bright + md.dBright)),
    gtr: mo.gtr,
    pno: mo.pno,
    melV: mo.mel,
    dens: mo.dens,
    verb: mo.verb,
    shaker: mo.shaker,
    pad: mo.pad,
  }
}

/** 回放场景抽掉旋律与沙锤（S9：只 pad + 极稀疏拨弦） */
export const REPLAY_MUTE = { mel: 0, shk: 0.25, rows: 0b001001, lh: 0 } as const

/* ============================================================
   5. 力度呼吸与座位声像
   ============================================================ */

/**
 * 力度呼吸：不靠随机，按「强拍重 · 弱拍轻 · 反拍再轻 · 句尾收 · 越高越亮」算出来。
 * 随机的力度听感是「散」，算出来的才是「呼吸」。
 */
export function phraseAccent(beat: number, midi: number, loopBars: number): number {
  const pos = ((beat % 4) + 4) % 4
  let a = pos === 0 ? 1.0 : pos === 2 ? 0.94 : 0.88
  if (pos % 1 !== 0) a *= 0.95
  const bar = Math.floor(beat / 4) % Math.max(1, loopBars)
  if (bar === 1 || bar === loopBars - 1) a *= 0.93
  a *= 0.9 + 0.1 * Math.min(1, Math.max(0, (midi - 60) / 21))
  return a
}

/**
 * 4 家出牌如果全在正中间会糊成一团、也听不出「谁出的」。
 * 按座位分声道是最便宜的空间感来源。
 */
export const SEAT_PAN: Record<Seat, number> = { 0: 0, 1: -0.45, 2: 0, 3: 0.45 }
