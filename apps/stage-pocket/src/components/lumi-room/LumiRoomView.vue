<script setup lang="ts">
import { errorMessageFrom } from '@moeru/std'
import { useAudioRecorder } from '@proj-airi/stage-ui/composables/audio/audio-recorder'
import { useLumiOnlineStore } from '@proj-airi/stage-ui/stores/lumi-online'
import { Button, Callout } from '@proj-airi/ui'
import { storeToRefs } from 'pinia'
import { computed, onUnmounted, shallowRef } from 'vue'
import { useRouter } from 'vue-router'

import LumiRoomComposer from './LumiRoomComposer.vue'
import LumiRoomMessageList from './LumiRoomMessageList.vue'

import { useAudioInput } from '../../composables/audio-input'

const props = defineProps<{ conversationId: string, title?: string }>()
const router = useRouter()
const online = useLumiOnlineStore()
const { conversations, generation, messages, pending, state } = storeToRefs(online)
const conversation = computed(() => conversations.value.find(item => item.id === props.conversationId))
const roomMessages = computed(() => messages.value[props.conversationId] ?? [])
const connected = computed(() => state.value.status === 'online')
const waiting = computed(() => pending.value.filter(item => item.conversationId === props.conversationId).length)
const streaming = computed(() => generation.value[props.conversationId]?.state === 'started' || generation.value[props.conversationId]?.state === 'delta')
const audioInput = useAudioInput()
const { startRecord, stopRecord } = useAudioRecorder(() => audioInput.media.stream.value)
const isRecording = shallowRef(false)
const voiceBusy = shallowRef(false)
const error = shallowRef('')

async function send(text: string) {
  error.value = ''
  try {
    await online.sendText(props.conversationId, text)
  }
  catch (cause) {
    error.value = errorMessageFrom(cause) ?? '消息发送失败'
  }
}

async function startVoice() {
  error.value = ''
  try {
    await audioInput.start()
    await startRecord()
    isRecording.value = true
  }
  catch (cause) {
    audioInput.stop()
    error.value = errorMessageFrom(cause) ?? '无法开始录音'
  }
}

async function stopVoice() {
  if (!isRecording.value)
    return
  isRecording.value = false
  voiceBusy.value = true
  try {
    const recording = await stopRecord()
    audioInput.stop()
    if (!recording)
      throw new Error('没有录到语音')
    await online.sendVoice(props.conversationId, recording)
  }
  catch (cause) {
    audioInput.stop()
    error.value = errorMessageFrom(cause) ?? '语音发送失败'
  }
  finally {
    voiceBusy.value = false
  }
}

async function cancelVoice() {
  if (!isRecording.value)
    return
  isRecording.value = false
  await stopRecord()
  audioInput.stop()
}

onUnmounted(() => {
  if (isRecording.value)
    void cancelVoice()
})
</script>

<template>
  <main :class="['h-100dvh min-h-0 flex flex-col bg-neutral-50 text-neutral-900 dark:bg-neutral-950 dark:text-neutral-100']">
    <header :class="['grid grid-cols-[2.75rem_minmax(0,1fr)_2.75rem] items-center gap-2 border-b border-neutral-200 bg-white px-3 pb-3 pt-[calc(env(safe-area-inset-top,0px)+0.75rem)] dark:border-neutral-800 dark:bg-neutral-950']">
      <Button shape="square" variant="ghost" icon="i-solar:alt-arrow-left-linear" title="返回" @click="router.back()" />
      <div :class="['min-w-0']">
        <h1 :class="['m-0 truncate text-base font-semibold']">
          {{ props.title || conversation?.title || 'Lumi' }}
        </h1>
        <div :class="['mt-0.5 flex items-center gap-1.5 text-xs text-neutral-500']">
          <span :class="['size-2 rounded-full', connected ? 'bg-emerald-500' : 'bg-neutral-400']" />
          <span>{{ connected ? '在线' : state.status === 'reconnecting' ? '正在重连' : '未连接' }}</span>
          <span v-if="waiting">· {{ waiting }} 条待发送</span>
          <span v-if="streaming">· Lumi 正在回复</span>
        </div>
      </div>
      <Button shape="square" variant="ghost" icon="i-solar:refresh-linear" title="同步" @click="online.refresh()" />
    </header>

    <Callout v-if="!conversation" theme="orange" label="无法访问该会话" :class="['m-4']">
      当前账号没有此会话的访问权限。
    </Callout>
    <template v-else>
      <Callout v-if="error || state.error" theme="orange" label="操作失败" :class="['mx-4 mt-3']">
        {{ error || state.error }}
      </Callout>
      <LumiRoomMessageList :events="roomMessages" />
      <div v-if="voiceBusy" :class="['border-t border-sky-200 bg-sky-50 px-4 py-2 text-xs text-sky-800 dark:border-sky-950 dark:bg-sky-950/25 dark:text-sky-200']">
        服务器正在识别语音...
      </div>
      <LumiRoomComposer
        :disabled="!connected || voiceBusy"
        :recording="isRecording"
        @cancel-voice="cancelVoice"
        @send="send"
        @start-voice="startVoice"
        @stop-voice="stopVoice"
      />
    </template>
  </main>
</template>
