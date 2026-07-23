<script setup lang="ts">
import { errorMessageFrom } from '@moeru/std'
import { useLumiOnlineStore } from '@proj-airi/stage-ui/stores/lumi-online'
import { Button, Callout, FieldInput } from '@proj-airi/ui'
import { storeToRefs } from 'pinia'
import { computed, shallowRef } from 'vue'
import { useRouter } from 'vue-router'

const online = useLumiOnlineStore()
const router = useRouter()
const { configuredServerUrl, state } = storeToRefs(online)
const busy = shallowRef(false)
const error = shallowRef('')
const remotePlaintext = computed(() => configuredServerUrl.value.startsWith('http://') && !/localhost|127\.0\.0\.1|\[::1\]/.test(configuredServerUrl.value))

async function reconnect() {
  busy.value = true
  error.value = ''
  try {
    await online.reconnect('Lumi Pocket')
  }
  catch (cause) {
    error.value = errorMessageFrom(cause) ?? '连接失败'
  }
  finally {
    busy.value = false
  }
}
</script>

<template>
  <div :class="['flex flex-col gap-5 pb-12']">
    <Callout v-if="error || state.error" theme="orange" label="连接失败">{{ error || state.error }}</Callout>
    <section :class="['flex items-center justify-between gap-4 border-b border-neutral-200 pb-5 dark:border-neutral-800']">
      <div>
        <div :class="['flex items-center gap-2 font-semibold']"><span :class="['size-2 rounded-full', state.status === 'online' ? 'bg-emerald-500' : 'bg-neutral-400']" />{{ state.status }}</div>
        <div :class="['mt-1 text-sm text-neutral-500']">{{ state.person?.displayName || '未登录' }}</div>
      </div>
      <Button variant="secondary" icon="i-solar:refresh-bold-duotone" label="重连" :loading="busy" :disabled="!state.person" @click="reconnect" />
    </section>
    <FieldInput v-model="configuredServerUrl" label="Lumi Server 地址" placeholder="https://lumi.example.com" />
    <Callout v-if="remotePlaintext" theme="orange" label="远程连接必须加密">请使用 HTTPS/WSS 域名、反向代理或隧道地址。</Callout>
    <Button variant="secondary" icon="i-solar:user-circle-bold-duotone" label="前往账号" @click="router.push('/settings/account')" />
  </div>
</template>

<route lang="yaml">
meta:
  layout: settings
  title: 在线连接
  subtitle: 设置
  description: 配置唯一的 Lumi Server
  icon: i-solar:server-square-cloud-bold-duotone
  settingsEntry: true
  order: 1
  stageTransition:
    name: slide
</route>
