/**
 * 窗口拖动：渲染层只报告按下/松开，实际位移由主进程轮询鼠标完成。
 * 这样窗口移动过程中不会丢 mouseup，也能区分点击与拖拽。
 */
import type { HitBox } from '../pet/types'

export function bindWindowDrag(
  target: HTMLElement,
  onDragEnd?: (moved: boolean, x: number, y: number) => void
): void {
  target.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return
    event.preventDefault()

    try {
      // 捕获指针，确保指针移出窗口后仍能收到 pointerup
      target.setPointerCapture(event.pointerId)
    } catch {
      /* 某些情况下（如指针已被释放）捕获会失败，不影响后续逻辑 */
    }

    window.pet.dragStart()
    document.body.classList.add('is-dragging')

    let finished = false
    // 松手的位置也带出去：上层要用它区分「点在形象上」和「点在气泡上」——
    // 两者都算可交互区域，但只有点在形象上才该有反应
    const finish = (event: PointerEvent): void => {
      if (finished) return
      finished = true
      window.removeEventListener('pointerup', finish)
      window.removeEventListener('pointercancel', finish)
      document.body.classList.remove('is-dragging')
      void window.pet
        .dragEnd()
        .then((result) => onDragEnd?.(result.moved, event.clientX, event.clientY))
    }

    window.addEventListener('pointerup', finish)
    window.addEventListener('pointercancel', finish)
  })
}

/** 供上层复用：判断点是否落在命中框内 */
export function pointInBox(x: number, y: number, box: HitBox): boolean {
  return x >= box.x && x <= box.x + box.width && y >= box.y && y <= box.y + box.height
}
