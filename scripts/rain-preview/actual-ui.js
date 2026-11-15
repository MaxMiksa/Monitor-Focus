export function createActualUI(stage) {
  const frame = document.createElement('iframe')
  frame.id = 'actual-ui'
  frame.title = '软件实际界面预览'
  frame.hidden = true
  const edges = [{ left: 0, right: 0, top: 0 }, { left: 0, right: 0, top: 0 }]
  const visible = []
  let enabled = false
  let sceneListener = () => {}, lastScene = ''
  let changeListener = () => {}, documentObserver
  frame.addEventListener('load', () => {
    documentObserver?.disconnect()
    let lastOpen
    const check = () => {
      const shell = frame.contentDocument?.querySelector('.scene-shell')
      const open = shell?.dataset.settingsOpen
      if (shell && lastScene !== shell.dataset.scene) { lastScene = shell.dataset.scene; sceneListener(lastScene) }
      if (open !== lastOpen) { lastOpen = open; changeListener() }
    }
    documentObserver = new MutationObserver(check)
    documentObserver.observe(frame.contentDocument.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-settings-open', 'data-scene'] })
    check()
  })
  const resize = () => frame.style.setProperty('--ui-scale', String(stage.clientWidth / 1168))
  const observer = new ResizeObserver(resize)
  observer.observe(stage)
  resize()
  return {
    onScene(listener) { sceneListener = listener },
    onChange(listener) { changeListener = listener },
    setEnabled(value) {
      enabled = value
      frame.hidden = !value
      document.body.classList.toggle('ui-preview', value)
      if (value && !frame.isConnected) { frame.src = '/app/?preview=1'; stage.append(frame) }
      changeListener()
    },
    getEdges() {
      visible.length = 0
      visible.settingsOpen = false
      if (!enabled) return visible
      const doc = frame.contentDocument
      const shell = doc?.querySelector('.scene-shell')
      if (!shell) return visible
      visible.settingsOpen = shell.dataset.settingsOpen === 'true'
      if (lastScene !== shell.dataset.scene) { lastScene = shell.dataset.scene; sceneListener(lastScene) }
      const origin = stage.getBoundingClientRect(), bounds = frame.getBoundingClientRect()
      const scale = bounds.width / 1168
      const elements = [doc.querySelector('.settings-morph-surface'), doc.querySelector('.scene-expand-hint:not([inert])')]
      for (let index = 0; index < elements.length; index++) {
        const element = elements[index]
        if (!element) continue
        const rect = element.getBoundingClientRect()
        if (rect.width < 4 || rect.height < 4) continue
        const radius = index === 0 ? Math.min(rect.height / 2, parseFloat(element.style.borderRadius) || 28) : rect.width * .4
        const edge = edges[index]
        edge.left = bounds.left - origin.left + (rect.left + radius) * scale
        edge.right = bounds.left - origin.left + (rect.right - radius) * scale
        edge.top = bounds.top - origin.top + rect.top * scale
        visible.push(edge)
      }
      return visible
    },
    dispose() { observer.disconnect(); documentObserver?.disconnect(); frame.remove() },
  }
}
