/**
 * 点击穿透：鼠标不在可交互区域上时，让窗口忽略鼠标事件，桌面才点得动。
 * 判定在主进程做（setIgnoreMouseEvents），这里只负责报告「指针在不在可交互区域上」。
 *
 * 这个判定由调用方给：可交互的不只是形象本身，还有内容被截断的气泡
 *（双击它能看到全文），而只有调用方知道气泡现在处在什么状态。
 */
export function bindHitTest(isInteractive: (x: number, y: number) => boolean): void {
  // null 表示尚未同步过，第一次移动一定上报一次，纠正主进程的初始状态
  let lastSent: boolean | null = null

  window.addEventListener('pointermove', (event) => {
    // 按下鼠标期间必须一直保持可交互：拖动中窗口跟着光标跑，一旦判定成「不在形象上」
    // 而切进穿透，鼠标松开的事件就未必还能落回窗口，拖拽会卡在半路结束不了。
    if (document.body.classList.contains('is-dragging')) {
      if (lastSent !== true) {
        lastSent = true
        window.pet.setInteractive(true)
      }
      return
    }

    // 这里刻意不看「点击穿透开关」：那个开关归主进程管，关掉时它自己会忽略这些上报。
    // 渲染层要是也跟着开关走，托盘里重新打开穿透之后这个循环就不再上报，
    // 窗口会一直保持可交互 —— 得等下次换形象（重下配置）才恢复。
    const inside = isInteractive(event.clientX, event.clientY)
    if (inside !== lastSent) {
      lastSent = inside
      window.pet.setInteractive(inside)
    }
  })
}
