<script setup lang="ts">
import { errorMessageFrom } from '@moeru/std'
import { useChatOrchestratorStore } from '@proj-airi/stage-ui/stores/chat'
import { useLumiIdentityStore } from '@proj-airi/stage-ui/stores/lumi-identity'
import { Button } from '@proj-airi/ui'
import { storeToRefs } from 'pinia'
import { computed, reactive, ref } from 'vue'
import { toast } from 'vue-sonner'

const identityStore = useLumiIdentityStore()
const chatStore = useChatOrchestratorStore()
const { activeUserId, activeUsers, dbPath, switching } = storeToRefs(identityStore)
const creating = ref(false)
const draft = reactive({ displayName: '', preferredAddress: '' })
const busy = computed(() => chatStore.sending || switching.value)

async function selectUser(userId: string) {
  try {
    await identityStore.selectUser(userId)
    toast.success(`已切换为 ${identityStore.activeUser?.displayName ?? '当前用户'}`)
  }
  catch (error) {
    toast.error(errorMessageFrom(error) ?? String(error))
  }
}

async function createUser() {
  if (!draft.displayName.trim())
    return
  creating.value = true
  try {
    await identityStore.createUser({
      displayName: draft.displayName,
      preferredAddress: draft.preferredAddress || draft.displayName,
    })
    draft.displayName = ''
    draft.preferredAddress = ''
    toast.success('用户已添加')
  }
  catch (error) {
    toast.error(errorMessageFrom(error) ?? String(error))
  }
  finally {
    creating.value = false
  }
}

async function disableUser(userId: string) {
  if (userId === activeUserId.value)
    return
  try {
    await identityStore.updateUser({ id: userId, status: 'inactive' })
    toast.success('用户已停用')
  }
  catch (error) {
    toast.error(errorMessageFrom(error) ?? String(error))
  }
}
</script>

<template>
  <section :class="['border border-neutral-200 dark:border-neutral-800', 'bg-white/60 dark:bg-neutral-950/40', 'rounded-lg p-4']">
    <div :class="['flex items-start justify-between gap-3', 'mb-4']">
      <div>
        <h2 :class="['text-base font-semibold text-neutral-900 dark:text-neutral-100']">
          当前交互用户
        </h2>
        <p :class="['mt-1 text-sm text-neutral-500 dark:text-neutral-400']">
          聊天、记忆、用户印象和短期上下文按身份隔离。
        </p>
      </div>
      <span :class="['text-xs text-neutral-500 dark:text-neutral-400']">
        {{ identityStore.activeUser?.displayName || '载入中' }}
      </span>
    </div>

    <div :class="['grid grid-cols-1 gap-2 sm:grid-cols-2']">
      <div
        v-for="user in activeUsers"
        :key="user.id"
        :class="[
          'flex items-center justify-between gap-3 border p-3 rounded-lg',
          user.id === activeUserId
            ? 'border-cyan-400 bg-cyan-50/70 dark:border-cyan-700 dark:bg-cyan-950/20'
            : 'border-neutral-200 dark:border-neutral-800',
        ]"
      >
        <div :class="['min-w-0']">
          <div :class="['truncate text-sm font-medium text-neutral-900 dark:text-neutral-100']">
            {{ user.displayName }}
          </div>
          <div :class="['truncate text-xs text-neutral-500 dark:text-neutral-400']">
            Lumi 称呼：{{ user.preferredAddress }} · {{ user.role === 'owner' ? '所有者' : '成员' }}
          </div>
        </div>
        <div :class="['flex shrink-0 items-center gap-1']">
          <Button
            v-if="user.id !== activeUserId"
            variant="secondary"
            size="sm"
            icon="i-solar:user-check-rounded-line-duotone"
            label="切换"
            :disabled="busy"
            @click="selectUser(user.id)"
          />
          <Button
            v-if="user.role !== 'owner' && user.id !== activeUserId"
            variant="secondary"
            size="sm"
            icon="i-solar:user-block-rounded-line-duotone"
            :disabled="busy"
            title="停用用户"
            @click="disableUser(user.id)"
          />
        </div>
      </div>
    </div>

    <div :class="['mt-4 grid grid-cols-1 gap-2 sm:grid-cols-[1fr_1fr_auto]']">
      <input
        v-model="draft.displayName"
        :class="['min-w-0 border border-neutral-200 bg-transparent px-3 py-2 text-sm outline-none rounded-lg', 'dark:border-neutral-800']"
        placeholder="显示名称"
        maxlength="80"
      >
      <input
        v-model="draft.preferredAddress"
        :class="['min-w-0 border border-neutral-200 bg-transparent px-3 py-2 text-sm outline-none rounded-lg', 'dark:border-neutral-800']"
        placeholder="Lumi 对其称呼"
        maxlength="80"
      >
      <Button
        variant="secondary"
        icon="i-solar:user-plus-rounded-line-duotone"
        label="添加"
        :loading="creating"
        :disabled="busy || !draft.displayName.trim()"
        @click="createUser"
      />
    </div>

    <p v-if="busy" :class="['mt-3 text-xs text-amber-600 dark:text-amber-400']">
      Lumi 正在回复或执行任务，完成后才能切换身份。
    </p>
    <p :class="['mt-3 truncate text-xs text-neutral-400']" :title="dbPath">
      身份数据库：{{ dbPath }}
    </p>
  </section>
</template>
