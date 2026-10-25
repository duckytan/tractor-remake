/**
 * 音频门面 —— 游戏侧只跟这个文件打交道。
 *
 * 用法（`main.ts`）：
 *   const audio = createAudio(settings)
 *   audio.observe(prevState, nextState)   // 在 paint() 里跟 trackPlayFx 并排
 *   audio.applySettings(nextSettings)     // 设置变更时
 *   audio.dispose()                       // 卸载
 *
 * 设计约束：
 *   · **不改 `core` / `app`**：音频是纯观察者，靠前后帧 diff 推断发生了什么
 *   · **不阻塞 UI**：所有发声都是"排到未来某个时刻"，调度器 40ms 轮询
 *   · **Tone.js 是可选增强**：加载失败自动退回原生引擎，功能不降级
 */

import type { Seat } from '@core'
import { applyVolumes, createBuses, resume, suspend } from './engine'
import type { AudioBuses, Volumes } from './engine'
import { MusicEngine } from './music'
import { sceneOf, soundEventsOf, tensionOf } from './observe'
import type { AudioStateLike } from './observe'
import { createSfxRuntime, nextPitch, playSfx } from './sfx'
import type { SfxHost, SfxOptions, SfxRuntime } from './sfx'
import { SEAT_PAN, isThemeKey } from './scenes'
import type { SceneKey, ThemeKey } from './scenes'
import { nativeRenderer } from './voices'
import { ToneRenderer, loadTone } from './tone'

/** 音频设置（来自 `GameState`，由 `main.ts` 传进来） */
export interface AudioSettings {
  /** 总音量 0..1 */
  readonly volumeMaster: number
  /** BGM 音量 0..1 */
  readonly volumeBgm: number
  /** 音效音量 0..1 */
  readonly volumeSfx: number
  /** 音乐主题（四季） */
  readonly musicTheme: ThemeKey
  /** 增强音效：BGM 改用 Tone.js 引擎 */
  readonly soundEnhanced: boolean
  /** 根据剧情自动变奏（关掉就永远同一套） */
  readonly autoVariation: boolean
}

export interface AudioHandle {
  /** 前后帧对比 → 发声 + 更新 BGM 场景/紧张度 */
  observe(prev: AudioStateLike, next: AudioStateLike): void
  /** 设置变更（音量/主题/引擎/变奏） */
  applySettings(s: AudioSettings): void
  /** 用户手势后调用一次：创建上下文并起播 BGM */
  start(): void
  stop(): void
  /** 切后台/回来 */
  setPageVisible(visible: boolean): void
  /** 手动播一个音效（设置面板试听、按钮反馈用） */
  playSfx(name: string, opts?: SfxOptions): void
  dispose(): void
  /** 当前是否已在跑 */
  readonly running: boolean
}

