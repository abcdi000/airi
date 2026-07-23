<script setup lang="ts">
import { errorMessageFrom } from '@moeru/std'
import { useLumiOnlineStore } from '@proj-airi/stage-ui/stores/lumi-online'
import { Button, Callout, FieldInput } from '@proj-airi/ui'
import { storeToRefs } from 'pinia'
import { computed, shallowRef } from 'vue'

const online = useLumiOnlineStore()
const { configuredServerUrl, deviceId, devices, runtimeMode, state } = storeToRefs(online)
const username = shallowRef('')
const password = shallowRef('')
const invitationCode = shallowRef('')
const busy = shallowRef(false)
const error = shallowRef('')
const signedIn = computed(() => Boolean(state.value.person))
const status = computed(() => ({
  offline: { label: '本机模式', color: 'bg-neutral-400', detail: '未连接 Lumi Server' },
  connecting: { label: '连接中', color: 'bg-amber-500', detail: '正在验证账号与服务器协议' },
  online: { label: '在线', color: 'bg-emerald-500', detail: '消息与在线数据由服务器处理' },
  reconnecting: { label: '重连中', color: 'bg-amber-500', detail: '正在恢复连接与未确认消息' },
  error: { label: '连接异常', color: 'bg-red-500', detail: state.value.error || '无法连接 Lumi Server' },
})[state.value.status])

async function run(action: () => Promise<void>) {
  busy.value = true
  error.value = ''
  try {
    await action()
    password.value = ''
    invitationCode.value = ''
  }
  catch (cause) {
    error.value = errorMessageFrom(cause) ?? '操作失败'
  }
  finally {
    busy.value = false
  }
}

function login() {
  return run(() => online.login({ serverUrl: configuredServerUrl.value, username: username.value, password: password.value }))
}

function claimInvitation() {
  return run(() => online.claimInvitation({
    serverUrl: configuredServerUrl.value,
    invitationCode: invitationCode.value,
    username: username.value,
    password: password.value,
  }))
}

function logout() {
  return run(() => online.logout())
}

function reconnect() {
  return run(() => online.reconnect())
}

function revokeDevice(targetDeviceId: string) {
  return run(() => online.revokeDevice(targetDeviceId))
}
</script>

