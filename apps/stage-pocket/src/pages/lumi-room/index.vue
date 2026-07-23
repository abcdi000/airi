<script setup lang="ts">
import { useLumiOnlineStore } from '@proj-airi/stage-ui/stores/lumi-online'
import { Button, Callout } from '@proj-airi/ui'
import { storeToRefs } from 'pinia'
import { useRouter } from 'vue-router'

const online = useLumiOnlineStore()
const router = useRouter()
const { conversations, state } = storeToRefs(online)
</script>

<template>
  <main :class="['min-h-100dvh bg-neutral-50 px-4 pb-[calc(env(safe-area-inset-bottom,0px)+1rem)] pt-[calc(env(safe-area-inset-top,0px)+1rem)] text-neutral-900 dark:bg-neutral-950 dark:text-neutral-100']">
    <header :class="['mb-5 flex items-center gap-3']">
      <Button shape="square" variant="ghost" icon="i-solar:alt-arrow-left-linear" title="返回" @click="router.back()" />
      <div>
        <h1 :class="['m-0 text-xl font-semibold']">
          Lumi 在线会话
        </h1><p :class="['m-0 mt-1 text-sm text-neutral-500']">
          {{ state.person?.displayName || '未登录' }}
        </p>
      </div>
    </header>
    <Callout v-if="state.status !== 'online'" theme="orange" label="尚未连接">
      <Button class="mt-2" size="sm" label="前往账号" @click="router.push('/settings/account')" />
    </Callout>
    <div v-else :class="['flex flex-col divide-y divide-neutral-200 border-y border-neutral-200 dark:divide-neutral-800 dark:border-neutral-800']">
      <button
        v-for="conversation in conversations"
        :key="conversation.id"
        type="button"
        :class="['flex w-full items-center gap-3 bg-transparent px-1 py-4 text-left']"
        @click="router.push({ path: `/lumi-room/${encodeURIComponent(conversation.id)}`, query: { title: conversation.title } })"
      >
        <span :class="[conversation.type === 'group' ? 'i-solar:users-group-rounded-bold-duotone' : 'i-solar:user-heart-bold-duotone', 'size-6 text-cyan-600']" />
        <span :class="['min-w-0 flex-1']"><span :class="['block truncate font-medium']">{{ conversation.title }}</span><span :class="['block text-xs text-neutral-500']">{{ conversation.type === 'group' ? '共同群聊' : '与 Lumi 私聊' }}</span></span>
        <span class="i-solar:alt-arrow-right-linear size-5 text-neutral-400" />
      </button>
    </div>
  </main>
</template>

<route lang="yaml">
meta:
  layout: plain
</route>
