<script setup lang="ts">
import type { ShortcutBinding } from '@proj-airi/stage-shared/global-shortcut'

import { getElectronEventaContext, useElectronEventaInvoke } from '@proj-airi/electron-vueuse'
import { parseAccelerator } from '@proj-airi/stage-shared/global-shortcut'
import { useChatOrchestratorStore } from '@proj-airi/stage-ui/stores/chat'
import { useChatSessionStore } from '@proj-airi/stage-ui/stores/chat/session-store'
import { onMounted, onUnmounted, watch } from 'vue'

import {
  electronMcpInterruptComputerUse,
  electronMcpReadConfigText,
  electronMcpSetComputerUseChatActive,
  electronShortcutRegister,
  electronShortcutTriggered,
  electronShortcutUnregister,
} from '../../shared/eventa'
import { parseElectronMcpConfigText } from '../../shared/mcp-config'
import { didComputerUseSendingEnd, didComputerUseSendingStart } from '../stores/computer-use-lifecycle'
import { beginComputerUseTurn, endComputerUseTurn, getActiveComputerUseTurn } from '../stores/computer-use-turn'

const SHORTCUT_ID = 'computer-use-interrupt'
const sourceId = `${SHORTCUT_ID}-${Math.random().toString(36).slice(2)}`

const chatOrchestrator = useChatOrchestratorStore()
const chatSession = useChatSessionStore()
const readMcpConfig = useElectronEventaInvoke(electronMcpReadConfigText)
const interruptComputerUse = useElectronEventaInvoke(electronMcpInterruptComputerUse)
const setComputerUseChatActive = useElectronEventaInvoke(electronMcpSetComputerUseChatActive)
const registerShortcut = useElectronEventaInvoke(electronShortcutRegister)
const unregisterShortcut = useElectronEventaInvoke(electronShortcutUnregister)

let registeredShortcut: string | undefined
let disposeShortcutListener: (() => void) | undefined
let disposeChatTurnListener: (() => void) | undefined
const syncShortcutOnFocus = () => void syncShortcut().catch(() => {})

async function setTurnActive(active: boolean, reset = false) {
  if (!active) {
    endComputerUseTurn(sourceId)
    await setComputerUseChatActive({ sourceId, active: false })
    return
  }

  const currentTurn = getActiveComputerUseTurn()
  const turn = !reset && currentTurn?.sourceId === sourceId
    ? currentTurn
    : beginComputerUseTurn(sourceId)
  await setComputerUseChatActive({ sourceId, active: true, reset, turnId: turn.turnId })
}

async function syncShortcut() {
  const configText = await readMcpConfig()
  const config = parseElectronMcpConfigText(configText.text)
  const server = config.mcpServers?.computer_use
  if (!server || server.enabled === false)
    return

  const nextShortcut = server.env?.COMPUTER_USE_INTERRUPT_SHORTCUT?.trim() || 'End'
  if (registeredShortcut === nextShortcut)
    return

  if (registeredShortcut) {
    await unregisterShortcut({ id: SHORTCUT_ID })
    registeredShortcut = undefined
  }

  const binding: ShortcutBinding = {
    id: SHORTCUT_ID,
    accelerator: parseAccelerator(nextShortcut),
    scope: 'global',
    description: 'Interrupt the active Computer Use session',
  }
  const outcome = await registerShortcut(binding)
  if (outcome.ok)
    registeredShortcut = nextShortcut
}

async function interrupt() {
  chatOrchestrator.cancelPendingSends(chatSession.activeSessionId)
  await setTurnActive(false)
  await interruptComputerUse()
}

watch(() => chatOrchestrator.sending, (sending, wasSending) => {
  if (didComputerUseSendingEnd(sending, wasSending))
    void setTurnActive(false).catch(() => {})
  else if (didComputerUseSendingStart(sending, wasSending))
    void setTurnActive(true).catch(() => {})
}, { immediate: true })

onMounted(() => {
  const orchestratorWithHooks = chatOrchestrator as typeof chatOrchestrator & {
    onBeforeMessageComposed?: (callback: () => Promise<void> | void) => () => void
  }
  disposeChatTurnListener = orchestratorWithHooks.onBeforeMessageComposed?.(
    () => setTurnActive(true, true),
  )

  const context = getElectronEventaContext()
  disposeShortcutListener = context.on(electronShortcutTriggered, (event) => {
    if (event?.body?.id === SHORTCUT_ID && event.body.phase === 'down')
      void interrupt()
  })
  void syncShortcut().catch(() => {})
  window.addEventListener('focus', syncShortcutOnFocus)
})

onUnmounted(() => {
  disposeChatTurnListener?.()
  disposeShortcutListener?.()
  window.removeEventListener('focus', syncShortcutOnFocus)
  void setTurnActive(false).catch(() => {})
  if (registeredShortcut)
    void unregisterShortcut({ id: SHORTCUT_ID }).catch(() => {})
})
</script>

<template>
  <span aria-hidden="true" class="hidden" />
</template>
