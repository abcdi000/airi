<script setup lang="ts">
import type { ElectronLumiAstrBotGatewayState } from '../../../../../../shared/eventa'

import { Checkbox } from '@proj-airi/ui'
import { computed } from 'vue'

const props = defineProps<{
  state?: ElectronLumiAstrBotGatewayState
  enabled: boolean
  disabled?: boolean
}>()

const emit = defineEmits<{
  'update:enabled': [enabled: boolean]
}>()

const status = computed(() => {
  if (props.state?.runtimeMode === 'online-client')
    return { label: '等待本地模式', color: 'bg-amber-500', detail: '客户端当前连接 Lumi Server，本地网关暂停处理消息。' }
  if (props.state?.running)
    return { label: '运行中', color: 'bg-emerald-500', detail: props.state.endpoint }
  if (props.state?.lastError)
    return { label: '启动失败', color: 'bg-red-500', detail: props.state.lastError }
  return { label: '已停止', color: 'bg-neutral-400', detail: props.state?.endpoint ?? 'http://127.0.0.1:6132' }
})
</script>

<template>
  <section :class="['flex items-center justify-between gap-5 border-b border-neutral-200 pb-6 dark:border-neutral-800']">
    <div :class="['flex min-w-0 items-center gap-3']">
      <span :class="['relative grid size-11 shrink-0 place-items-center rounded-md bg-neutral-100 dark:bg-neutral-900']">
        <span :class="['i-solar:chat-round-line-bold-duotone size-7 text-cyan-700 dark:text-cyan-300']" />
        <span :class="['absolute -bottom-1 -right-1 size-3 rounded-full border-2 border-white dark:border-neutral-950', status.color]" />
      </span>
      <div :class="['min-w-0']">
        <div :class="['font-semibold']">
          {{ status.label }}
        </div>
        <div :class="['mt-0.5 truncate text-sm text-neutral-500 dark:text-neutral-400']">
          {{ status.detail }}
        </div>
      </div>
    </div>
    <div :class="['flex items-center gap-3']">
      <span :class="['text-sm text-neutral-500 dark:text-neutral-400']">启用接入</span>
      <Checkbox
        :model-value="enabled"
        :disabled="disabled"
        @update:model-value="emit('update:enabled', Boolean($event))"
      />
    </div>
  </section>
</template>
