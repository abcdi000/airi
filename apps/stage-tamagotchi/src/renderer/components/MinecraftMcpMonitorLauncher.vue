<script setup lang="ts">
import type { McpActivityEvent } from '@proj-airi/stage-ui/tools/mcp'

import { useElectronEventaInvoke } from '@proj-airi/electron-vueuse'
import { MCP_ACTIVITY_CHANNEL_NAME } from '@proj-airi/stage-ui/tools/mcp'
import { useBroadcastChannel } from '@vueuse/core'
import { watch } from 'vue'

import { electronOpenMinecraftMcpMonitor } from '../../shared/eventa'

const openMonitor = useElectronEventaInvoke(electronOpenMinecraftMcpMonitor)
const { data } = useBroadcastChannel<McpActivityEvent, McpActivityEvent>({
  name: MCP_ACTIVITY_CHANNEL_NAME,
})

let lastOpenAt = 0

watch(data, (event) => {
  if (!event || event.kind !== 'mcp-activity' || !event.target.startsWith('minecraft::'))
    return

  const now = Date.now()
  if (now - lastOpenAt < 1000)
    return

  lastOpenAt = now
  void openMonitor().catch((error) => {
    console.warn('[MinecraftMcpMonitorLauncher] Failed to open monitor window:', error)
  })
})
</script>

<template>
  <span aria-hidden="true" class="hidden" />
</template>
