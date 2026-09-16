/**
 * 目光跟随：把指针位置喂给形象。
 *
 * 为什么不用库自带的 `autoInteract`？
 * 它挂在 Pixi 的 InteractionManager 上，而那个管理器监听的是 **canvas 的 DOM 事件** ——
 * 我们的 canvas 是 `pointer-events: none`（见 style.css：命中判定统一走 hitBox 逻辑，
 * 不让 canvas 自己截事件）。于是那条链从头到尾收不到任何事件，配置里开着 `autoInteract`
 * 也一直是死的：模型从不会看向鼠标。
 *
 * 与其为了它把 canvas 变回可点（会牵扯到点击穿透与拖动两套逻辑），不如直接复用渲染层
 * 已经在收的窗口级 pointermove —— 命中判定和拖动用的就是它，显然靠得住。
 */
import type { PetRenderer } from './types'

export function bindLookAt(
  getRenderer: () => PetRenderer | null,
  isEnabled: () => boolean
): void {
  window.addEventListener('pointermove', (event) => {
    if (!isEnabled()) return
    getRenderer()?.lookAt(event.clientX, event.clientY)
  })

  // 指针离开窗口后目光会一直停在最后那个角落，收回来才自然。
  document.addEventListener('mouseleave', () => {
    if (isEnabled()) getRenderer()?.lookAtAway()
  })
}
