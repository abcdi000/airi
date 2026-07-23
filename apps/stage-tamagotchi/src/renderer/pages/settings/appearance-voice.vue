<script setup lang="ts">
import { IconItem } from '@proj-airi/stage-ui/components'
</script>

<template>
  <div :class="['flex flex-col gap-4 pb-12']">
    <IconItem title="Lumi 外观" description="选择 Live2D、VRM 与舞台渲染" icon="i-solar:palette-bold-duotone" to="/settings/models" />
    <IconItem title="语音与音频" description="配置当前设备的本地 TTS 与语音播放" icon="i-solar:user-speak-rounded-bold-duotone" to="/settings/modules/speech" />
  </div>
</template>

<route lang="yaml">
meta:
  layout: settings
  title: 外观与语音
  subtitle: 设置
  description: 此设备上的 Live2D、音频与 TTS
  icon: i-solar:palette-round-bold-duotone
  settingsEntry: true
  order: 3
  stageTransition:
    name: slide
</route>