<template>
  <div :class="['flex flex-col gap-6 pb-12']">
    <Callout v-if="error" theme="orange" label="账号操作失败">
      {{ error }}
    </Callout>

    <section :class="['flex items-center justify-between gap-5 border-b border-neutral-200 pb-6 dark:border-neutral-800']">
      <div :class="['flex min-w-0 items-center gap-3']">
        <span :class="['relative grid size-11 shrink-0 place-items-center rounded-md bg-neutral-100 dark:bg-neutral-900']">
          <span :class="['i-solar:user-circle-bold-duotone size-7 text-neutral-600 dark:text-neutral-300']" />
          <span :class="['absolute -bottom-1 -right-1 size-3 rounded-full border-2 border-white dark:border-neutral-950', status.color, ['connecting', 'reconnecting'].includes(state.status) && 'animate-pulse']" />
        </span>
        <div :class="['min-w-0']">
          <div :class="['flex items-center gap-2']">
            <strong>{{ status.label }}</strong>
            <span v-if="runtimeMode === 'online-client'" :class="['rounded bg-cyan-50 px-2 py-0.5 text-xs text-cyan-700 dark:bg-cyan-950/50 dark:text-cyan-300']">在线模式</span>
          </div>
          <div :class="['mt-0.5 truncate text-sm text-neutral-500 dark:text-neutral-400']">{{ status.detail }}</div>
        </div>
      </div>
      <Button v-if="signedIn && state.status !== 'online'" variant="secondary" icon="i-solar:refresh-bold-duotone" label="重新连接" :loading="busy" @click="reconnect" />
    </section>

    <section v-if="signedIn" :class="['flex flex-col gap-5 border-b border-neutral-200 pb-6 dark:border-neutral-800']">
      <div :class="['flex items-center justify-between gap-4']">
        <div :class="['min-w-0']">
          <div :class="['truncate text-xl font-semibold']">
            {{ state.person?.displayName }}
          </div>
          <div :class="['text-sm text-neutral-500 dark:text-neutral-400']">
            {{ state.person?.role === 'owner' ? '服务器管理员' : '成员账号' }}
          </div>
        </div>
        <Button variant="secondary" icon="i-solar:logout-2-bold-duotone" label="注销并切换到本机模式" :loading="busy" @click="logout" />
      </div>
      <dl :class="['grid grid-cols-2 gap-x-6 gap-y-4 border-y border-neutral-200 py-4 text-sm dark:border-neutral-800']">
        <div><dt :class="['text-xs text-neutral-500']">人物身份</dt><dd :class="['mt-1 break-all']">{{ state.person?.id }}</dd></div>
        <div><dt :class="['text-xs text-neutral-500']">服务器</dt><dd :class="['mt-1 break-all']">{{ state.serverUrl || configuredServerUrl }}</dd></div>
        <div><dt :class="['text-xs text-neutral-500']">服务器版本</dt><dd :class="['mt-1']">{{ state.capabilities?.serverVersion || '连接后获取' }}</dd></div>
        <div><dt :class="['text-xs text-neutral-500']">当前设备</dt><dd :class="['mt-1 break-all']">{{ deviceId }}</dd></div>
      </dl>
      <h2 :class="['text-sm font-semibold']">已登录设备</h2>
      <div :class="['divide-y divide-neutral-200 border-t border-neutral-200 dark:divide-neutral-800 dark:border-neutral-800']">
        <div v-for="device in devices" :key="device.id" :class="['flex items-center justify-between gap-4 py-3']">
          <div :class="['min-w-0']">
            <div :class="['truncate text-sm font-medium']">{{ device.name }} <span v-if="device.id === deviceId" :class="['text-emerald-600']">当前设备</span></div>
            <div :class="['text-xs text-neutral-500']">{{ device.platform }} · {{ new Date(device.lastSeenAt).toLocaleString() }}</div>
          </div>
          <Button variant="secondary" size="sm" icon="i-solar:shield-cross-bold-duotone" label="撤销" :loading="busy" @click="revokeDevice(device.id)" />
        </div>
      </div>
    </section>

    <template v-else>
      <Callout theme="primary" label="本机 Lumi 可直接使用">
        未登录时，Lumi 使用“机体模块”中的本机服务商、语音、视觉、插件和工具配置。
      </Callout>
      <section :class="['flex flex-col gap-4 border-b border-neutral-200 pb-6 dark:border-neutral-800']">
        <div>
          <h2 :class="['text-base font-semibold']">登录 Lumi Server</h2>
          <p :class="['mt-1 text-sm text-neutral-500 dark:text-neutral-400']">使用服务器上已有的 Doggy 或 Moussy 账号。</p>
        </div>
        <FieldInput v-model="configuredServerUrl" label="服务器地址" placeholder="http://127.0.0.1:6130" />
        <FieldInput v-model="username" label="用户名" autocomplete="username" />
        <FieldInput v-model="password" label="密码" type="password" autocomplete="current-password" />
        <div>
          <Button icon="i-solar:login-3-bold-duotone" label="登录" :loading="busy" @click="login" />
        </div>
      </section>

      <section :class="['flex flex-col gap-4']">
        <div>
          <h2 :class="['text-base font-semibold']">领取邀请</h2>
          <p :class="['mt-1 text-sm text-neutral-500 dark:text-neutral-400']">首次加入时使用 Doggy 在 Server Manager 中生成的一次性邀请码。</p>
        </div>
        <FieldInput v-model="invitationCode" label="邀请码" />
        <div>
          <Button variant="secondary" icon="i-solar:ticket-bold-duotone" label="创建账号并登录" :loading="busy" @click="claimInvitation" />
        </div>
      </section>
    </template>
  </div>
</template>

<route lang="yaml">
meta:
  layout: settings
  title: Lumi 账号
  subtitle: 设置
  description: 登录 Doggy 或 Moussy 的 Lumi Server 账号
  icon: i-solar:user-circle-bold-duotone
  settingsEntry: true
  order: 0
  stageTransition:
    name: slide
</route>
