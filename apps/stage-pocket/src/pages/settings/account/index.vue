<script setup lang="ts">
import { errorMessageFrom } from '@moeru/std'
import { useLumiOnlineStore } from '@proj-airi/stage-ui/stores/lumi-online'
import { Button, Callout, FieldInput } from '@proj-airi/ui'
import { storeToRefs } from 'pinia'
import { computed, shallowRef } from 'vue'
import { useRouter } from 'vue-router'

const online = useLumiOnlineStore()
const router = useRouter()
const { configuredServerUrl, deviceId, devices, state } = storeToRefs(online)
const username = shallowRef('')
const password = shallowRef('')
const invitationCode = shallowRef('')
const busy = shallowRef(false)
const error = shallowRef('')
const signedIn = computed(() => Boolean(state.value.person))

async function run(action: () => Promise<void>) {
  busy.value = true
  error.value = ''
  try {
    await action()
    password.value = ''
    invitationCode.value = ''
  }
  catch (cause) {
    error.value = errorMessageFrom(cause) ?? '账号操作失败'
  }
  finally {
    busy.value = false
  }
}

function login() {
  return run(() => online.login({ serverUrl: configuredServerUrl.value, username: username.value, password: password.value, deviceName: 'Lumi Pocket' }))
}

function claim() {
  return run(() => online.claimInvitation({ serverUrl: configuredServerUrl.value, invitationCode: invitationCode.value, username: username.value, password: password.value, deviceName: 'Lumi Pocket' }))
}
</script>

<template>
  <div :class="['flex flex-col gap-6 pb-12']">
    <Callout v-if="error" theme="orange" label="账号操作失败">{{ error }}</Callout>
    <template v-if="signedIn">
      <section :class="['flex items-center justify-between gap-4 border-b border-neutral-200 pb-5 dark:border-neutral-800']">
        <div :class="['min-w-0']">
          <div :class="['truncate text-lg font-semibold']">{{ state.person?.displayName }}</div>
          <div :class="['text-sm text-neutral-500']">{{ state.person?.role === 'owner' ? '管理员' : '成员' }}</div>
        </div>
        <Button variant="secondary" icon="i-solar:logout-2-bold-duotone" label="注销" :loading="busy" @click="run(() => online.logout())" />
      </section>
      <section :class="['flex flex-col gap-3']">
        <div v-for="device in devices" :key="device.id" :class="['flex items-center justify-between gap-3 border-b border-neutral-200 py-3 dark:border-neutral-800']">
          <div :class="['min-w-0']">
            <div :class="['truncate text-sm font-medium']">{{ device.name }} <span v-if="device.id === deviceId" class="text-emerald-600">当前设备</span></div>
            <div :class="['text-xs text-neutral-500']">{{ device.platform }} · {{ new Date(device.lastSeenAt).toLocaleString() }}</div>
          </div>
          <Button size="sm" variant="secondary" icon="i-solar:shield-cross-bold-duotone" label="撤销" @click="run(() => online.revokeDevice(device.id))" />
        </div>
      </section>
      <Button icon="i-solar:chat-round-dots-bold-duotone" label="进入在线会话" @click="router.push('/lumi-room')" />
    </template>
    <template v-else>
      <FieldInput v-model="username" label="用户名" autocomplete="username" />
      <FieldInput v-model="password" label="密码" type="password" autocomplete="current-password" />
      <Button icon="i-solar:login-3-bold-duotone" label="登录" :loading="busy" @click="login" />
      <div :class="['border-t border-neutral-200 pt-5 dark:border-neutral-800']">
        <FieldInput v-model="invitationCode" label="一次性邀请码" />
        <Button :class="['mt-3']" variant="secondary" icon="i-solar:ticket-bold-duotone" label="领取邀请并登录" :loading="busy" @click="claim" />
      </div>
    </template>
  </div>
</template>

<route lang="yaml">
meta:
  layout: settings
  title: Lumi 账号
  subtitle: 设置
  description: 登录 Doggy 或 Moussy 账号
  icon: i-solar:user-circle-bold-duotone
  settingsEntry: true
  order: 0
  stageTransition:
    name: slide
</route>
