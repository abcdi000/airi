<script setup lang="ts">
import type {
  ElectronLumiAstrBotGatewayConfig,
  ElectronLumiAstrBotIdentityBinding,
} from '../../../../../shared/eventa'

import { errorMessageFrom } from '@moeru/std'
import { Button, Callout, FieldInput } from '@proj-airi/ui'
import { computed, onMounted, reactive, shallowRef } from 'vue'

import AstrBotGatewayStatus from './components/AstrBotGatewayStatus.vue'
import AstrBotIdentityBindingsEditor from './components/AstrBotIdentityBindingsEditor.vue'

import { useLocalAstrBotGateway } from './useLocalAstrBotGateway'

const gateway = useLocalAstrBotGateway()
const copied = shallowRef(false)
const localError = shallowRef('')
const draft = reactive<ElectronLumiAstrBotGatewayConfig>({
  enabled: false,
  port: 6132,
  apiToken: '',
  identityBindings: [],
})

const endpoint = computed(() => `http://127.0.0.1:${draft.port}`)

function applyState() {
  if (!gateway.state.value)
    return
  Object.assign(draft, {
    ...gateway.state.value.config,
    identityBindings: gateway.state.value.config.identityBindings.map(binding => ({ ...binding })),
  })
}

async function load() {
  localError.value = ''
  try {
    await gateway.load()
    applyState()
  }
  catch (error) {
    localError.value = errorMessageFrom(error) ?? '无法读取 AstrBot 接入配置'
  }
}

async function save() {
  localError.value = ''
  try {
    await gateway.save({
      ...draft,
      identityBindings: draft.identityBindings.map(binding => ({ ...binding })),
    })
    applyState()
  }
  catch (error) {
    localError.value = errorMessageFrom(error) ?? '无法保存 AstrBot 接入配置'
  }
}

async function rotateToken() {
  localError.value = ''
  try {
    await gateway.rotateToken()
    applyState()
    copied.value = false
  }
  catch (error) {
    localError.value = errorMessageFrom(error) ?? '无法轮换集成令牌'
  }
}

async function copyToken() {
  await navigator.clipboard.writeText(draft.apiToken)
  copied.value = true
  setTimeout(() => {
    copied.value = false
  }, 2_000)
}

function updateBindings(bindings: ElectronLumiAstrBotIdentityBinding[]) {
  draft.identityBindings = bindings
}

onMounted(load)
</script>

<template>
  <div :class="['flex flex-col gap-6 pb-12']">
    <Callout v-if="localError || gateway.error.value" theme="orange" label="AstrBot 接入错误">
      {{ localError || gateway.error.value }}
    </Callout>

    <Callout
      v-if="gateway.state.value?.runtimeMode === 'online-client'"
      theme="orange"
      label="当前使用 Lumi Server"
    >
      本地 AstrBot 网关仅调用离线客户端中的机体模块。注销在线账号并切换到本地模式后，网关会恢复处理。
    </Callout>

    <AstrBotGatewayStatus
      v-motion
      :state="gateway.state.value"
      :enabled="draft.enabled"
      :disabled="gateway.busy.value"
      :initial="{ opacity: 0, y: 8 }"
      :enter="{ opacity: 1, y: 0 }"
      :duration="220"
      @update:enabled="draft.enabled = $event"
    />

    <section
      v-motion
      :class="['flex flex-col gap-4 border-b border-neutral-200 pb-6 dark:border-neutral-800']"
      :initial="{ opacity: 0, y: 10 }"
      :enter="{ opacity: 1, y: 0 }"
      :duration="260"
      :delay="40"
    >
      <div>
        <h2 :class="['text-base font-semibold']">
          本地连接与令牌
        </h2>
        <p :class="['mt-1 text-sm text-neutral-500 dark:text-neutral-400']">
          AstrBot 和桌面 Lumi 在同一台电脑运行时，使用下面的地址和令牌。网关不会暴露到局域网。
        </p>
      </div>
      <div :class="['grid grid-cols-2 gap-4']">
        <FieldInput
          :model-value="String(draft.port)"
          label="本地端口"
          inputmode="numeric"
          :disabled="gateway.busy.value"
          @update:model-value="draft.port = Number($event)"
        />
        <FieldInput :model-value="endpoint" label="插件连接地址" readonly />
      </div>
      <FieldInput :model-value="draft.apiToken" label="集成令牌" type="password" readonly />
      <div :class="['flex flex-wrap gap-3']">
        <Button
          variant="secondary"
          icon="i-solar:copy-bold-duotone"
          :label="copied ? '已复制' : '复制令牌'"
          :disabled="!draft.apiToken"
          @click="copyToken"
        />
        <Button
          variant="secondary"
          icon="i-solar:key-minimalistic-square-3-bold-duotone"
          label="轮换令牌"
          :loading="gateway.busy.value"
          @click="rotateToken"
        />
      </div>
    </section>

    <section
      v-motion
      :class="['flex flex-col gap-5']"
      :initial="{ opacity: 0, y: 10 }"
      :enter="{ opacity: 1, y: 0 }"
      :duration="260"
      :delay="80"
    >
      <div>
        <h2 :class="['text-base font-semibold']">
          已确认身份
        </h2>
        <p :class="['mt-1 text-sm text-neutral-500 dark:text-neutral-400']">
          只有这里绑定的私聊账号能进入本地 Lumi。群聊和未知账号始终不会触发。
        </p>
      </div>
      <AstrBotIdentityBindingsEditor
        :bindings="draft.identityBindings"
        :disabled="gateway.busy.value"
        @update:bindings="updateBindings"
      />
    </section>

    <div :class="['sticky bottom-4 flex justify-end border-t border-neutral-200 bg-white/90 pt-4 backdrop-blur dark:border-neutral-800 dark:bg-neutral-950/90']">
      <Button
        icon="i-solar:diskette-bold-duotone"
        label="保存并应用"
        :loading="gateway.busy.value"
        @click="save"
      />
    </div>
  </div>
</template>

<route lang="yaml">
meta:
  layout: settings
  title: AstrBot 接入
  subtitle: 设置
  description: 让 QQ 私聊使用本机离线 Lumi 的意识与机体模块
  icon: i-solar:chat-round-line-bold-duotone
  settingsEntry: true
  order: 2
  stageTransition:
    name: slide
</route>
