/**
 * 敲琴模式：形象上挂出「手敲琴」，键盘 A / S / D / W / 1 各对应一个按键图案（模型自带的 7 个
 * 叠加层表情里的 5 个），并顺手用 WebAudio 合成对应的音。
 *
 * 为什么入口只在托盘：进来之后要**抢键盘焦点**（见主进程的 applyGame —— 它会把形象窗口
 * 聚焦起来，键盘事件才到得了这一层）。一个桌宠随手抢走用户正在打字的键盘是不能接受的，
 * 所以它必须是一个用户明确发起、又能一眼找到退路的动作，而不是「点一下形象就进」。
 *
 * 退出有两条路：托盘里再点一次，或者按 Esc（Esc 之后会把状态回报给主进程，托盘的勾跟着走）。
 */
import { PIANO_KEYS, type PianoKey } from '@shared/piano'

export interface PianoMode {
  isActive(): boolean
  start(): void
  stop(): void
}

const KEY_BY_CODE = new Map<string, PianoKey>(PIANO_KEYS.map((key) => [key.code, key]))

export function createPianoMode(hooks: {
  /** 按下一个键：套上对应的按键层表情 */
  onKey(name: string): void
  onStart(): void
  onStop(): void
}): PianoMode {
  let active = false
  let audio: AudioContext | null = null

  const onKeyDown = (event: KeyboardEvent): void => {
    if (!active) return
    if (event.key === 'Escape') {
      stop()
      return
    }
    // ⌘/⌃/⌥ 组合是系统的：Cmd+A 全选、Ctrl+A 移到行首，都不能被这里吞掉
    if (event.metaKey || event.ctrlKey || event.altKey) return

    const key = KEY_BY_CODE.get(event.code)
    if (!key) return
    // 阻止默认行为：否则 macOS 会为按不到的键发出系统提示音
    event.preventDefault()
    // 长按会连发 keydown：图案跟着刷新没问题，音只发一次（否则是一串嗡嗡声）
    if (!event.repeat) playTone(key.freq)
    hooks.onKey(key.name)
  }

  const playTone = (freq: number): void => {
    try {
      audio ??= new AudioContext()
      // 用户手势之外被挂起时补一次 resume（CDP 注入的事件、窗口刚被聚焦都可能落在挂起态）
      if (audio.state === 'suspended') void audio.resume()
      const now = audio.currentTime
      const osc = audio.createOscillator()
      const gain = audio.createGain()
      osc.type = 'triangle'
      osc.frequency.value = freq
      // 音量压得很低：这是桌宠在敲琴，不是播放器在放歌
      gain.gain.setValueAtTime(0.12, now)
      gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.4)
      osc.connect(gain).connect(audio.destination)
      osc.start(now)
      osc.stop(now + 0.45)
    } catch (error) {
      // 没有音频设备（远程桌面、音频服务没起来）只该是「没声音」，不该让敲琴整个坏掉
      console.warn('[pet] 敲琴音效不可用：', error)
    }
  }

  const start = (): void => {
    if (active) return
    active = true
    window.addEventListener('keydown', onKeyDown)
    hooks.onStart()
  }

  const stop = (): void => {
    if (!active) return
    active = false
    window.removeEventListener('keydown', onKeyDown)
    hooks.onStop()
  }

  return {
    isActive: () => active,
    start,
    stop
  }
}
