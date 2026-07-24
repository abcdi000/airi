const bridge = window.AstrBotPluginPage
const button = document.getElementById('test-button')
const lamp = document.getElementById('status-lamp')
const title = document.getElementById('status-title')
const detail = document.getElementById('status-detail')

await bridge.ready()

function value(id, text) {
  document.getElementById(id).textContent = text || '-'
}

function readiness(ready) {
  return ready ? '已就绪' : '未就绪'
}

function showState(state, heading, message) {
  lamp.dataset.state = state
  title.textContent = heading
  detail.textContent = message
}

button.addEventListener('click', async () => {
  button.disabled = true
  showState('checking', '正在检查', '正在连接 Lumi 运行时...')
  try {
    const result = await bridge.apiGet('connection-test')
    value('target', result.target === 'desktop_local' ? '本地桌面 Lumi' : '中心 Lumi Server')
    value('endpoint', result.endpoint)
    value('token', result.token_configured ? '已配置' : '缺失')
    value('version', result.version)
    value('vision', readiness(result.vision))
    value('hearing', readiness(result.hearing))
    if (result.available) {
      showState('ready', '连接正常', 'Lumi 已经可以接收 AstrBot 消息。')
    }
    else {
      showState('error', 'Lumi 尚未就绪', result.detail || '请检查运行目标、地址、令牌与意识模型配置。')
    }
  }
  catch (error) {
    showState('error', '连接失败', error instanceof Error ? error.message : '无法连接 Lumi。')
  }
  finally {
    button.disabled = false
  }
})
