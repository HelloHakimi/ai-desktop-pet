/** 占位形象：纯 CSS 实现，不依赖任何美术资源，保证骨架永远能跑起来 */
import type { HitBox, PetRenderer } from './types'

/** 命中框收窄比例：正方形碰撞盒比形象本身大一圈，稍微收一点手感更好 */
const HIT_INSET = 0.12

export class PlaceholderRenderer implements PetRenderer {
  readonly kind = 'placeholder'
  private readonly element: HTMLElement

  constructor(host: HTMLElement, note?: string) {
    this.element = document.createElement('div')
    this.element.className = 'placeholder-pet'
    this.element.innerHTML = `
      <div class="placeholder-pet__body">
        <div class="placeholder-pet__eye placeholder-pet__eye--left"></div>
        <div class="placeholder-pet__eye placeholder-pet__eye--right"></div>
        <div class="placeholder-pet__cheek placeholder-pet__cheek--left"></div>
        <div class="placeholder-pet__cheek placeholder-pet__cheek--right"></div>
      </div>
      ${note ? `<div class="placeholder-pet__note">${escapeHtml(note)}</div>` : ''}
    `
    host.appendChild(this.element)
  }

  getHitBox(): HitBox | null {
    const rect = this.element.getBoundingClientRect()
    if (rect.width === 0 || rect.height === 0) return null
    const insetX = rect.width * HIT_INSET
    const insetY = rect.height * HIT_INSET
    return {
      x: rect.x + insetX,
      y: rect.y + insetY,
      width: rect.width - insetX * 2,
      height: rect.height - insetY * 2
    }
  }

  /** 占位形象是一块 CSS 圆角方块，没有可用的 alpha 掩码，按命中框判就好 */
  hitTest(x: number, y: number): boolean {
    const box = this.getHitBox()
    if (!box) return false
    return x >= box.x && x <= box.x + box.width && y >= box.y && y <= box.y + box.height
  }

  applyExpression(): void {
    // no-op：占位形象不支持表情
  }

  toggleExpression(): void {
    // no-op：占位形象不支持表情
  }

  removeExpression(): void {
    // no-op：占位形象不支持表情
  }

  clearExpressions(): void {
    // no-op：占位形象不支持表情
  }

  randomExpression(): void {
    // no-op：占位形象不支持表情
  }

  activeExpressions(): string[] {
    return []
  }

  hasExpression(): boolean {
    return false
  }

  lookAt(): void {
    // no-op：占位形象没有可动的目光
  }

  lookAtAway(): void {
    // no-op：占位形象没有可动的目光
  }

  destroy(): void {
    this.element.remove()
  }
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => {
    switch (char) {
      case '&':
        return '&amp;'
      case '<':
        return '&lt;'
      case '>':
        return '&gt;'
      case '"':
        return '&quot;'
      default:
        return '&#39;'
    }
  })
}