export function createAudio(initial: AudioSettings): AudioHandle {
  let settings = initial
  let buses: AudioBuses | null = null
  let music: MusicEngine | null = null
  let toneRenderer: ToneRenderer | null = null
  let toneLoading = false
  const rt: SfxRuntime = createSfxRuntime()
  /** 每个座位一个声像出口（懒建） */
  const seatOuts = new Map<number, StereoPannerNode>()

  const seatOut = (seat: Seat | undefined): AudioNode => {
    if (!buses) throw new Error('audio not ready')
    if (seat === undefined) return buses.sfxBus
    const hit = seatOuts.get(seat)
    if (hit) return hit
    const p = buses.ctx.createStereoPanner()
    p.pan.value = SEAT_PAN[seat] ?? 0
    p.connect(buses.sfxBus)
    seatOuts.set(seat, p)
    return p
  }

  const host = (): SfxHost => {
    if (!buses) throw new Error('audio not ready')
    return {
      env: buses.env,
      out: buses.sfxBus,
      seatOut,
      pitch: (name, degree) => nextPitch(rt, name, degree, music?.tension ?? 0, music?.keyShift ?? 0),
    }
  }

  const volumes = (): Volumes => ({
    master: settings.volumeMaster,
    bgm: settings.volumeBgm,
    sfx: settings.volumeSfx,
  })

  /** 建上下文 + 调度器（幂等） */
  const ensure = (): boolean => {
    if (buses) return true
    try {
      buses = createBuses(volumes())
    } catch {
      return false
    }
    music = new MusicEngine(
      {
        env: buses.env,
        accBus: buses.accBus,
        leadBus: buses.leadBus,
        padBus: buses.padBus,
        fxBus: buses.fxBus,
        render: nativeRenderer,
      },
      {
        theme: settings.musicTheme,
        scene: 'calm',
        tension: 0,
        autoVariation: settings.autoVariation,
      },
    )
    void resume(buses)
    return true
  }

  /** 增强音效：把 BGM 的发声换成 Tone；失败静默退回原生 */
  const ensureTone = async (): Promise<void> => {
    if (toneRenderer || toneLoading || !buses) return
    toneLoading = true
    try {
      const tone = await loadTone()
      const roleOf = new Map<AudioNode, 'acc' | 'lead' | 'pad' | 'fx'>([
        [buses.accBus, 'acc'],
        [buses.leadBus, 'lead'],
        [buses.padBus, 'pad'],
        [buses.fxBus, 'fx'],
      ])
      toneRenderer = new ToneRenderer(tone, roleOf, buses.ctx, buses.musicBus)
      // 热切换：只换 render，调度器不动
      music?.setRenderer(toneRenderer)
    } catch {
      toneRenderer = null
    } finally {
      toneLoading = false
    }
  }

  return {
    get running() {
      return music?.running ?? false
    },

    observe(prev, next) {
      if (!buses || !music) return
      const events = soundEventsOf(prev, next)
      const h = host()
      for (const e of events) {
        switch (e.type) {
          case 'play':
            h && playSfx(rt, h, e.multi ? 'playMulti' : e.seat === 0 ? 'play' : 'playAi', {
              seat: e.seat as Seat,
            })
            break
          case 'settleUp':
            playSfx(rt, h, 'settleUp', { n: e.n })
            break
          default:
            playSfx(rt, h, e.type)
        }
      }
      // BGM 场景与紧张度跟着走
      music.setOptions({
        scene: sceneOf(next) as SceneKey,
        tension: tensionOf(next),
      })
    },

    applySettings(next) {
      const prevTheme = settings.musicTheme
      const prevEnhanced = settings.soundEnhanced
      settings = next
      if (!buses) return
      applyVolumes(buses, volumes())
      music?.setOptions({
        theme: isThemeKey(next.musicTheme) ? next.musicTheme : 'spring',
        autoVariation: next.autoVariation,
      })
      if (prevTheme !== next.musicTheme) {
        // 换主题时给一个极轻的确认音，让人知道换成了什么
        playSfx(rt, host(), 'ui', { force: true })
      }
      if (next.soundEnhanced && !prevEnhanced) void ensureTone()
      if (!next.soundEnhanced && prevEnhanced && toneRenderer) {
        toneRenderer.dispose()
        toneRenderer = null
        music?.setRenderer(nativeRenderer)
      }
    },

    start() {
      if (!ensure() || !music) return
      music.start()
      if (settings.soundEnhanced) void ensureTone()
    },

    stop() {
      music?.stop()
    },

    setPageVisible(visible) {
      if (!buses) return
      if (visible) void resume(buses)
      else suspend(buses)
    },

    playSfx(name, opts) {
      if (!ensure()) return
      playSfx(rt, host(), name, opts)
    },

    dispose() {
      music?.stop()
      toneRenderer?.dispose()
      toneRenderer = null
      if (buses) {
        try {
          void buses.ctx.close()
        } catch {
          /* 忽略 */
        }
      }
      buses = null
      music = null
      seatOuts.clear()
    },
  }
}
