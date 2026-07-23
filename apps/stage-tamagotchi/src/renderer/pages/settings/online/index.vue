<script setup lang="ts">
import { errorMessageFrom } from '@moeru/std'
import { useLumiOnlineStore } from '@proj-airi/stage-ui/stores/lumi-online'
import { Button, Callout, FieldInput } from '@proj-airi/ui'
import { storeToRefs } from 'pinia'
import { computed, shallowRef } from 'vue'

const online = useLumiOnlineStore()
const { configuredServerUrl, state } = storeToRefs(online)
const busy = shallowRef(false)
const error = shallowRef('')
const statusLabel = computed(() => ({
  offline: '离线',
  connecting: '连接中',
  online: '已连接',
  reconnecting: '正在重连',
  error: '连接错误',
})[state.value.status])

async function run(action: () => Promise<void>) {
  busy.value = true
  error.value = ''
  try {
    await action()
  }
  catch (cause) {
    error.value = errorMessageFrom(cause) ?? '连接失败'
  }
  finally {
    busy.value = false
  }
}

function reconnect() {
  return run(() => online.reconnect())
}

function useOffline() {
  return run(() => online.useOfflineMode())
}
</script>

<template>
  <div :class="['flex flex-col gap-6 pb-12']">
    <Callout v-if="error || state.error" theme="orange" label="连接失败">
      {{ error || state.error }}
    </Callout>

    <section :class="['flex items-center justify-between gap-4 border-b border-neutral-200 pb-6 dark:border-neutral-800']">
      <div :class="['min-w-0']">
        <div :class="['flex items-center gap-2']">
          <span
            :class="[
              'size-2 rounded-full',
              state.status === 'online' ? 'bg-emerald-500' : state.status === 'error' ? 'bg-red-500' : 'bg-neutral-400',
            ]"
          />
          <span :class="['font-semibold']">{{ statusLabel }}</span>
        </div>
        <div :class="['mt-1 truncate text-sm text-neutral-500 dark:text-neutral-400']">
          {{ state.person?.displayName ?? '未登录' }}
        </div>
      </div>
      <Button
        v-if="state.person"
        variant="secondary"
        icon="i-solar:refresh-bold-duotone"
        label="重连"
        :loading="busy"
        @click="reconnect"
      />
    </section>

    <section :class="['flex flex-col gap-4 border-b border-neutral-200 pb-6 dark:border-neutral-800']">
      <FieldInput v-model="configuredServerUrl" label="服务器地址" placeholder="https://lumi.example.com" />
      <Callout v-if="configuredServerUrl.startsWith('http://') && !configuredServerUrl.includes('127.0.0.1') && !configuredServerUrl.includes('localhost')" theme="orange" label="需要加密连接">
        非本机服务器必须使用 HTTPS/WSS。
      </Callout>
      <div v-if="state.capabilities" :class="['grid grid-cols-2 gap-3 text-sm']">
        <div>协议 v{{ state.capabilities.protocolVersion }}</div>
        <div>Server {{ state.capabilities.serverVersion }}</div>
        <div>消息上限 {{ state.capabilities.maxTextLength }}</div>
        <div>{{ state.capabilities.voiceInput ? '支持服务器语音识别' : '未启用服务器语音识别' }}</div>
      </div>
    </section>

    <section :class="['flex items-center justify-between gap-4']">
      <div>
        <div :class="['font-medium']">
          本机模式
        </div>
        <div :class="['text-sm text-neutral-500 dark:text-neutral-400']">
          切换后使用“机体模块”中的本机配置与独立数据，不会同步在线历史。
        </div>
      </div>
      <Button variant="secondary" icon="i-solar:cloud-cross-bold-duotone" label="切换到本机模式" :loading="busy" @click="useOffline" />
    </section>
  </div>
</template>

<route lang="yaml">
meta:
  layout: settings
  title: 在线连接
  subtitle: 设置
  description: 连接唯一的 Lumi Server
  icon: i-solar:server-square-cloud-bold-duotone
  settingsEntry: true
  order: 1
  stageTransition:
    name: slide
</route>
