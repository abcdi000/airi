<script setup lang="ts">
import { Button, Callout, FieldCombobox } from '@proj-airi/ui'
import { storeToRefs } from 'pinia'
import { computed } from 'vue'

import { useAudioAnalyzer, useAudioDevice } from '../../../../composables'
import { useSettingsAudioDevice } from '../../../../stores'

const props = withDefaults(defineProps<{
  granted?: boolean
  transcription?: boolean
}>(), {
  granted: false,
})

const deviceStore = useSettingsAudioDevice()
const { enabled, selectedAudioInput } = storeToRefs(deviceStore)
const { audioInputs, permissionGranted, askPermission } = useAudioDevice()
const { volumeLevel } = useAudioAnalyzer()

const autoSend = defineModel<boolean>('autoSend')
const ringEnabledClass = computed(() => enabled.value
  ? 'bg-primary-500/15 dark:bg-primary-600/20'
  : 'bg-neutral-300/20 dark:bg-neutral-700/20',
)
const statusText = computed(() => {
  if (!permissionGranted.value && !props.granted)
    return '等待麦克风权限'
  if (!enabled.value)
    return '麦克风未开启'
  if (props.transcription)
    return autoSend.value ? '正在识别这一句话，说完会自动发送' : '正在识别这一句话，自动发送已关闭'
  return '麦克风待命中，听到声音才会连接识别'
})
const statusClass = computed(() => {
  if (!enabled.value)
    return 'bg-neutral-500/10 text-neutral-500 dark:text-neutral-300'
  if (props.transcription)
    return 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-300'
  return 'bg-sky-500/10 text-sky-600 dark:text-sky-300'
})

function toggleHearingEnabled() {
  if (enabled.value) {
    enabled.value = false
    return
  }
  if (autoSend.value === false)
    autoSend.value = true
  if (selectedAudioInput.value !== '' && permissionGranted.value) {
    enabled.value = true
    return
  }
  if (!permissionGranted.value) {
    return askPermission().then(() => {
      enabled.value = permissionGranted.value
    })
  }
}
</script>

<template>
  <div class="space-y-4">
    <div class="rounded-2xl from-primary-500/10 to-cyan-500/8 bg-gradient-to-br p-4 dark:from-primary-400/10 dark:to-cyan-400/5">
      <div class="flex items-center justify-between gap-3">
        <div>
          <div class="text-sm text-neutral-500 dark:text-neutral-400">
            听力控制
          </div>
          <div class="mt-1 text-base text-neutral-800 font-semibold dark:text-neutral-100">
            {{ statusText }}
          </div>
        </div>
        <span class="shrink-0 rounded-full px-3 py-1 text-xs font-medium" :class="statusClass">
          {{ props.transcription ? '识别中' : enabled ? '待命' : '未开启' }}
        </span>
      </div>

      <div class="mt-5 flex flex-col items-center justify-center">
        <div class="relative h-30 w-30 select-none">
          <div
            v-if="enabled"
            class="absolute inset-1 rounded-full bg-primary-400/12 animate-ping"
            :style="{ animationDuration: `${Math.max(900, 1800 - volumeLevel * 10)}ms` }"
          />
          <div
            class="absolute left-1/2 top-1/2 h-20 w-20 rounded-full transition-all duration-150 -translate-x-1/2 -translate-y-1/2"
            :style="{ transform: `translate(-50%, -50%) scale(${1 + (volumeLevel / 100) * 0.35})`, opacity: String(0.25 + (volumeLevel / 100) * 0.25) }"
            :class="ringEnabledClass"
          />
          <div
            class="absolute left-1/2 top-1/2 h-24 w-24 rounded-full transition-all duration-200 -translate-x-1/2 -translate-y-1/2"
            :style="{ transform: `translate(-50%, -50%) scale(${1.2 + (volumeLevel / 100) * 0.55})`, opacity: String(0.15 + (volumeLevel / 100) * 0.2) }"
            :class="enabled ? 'bg-primary-500/10 dark:bg-primary-600/15' : 'bg-neutral-300/10 dark:bg-neutral-700/10'"
          />
          <div
            class="absolute left-1/2 top-1/2 h-28 w-28 rounded-full transition-all duration-300 -translate-x-1/2 -translate-y-1/2"
            :style="{ transform: `translate(-50%, -50%) scale(${1.5 + (volumeLevel / 100) * 0.8})`, opacity: String(0.08 + (volumeLevel / 100) * 0.15) }"
            :class="enabled ? 'bg-primary-500/5 dark:bg-primary-600/10' : 'bg-neutral-300/5 dark:bg-neutral-700/5'"
          />

          <button
            class="absolute left-1/2 top-1/2 grid h-16 w-16 place-items-center rounded-full shadow-lg outline-none transition-all duration-200 -translate-x-1/2 -translate-y-1/2 active:scale-95"
            :class="[
              enabled ? 'bg-primary-500 text-white hover:bg-primary-600' : 'bg-neutral-200 text-neutral-600 hover:bg-neutral-300 dark:bg-neutral-700 dark:text-neutral-200',
            ]"
            @click="toggleHearingEnabled"
          >
            <div :class="enabled ? 'i-ph:microphone' : 'i-ph:microphone-slash'" class="h-6 w-6" />
          </button>
        </div>

        <div class="mt-4 h-2 w-full overflow-hidden rounded-full bg-neutral-200/80 dark:bg-neutral-800/80">
          <div
            class="h-full rounded-full bg-primary-500 transition-all duration-120"
            :style="{ width: `${Math.min(100, Math.max(4, volumeLevel))}%` }"
          />
        </div>
        <div class="mt-2 text-xs text-neutral-500 dark:text-neutral-400">
          音量 {{ Math.round(volumeLevel) }}%
        </div>
      </div>
    </div>

    <div v-if="!props.granted" class="w-full">
      <Callout theme="orange" label="需要麦克风权限">
        <div class="text-sm">
          AIRI 还没有麦克风权限。请在系统权限里允许麦克风访问，然后重新打开听觉。
        </div>
      </Callout>
    </div>

    <div class="flex flex-wrap gap-2">
      <Button
        v-if="props.transcription !== undefined"
        :label="enabled ? '关闭麦克风' : '打开麦克风待命'"
        :variant="enabled ? 'primary' : 'secondary'"
        flex-1
        @click="toggleHearingEnabled"
      />
      <Button
        v-if="autoSend !== undefined"
        :label="autoSend ? '自动发送：开' : '自动发送：关'"
        :variant="autoSend ? 'primary' : 'secondary'"
        flex-1
        @click="autoSend = !autoSend"
      />
    </div>

    <div class="mt-3 w-full">
      <FieldCombobox
        v-model="selectedAudioInput"
        label="输入设备"
        description="选择要给 Lumi 听的麦克风。"
        :options="audioInputs.map(device => ({ label: device.label || '未知设备', value: device.deviceId }))"
        placeholder="选择麦克风"
        layout="vertical"
      />
    </div>
  </div>
</template>
