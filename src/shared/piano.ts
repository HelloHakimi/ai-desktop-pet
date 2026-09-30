/**
 * 敲琴的键位表：主进程用它拼托盘菜单里的提示，渲染层用它听键与发音。
 *
 * 放在 shared 是因为两边都要用，而这份表一旦和实际听键的代码分家就会说谎 ——
 * 菜单写着「A S D W 1」、渲染层却少听一个键，是那种没人会立刻发现的坏味道。
 */
export interface PianoKey {
  /** KeyboardEvent.code（布局无关，中文输入法下也一样） */
  code: string
  /** 模型里的按键层表情名 */
  name: string
  /** 音高（Hz） */
  freq: number
  /** 菜单文案里的写法 */
  label: string
}

/** 五声音阶 C5 D5 E5 G5 A5：随手乱按也不难听 */
export const PIANO_KEYS: readonly PianoKey[] = [
  { code: 'KeyA', name: 'A', freq: 523.25, label: 'A' },
  { code: 'KeyS', name: 'S', freq: 587.33, label: 'S' },
  { code: 'KeyD', name: 'D', freq: 659.25, label: 'D' },
  { code: 'KeyW', name: 'W', freq: 783.99, label: 'W' },
  { code: 'Digit1', name: '1', freq: 880.0, label: '1' }
]

export const PIANO_KEYS_HINT = PIANO_KEYS.map((key) => key.label).join(' ')

/**
 * 按键图案挂多久。鼠标的「左键 / 右键」图案用的是同一个时长：
 * 它们都是这套敲琴里的同一类东西 —— 按下即显示、松手就淡出的即时反馈。
 */
export const PIANO_KEY_HOLD_MS = 400
