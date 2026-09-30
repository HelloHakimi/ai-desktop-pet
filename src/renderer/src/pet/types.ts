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
  /**
   * 这个点算不算落在形象上（点击穿透与抚摸都用它）。
   *
   * 与 getHitBox 的区别：包围盒只回答「大概的范围」，这个方法可以按**真实画出来的像素**
   * 回答（Live2D 用 alpha 掩码），于是形象轮廓之外的透明区域不再挡住桌面上的鼠标。
   * 拿不到掩码时退回包围盒语义 —— 宁可多挡一点，也不能让形象点不动。
   */
  hitTest(x: number, y: number): boolean
  /**
   * 套用一个表情。表情是**分层**的（情绪 / 配件 / 道具 / 按键图案各占一层），
   * 互不冲突的层可以同时挂着；`holdMs` 省略表示常驻，否则到时自动回落。
   */
  applyExpression(name: string, holdMs?: number): void
  /** 再点一次取消：已生效就摘掉，否则常驻套上（托盘「试个表情」用） */
  toggleExpression(name: string): void
  /** 按名字摘掉一层；没挂着就是空操作（闲置醒来清「闭眼口水」、退出敲琴摘「手敲琴」） */
  removeExpression(name: string): void
  /** 清掉所有表情层（回到默认脸） */
  clearExpressions(): void
  /** 从当前形象的表情清单里随机抽一个常驻（不含敲琴的按键图案层） */
  randomExpression(): void
  /** 当前生效的表情名，可能不止一个（叠加出来的组合） */
  activeExpressions(): string[]
  /** 当前形象有没有这个表情（交互反应池据此挑选能用的名字） */
  hasExpression(name: string): boolean
  /** 目光跟随指针，坐标是窗口内的 CSS 像素（占位形象为空实现） */
  lookAt(x: number, y: number): void
  /** 指针离开窗口，目光收回正中（占位形象为空实现） */
  lookAtAway(): void
  destroy(): void
}

export type { RendererConfig }
