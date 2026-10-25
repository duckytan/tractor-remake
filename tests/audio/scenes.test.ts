import { describe, expect, it } from 'vitest'

import {
  ACC_BAR,
  ACC_GRID,
  ARP_PATTERNS,
  BARS_PER_SECTION,
  CHORDS,
  CHORD_NAMES,
  DEFAULT_THEME,
  FILL_SCALE,
  MOODS,
  REPLAY_MUTE,
  ROW_VEL,
  SCALE,
  SCENE_MOD,
  SCENE_ORDER,
  SECTIONS,
  SEAT_PAN,
  THEMES,
  THEME_ORDER,
  VAR_PERIOD,
  isThemeKey,
  phraseAccent,
  sceneParams,
  sectionAt,
} from '@audio/scenes'

describe('scenes / 和弦表', () => {
  it('四个和弦各有 6 个声部，且从低到高严格递增', () => {
    expect(CHORDS).toHaveLength(4)
    for (const c of CHORDS) {
      expect(c.p).toHaveLength(6)
      for (let i = 1; i < 6; i++) expect(c.p[i]!).toBeGreaterThan(c.p[i - 1]!)
    }
  })

  it('和弦名与和弦表一一对应', () => {
    expect(CHORD_NAMES).toEqual(CHORDS.map((c) => c.name))
    expect(CHORD_NAMES).toEqual(['C', 'F', 'Am', 'G'])
  })

  it('每个和弦的三音/五音音程正确（大三和弦 4+7，小三和弦 3+7）', () => {
    // p = [低音, 根音, 三音, 五音, 高八, 高三]
    for (const c of CHORDS) {
      const root = c.p[1]!
      const third = c.p[2]! - root
      const fifth = c.p[3]! - root
      expect([3, 4]).toContain(third)
      expect(fifth).toBe(7)
      // 低音必须是根音下八度
      expect(c.p[0]).toBe(root - 12)
      // 高八 / 高三 必须是根音 / 三音上八度
      expect(c.p[4]).toBe(root + 12)
      expect(c.p[5]).toBe(c.p[2]! + 12)
    }
  })

  it('音阶是 C 大调，含 12（高八度主音）', () => {
    expect(SCALE).toEqual([0, 2, 4, 5, 7, 9, 11, 12])
  })
})

describe('scenes / 四季主题', () => {
  it('四个主题都在 THEMES 里，且 key 与下标一致', () => {
    expect(THEME_ORDER).toEqual(['spring', 'summer', 'autumn', 'winter'])
    for (const k of THEME_ORDER) {
      expect(THEMES[k].key).toBe(k)
      expect(THEMES[k].name.length).toBeGreaterThan(0)
      expect(THEMES[k].inst.length).toBeGreaterThan(0)
    }
  })

  it('每个主题都是 8 小节、音符按拍位严格递增、时值为正', () => {
    for (const k of THEME_ORDER) {
      const m = THEMES[k].melody
      expect(THEMES[k].loopBars).toBe(8)
      expect(m.length).toBeGreaterThan(8)
      let prev = -1
      for (const [beat, midi, dur] of m) {
        expect(beat).toBeGreaterThan(prev)
        expect(dur).toBeGreaterThan(0)
        expect(midi).toBeGreaterThanOrEqual(36)
        expect(midi).toBeLessThanOrEqual(96)
        prev = beat
      }
      // 最后一个音的拍位必须落在 8 小节内（32 拍）
      expect(m[m.length - 1]![0]).toBeLessThan(32)
    }
  })

  it('默认主题是春（与参考实现的 SEASON_ORDER[0] 一致）', () => {
    expect(DEFAULT_THEME).toBe('spring')
    expect(THEME_ORDER[0]).toBe(DEFAULT_THEME)
  })

  it('isThemeKey 只认四个合法值', () => {
    for (const k of THEME_ORDER) expect(isThemeKey(k)).toBe(true)
    for (const bad of ['', 'Spring', 'winter2', null, undefined, 1, {}]) expect(isThemeKey(bad)).toBe(false)
  })
})

