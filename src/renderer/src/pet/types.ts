/** 形象渲染器的统一契约：Live2D 与占位形象都实现它，上层不需要知道具体是哪种 */
import type { RendererConfig } from '@shared/config'

export type PetKind = 'live2d' | 'placeholder'

/** 命中区域，坐标相对窗口左上角（CSS 像素） */
export interface HitBox {
  x: number
  y: number
  width: number
  height: number
}

export interface PetRenderer {
  readonly kind: PetKind
  /** 用于点击穿透判定：返回 null 表示整窗不可命中 */
  getHitBox(): HitBox | null
  /** 播放动作（占位形象为空实现） */
  playMotion(group?: string): void
  /** 切换表情；不传名字表示随机抽一个（占位形象为空实现） */
  setExpression(name?: string): void
  /** 回到没有任何表情的默认状态（占位形象为空实现） */
  resetExpression(): void
  /** 目光跟随指针，坐标是窗口内的 CSS 像素（占位形象为空实现） */
  lookAt(x: number, y: number): void
  /** 指针离开窗口，目光收回正中（占位形象为空实现） */
  lookAtAway(): void
  destroy(): void
}

export type { RendererConfig }
