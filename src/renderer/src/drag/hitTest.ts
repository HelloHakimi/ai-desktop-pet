/**
 * 点击穿透：鼠标不在形象上时，让窗口忽略鼠标事件，桌面才点得动。
 * 判定在主进程做（setIgnoreMouseEvents），这里只负责报告状态变化。
 */
import { pointInBox } from './windowDrag'
import type { HitBox } from '../pet/types'

export function bindHitTest(
  getHitBox: () => HitBox | null,
  isClickThroughEnabled: () => boolean
): void {
  // null 表示尚未同步过，第一次移动一定上报一次，纠正主进程的初始状态
  let lastSent: boolean | null = null

  window.addEventListener('pointermove', (event) => {
    // 按下鼠标期间必须一直保持可交互：拖动中窗口跟着光标跑，一旦判定成「不在形象上」
    // 而切进穿透，鼠标松开的事件就未必还能落回窗口，拖拽会卡在半路结束不了。
    if (!isClickThroughEnabled() || document.body.classList.contains('is-dragging')) {
      if (lastSent !== true) {
        lastSent = true
        window.pet.setInteractive(true)
      }
      return
    }

    const box = getHitBox()
    if (!box) return

    const inside = pointInBox(event.clientX, event.clientY, box)
    if (inside !== lastSent) {
      lastSent = inside
      window.pet.setInteractive(inside)
    }
  })
}