describe('scenes / 伴奏网格与循环编排', () => {
  it('一小节 8 格，每格是 6 位掩码内的值', () => {
    expect(ACC_BAR).toHaveLength(8)
    for (const v of ACC_BAR) {
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThan(64)
    }
  })

  it('32 列由一小节铺成（四小节同型）', () => {
    expect(ACC_GRID).toHaveLength(32)
    for (let i = 0; i < 32; i++) expect(ACC_GRID[i]).toBe(ACC_BAR[i % 8])
  })

  it('网格只用到低音 / 五音 / 高三三行（与设计一致）', () => {
    const used = new Set<number>()
    for (const bits of ACC_BAR) for (let k = 0; k < 6; k++) if (bits & (1 << k)) used.add(k)
    expect([...used].sort()).toEqual([0, 3, 5])
  })

  it('ROW_VEL 六档，低音最重、高三最轻', () => {
    expect(ROW_VEL).toHaveLength(6)
    expect(ROW_VEL[0]).toBeGreaterThan(ROW_VEL[5]!)
  })

  it('六段编排，每段都有名字与合法的 mel/lh/pad 取值', () => {
    expect(SECTIONS).toHaveLength(6)
    for (const s of SECTIONS) {
      expect(s.tag.length).toBeGreaterThan(0)
      expect([0, 1]).toContain(s.mel)
      expect([0, 1]).toContain(s.lh)
      expect([0, 1]).toContain(s.pad)
      expect(s.shk).toBeGreaterThan(0)
    }
  })

  it('sectionAt 按 8 小节切段，并且循环回绕', () => {
    expect(BARS_PER_SECTION).toBe(8)
    expect(sectionAt(0)).toBe(SECTIONS[0])
    expect(sectionAt(7)).toBe(SECTIONS[0])
    expect(sectionAt(8)).toBe(SECTIONS[1])
    // 一轮 48 小节后回到第一段
    expect(sectionAt(48)).toBe(SECTIONS[0])
    expect(sectionAt(8 * 6 + 3)).toBe(SECTIONS[0])
  })

  it('变奏周期固定 8 小节；ARP_PATTERNS 每型 8 槽', () => {
    expect(VAR_PERIOD).toBe(8)
    for (const pat of ARP_PATTERNS) expect(pat).toHaveLength(8)
  })

  it('尾句加花用 8 个上行音', () => {
    expect(FILL_SCALE).toHaveLength(8)
    for (let i = 1; i < FILL_SCALE.length; i++) expect(FILL_SCALE[i]!).toBeGreaterThan(FILL_SCALE[i - 1]!)
  })
})

describe('scenes / 场景与情绪', () => {
  it('六个场景都有配置，且 SCENE_ORDER 覆盖全部', () => {
    expect(SCENE_ORDER).toHaveLength(6)
    for (const k of SCENE_ORDER) {
      expect(SCENE_MOD[k]).toBeDefined()
      expect(MOODS[SCENE_MOD[k].mood]).toBeDefined()
    }
  })

  it('sceneParams 把情绪预设与场景偏移合起来，亮度夹在 0..1', () => {
    const calm = sceneParams('calm')
    expect(calm.bpm).toBe(MOODS.cafe.bpm)
    expect(calm.tp).toBe(MOODS.cafe.tp)

    const win = sceneParams('overWin')
    expect(win.bpm).toBeGreaterThan(MOODS.walk.bpm)
    expect(win.bright).toBeGreaterThan(MOODS.walk.bright)
    expect(win.bright).toBeLessThanOrEqual(1)

    const lose = sceneParams('overLose')
    expect(lose.bpm).toBeLessThan(MOODS.memory.bpm)
    expect(lose.bright).toBeLessThan(MOODS.memory.bright)
    expect(lose.bright).toBeGreaterThanOrEqual(0)
  })

  it('每个场景的参数都落在合理范围（bpm / 各层力度 / 混响）', () => {
    for (const k of SCENE_ORDER) {
      const p = sceneParams(k)
      expect(p.bpm).toBeGreaterThan(40)
      expect(p.bpm).toBeLessThan(200)
      for (const v of [p.gtr, p.pno, p.melV, p.dens, p.verb, p.bright, p.shaker, p.pad]) {
        expect(v).toBeGreaterThanOrEqual(0)
        expect(v).toBeLessThanOrEqual(2)
      }
    }
  })

  it('回放要抽掉旋律、压低沙锤', () => {
    expect(REPLAY_MUTE.mel).toBe(0)
    expect(REPLAY_MUTE.shk).toBeLessThan(0.5)
  })
})

describe('scenes / 力度呼吸与声像', () => {
  it('强拍最重、反拍最轻', () => {
    const strong = phraseAccent(0, 60, 8)
    const mid = phraseAccent(2, 60, 8)
    const weak = phraseAccent(1, 60, 8)
    expect(strong).toBeGreaterThan(mid)
    expect(mid).toBeGreaterThan(weak)
    // 反拍（半拍位）再让一点
    expect(phraseAccent(1.5, 60, 8)).toBeLessThan(weak)
  })

  it('越高越亮（力度随音高抬升），但有上限', () => {
    const low = phraseAccent(0, 50, 8)
    const high = phraseAccent(0, 80, 8)
    expect(high).toBeGreaterThan(low)
    // 封顶：不会超过 1.05
    expect(phraseAccent(0, 127, 8)).toBeLessThanOrEqual(1.05)
  })

  it('句尾小节收一收（第 2 / 第 8 小节更轻）', () => {
    expect(phraseAccent(4, 60, 8)).toBeLessThan(phraseAccent(0, 60, 8))
    expect(phraseAccent(28, 60, 8)).toBeLessThan(phraseAccent(16, 60, 8))
  })

  it('loopBars 为 0 时不崩（防御）', () => {
    expect(Number.isFinite(phraseAccent(0, 60, 0))).toBe(true)
  })

  it('四家座位声像：左负右正、中间为 0', () => {
    expect(SEAT_PAN[1]).toBeLessThan(0)
    expect(SEAT_PAN[3]).toBeGreaterThan(0)
    expect(SEAT_PAN[0]).toBe(0)
    expect(SEAT_PAN[2]).toBe(0)
  })
})
