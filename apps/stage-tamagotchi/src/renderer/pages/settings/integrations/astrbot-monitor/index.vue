<script setup lang="ts">
import { errorMessageFrom } from '@moeru/std'
import { Callout } from '@proj-airi/ui'
import { onMounted, shallowRef } from 'vue'

import AstrBotLearningMonitor from '../astrbot/components/AstrBotLearningMonitor.vue'

import { useLocalAstrBotGateway } from '../astrbot/useLocalAstrBotGateway'

const gateway = useLocalAstrBotGateway()
const localError = shallowRef('')

async function load() {
  localError.value = ''
  try {
    await gateway.load()
  }
  catch (error) {
    localError.value = errorMessageFrom(error) ?? '无法读取 AstrBot 学习状态'
  }
}

onMounted(load)
</script>

<template>
  <div :class="['flex flex-col gap-6 pb-12']">
    <Callout v-if="localError || gateway.error.value" theme="orange" label="学习监控不可用">
      {{ localError || gateway.error.value }}
    </Callout>

    <AstrBotLearningMonitor
      v-motion
      :group-observation-enabled="gateway.state.value?.config.groupObservationEnabled ?? false"
      :groups="gateway.state.value?.config.studyGroups ?? []"
      :batch-size="gateway.state.value?.config.observationBatchSize ?? 20"
      :history-limit="gateway.state.value?.config.observationHistoryLimit ?? 5_000"
      :concurrent-groups="gateway.state.value?.config.observationConcurrentGroups ?? 3"
      :initial="{ opacity: 0, y: 8 }"
      :enter="{ opacity: 1, y: 0 }"
      :duration="220"
    />
  </div>
</template>

<route lang="yaml">
meta:
  layout: settings
  title: 学习监控
  subtitle: 设置
  description: 查看群聊观察、语言变化与表情包学习
  icon: i-solar:chart-2-bold-duotone
  settingsEntry: true
  order: 3
  stageTransition:
    name: slide
</route>
