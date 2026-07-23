<script setup lang="ts">
import { Button, Callout, FieldInput } from '@proj-airi/ui'

import ManagerPage from '../components/ManagerPage.vue'

import { useServerManager } from '../useServerManager'

const manager = useServerManager()
</script>

<template>
  <ManagerPage title="用户与邀请" description="创建 Lumi 账号、发放一次性邀请，并管理已经登录的设备。" icon="i-solar:users-group-rounded-bold-duotone">
    <div :class="['grid grid-cols-2 gap-4 border-b border-neutral-200 pb-7 dark:border-neutral-800']">
      <FieldInput v-model="manager.doggy.username" label="Doggy 管理员用户名" />
      <FieldInput v-model="manager.doggy.password" type="password" label="初始密码" />
      <Button label="创建 Doggy 管理员" icon="i-solar:user-plus-bold-duotone" :disabled="!manager.running.value" @click="manager.bootstrapDoggy" />
      <Button variant="secondary" label="生成 Moussy 邀请码" icon="i-solar:ticket-bold-duotone" :disabled="!manager.running.value" @click="manager.createMoussyInvitation" />
    </div>
    <Callout v-if="manager.invitation.value?.code" theme="lime" label="一次性邀请码">
      <div :class="['select-all break-all font-mono text-sm']">
        {{ manager.invitation.value.code }}
      </div>
      <div :class="['mt-1 text-xs opacity-70']">
        有效期至 {{ new Date(manager.invitation.value.expiresAt ?? 0).toLocaleString() }}
      </div>
    </Callout>
    <div>
      <h2 :class="['mb-2 text-sm font-semibold']">
        人物账号
      </h2>
      <div :class="['divide-y divide-neutral-200 border-y border-neutral-200 dark:divide-neutral-800 dark:border-neutral-800']">
        <div v-for="user in manager.users.value" :key="user.id" :class="['flex items-center justify-between py-4']">
          <div>
            <div :class="['font-medium']">
              {{ user.displayName }}
            </div><div :class="['text-xs text-neutral-500']">
              {{ user.role === 'owner' ? '管理员' : '成员' }} · {{ user.accountBound ? '账号已绑定' : '等待领取邀请' }}
            </div>
          </div>
          <span :class="[user.accountBound ? 'i-solar:verified-check-bold text-emerald-600' : 'i-solar:clock-circle-bold text-neutral-400', 'size-5']" />
        </div>
        <div v-if="manager.users.value.length === 0" :class="['py-5 text-sm text-neutral-500']">
          尚未创建在线人物。
        </div>
      </div>
    </div>
    <div>
      <h2 :class="['mb-2 text-sm font-semibold']">
        登录设备
      </h2>
      <div :class="['divide-y divide-neutral-200 border-y border-neutral-200 dark:divide-neutral-800 dark:border-neutral-800']">
        <div v-for="device in manager.devices.value" :key="device.id" :class="['flex items-center justify-between py-4']">
          <div>
            <div :class="['font-medium']">
              {{ device.name }}
            </div><div :class="['text-xs text-neutral-500']">
              {{ device.platform }} · {{ device.revokedAt ? '已撤销' : '有效' }} · {{ new Date(device.lastSeenAt).toLocaleString() }}
            </div>
          </div>
          <Button v-if="!device.revokedAt" size="sm" variant="secondary" label="撤销" icon="i-solar:shield-cross-bold-duotone" @click="manager.revokeDevice(device)" />
        </div>
        <div v-if="manager.devices.value.length === 0" :class="['py-5 text-sm text-neutral-500']">
          还没有客户端登录。
        </div>
      </div>
    </div>
  </ManagerPage>
</template>
