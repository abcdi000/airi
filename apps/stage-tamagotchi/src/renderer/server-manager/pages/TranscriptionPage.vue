<script setup lang="ts">
import { Button, FieldCheckbox, FieldInput, Textarea } from '@proj-airi/ui'
import { computed, shallowRef } from 'vue'

import ManagerPage from '../components/ManagerPage.vue'

import { SERVER_TRANSCRIPTION_PRESETS } from '../transcription-catalog'
import { useServerManager } from '../useServerManager'

const manager = useServerManager()
const view = shallowRef<'providers' | 'connection' | 'advanced'>('providers')
const provider = computed(() => SERVER_TRANSCRIPTION_PRESETS.find(item => item.id === manager.configDraft.transcriptionProviderId) ?? SERVER_TRANSCRIPTION_PRESETS.at(-1)!)

function selectProvider(id: string) {
  manager.selectTranscriptionProvider(id)
  view.value = 'connection'
}

function selectView(next: typeof view.value) {
  manager.clearNotices()
  view.value = next
}
</script>

<template>
  <ManagerPage title="语音识别" description="配置服务器统一使用的语音转写服务、模型和输入限制。" icon="i-solar:microphone-3-bold-duotone">
    <div :class="['flex w-fit gap-1 rounded-md bg-neutral-100 p-1 dark:bg-neutral-900']">
      <button
        v-for="tab in [
          { id: 'providers', label: '选择服务', icon: 'i-solar:server-square-cloud-bold-duotone' },
          { id: 'connection', label: '连接与模型', icon: 'i-solar:link-circle-bold-duotone' },
          { id: 'advanced', label: '转写参数', icon: 'i-solar:tuning-2-bold-duotone' },
        ]"
        :key="tab.id"
        type="button"
        :class="['relative h-8 px-4 text-sm', view === tab.id ? 'text-cyan-800 dark:text-cyan-200' : 'text-neutral-500']"
        @click="selectView(tab.id as typeof view)"
      >
        <span v-if="view === tab.id" :class="['absolute inset-0 rounded bg-white shadow-sm dark:bg-neutral-800']" />
        <span :class="['relative flex items-center gap-2']"><span :class="[tab.icon, 'inline-block size-4']" />{{ tab.label }}</span>
      </button>
    </div>

    <Transition name="transcription-view" mode="out-in">
      <div :key="view">
        <div v-if="view === 'providers'" :class="['grid grid-cols-2 gap-3 xl:grid-cols-3']">
          <button
            v-for="(item, index) in SERVER_TRANSCRIPTION_PRESETS"
            :key="item.id"
            v-motion
            :initial="{ opacity: 0, y: 8 }"
            :enter="{ opacity: 1, y: 0, transition: { delay: index * 45 } }"
            type="button"
            :class="['flex min-h-24 items-center gap-4 rounded-md border p-4 text-left transition-colors', manager.configDraft.transcriptionProviderId === item.id ? 'border-cyan-400 bg-cyan-50 dark:bg-cyan-950/30' : 'border-neutral-200 hover:border-neutral-400 dark:border-neutral-800']"
            @click="selectProvider(item.id)"
          >
            <span :class="[item.icon, 'inline-block size-9 shrink-0']" />
            <span :class="['min-w-0 flex-1']"><strong :class="['block text-sm']">{{ item.name }}</strong><span :class="['mt-1 block text-xs text-neutral-500']">{{ item.description }}</span></span>
            <span v-if="manager.configDraft.transcriptionProviderId === item.id" :class="['i-solar:check-circle-bold size-5 text-cyan-600']" />
          </button>
        </div>

        <div v-else-if="view === 'connection'" :class="['grid grid-cols-[minmax(0,1fr)_260px] gap-8']">
          <div :class="['space-y-5']">
            <div :class="['flex items-center gap-3 border-b border-neutral-200 pb-4 dark:border-neutral-800']">
              <span :class="[provider.icon, 'inline-block size-9 shrink-0']" />
              <div>
                <div :class="['font-semibold']">
                  {{ provider.name }}
                </div><div :class="['text-xs text-neutral-500']">
                  {{ provider.description }}
                </div>
              </div>
            </div>
            <FieldCheckbox v-model="manager.configDraft.transcriptionEnabled" label="启用服务端语音识别" />
            <FieldInput v-model="manager.configDraft.transcriptionBaseURL" label="API Base URL" />
            <FieldInput v-model="manager.configDraft.transcriptionApiKey" type="password" :placeholder="manager.state.value?.config.transcription.apiKeySet ? '已安全保存，留空保持不变' : '输入 API Key'" label="API Key" />
            <label :class="['flex flex-col gap-1.5 text-sm']">
              <span>转写模型</span>
              <input v-model="manager.configDraft.transcriptionModel" list="server-transcription-models" :class="['h-10 rounded-md border border-neutral-200 bg-transparent px-3 outline-none focus:border-cyan-500 dark:border-neutral-800']">
              <datalist id="server-transcription-models"><option v-for="model in provider.models" :key="model" :value="model" /></datalist>
            </label>
            <div :class="['flex gap-2']">
              <Button label="测试连接" icon="i-solar:test-tube-bold-duotone" :loading="manager.transcriptionBusy.value" @click="manager.testTranscription" />
              <Button variant="secondary" label="保存并应用" icon="i-solar:diskette-bold-duotone" :loading="manager.busy.value" @click="manager.saveTranscription" />
            </div>
          </div>
          <aside :class="['border-l border-neutral-200 pl-6 dark:border-neutral-800']">
            <div :class="['grid size-12 place-items-center rounded-md bg-cyan-50 text-cyan-700 dark:bg-cyan-950/40 dark:text-cyan-300']">
              <span :class="['i-solar:soundwave-bold-duotone size-7']" />
            </div>
            <dl :class="['mt-5 space-y-4 text-sm']">
              <div>
                <dt :class="['text-xs text-neutral-500']">
                  服务商
                </dt><dd>{{ provider.name }}</dd>
              </div>
              <div>
                <dt :class="['text-xs text-neutral-500']">
                  当前模型
                </dt><dd :class="['break-all']">
                  {{ manager.configDraft.transcriptionModel }}
                </dd>
              </div>
              <div>
                <dt :class="['text-xs text-neutral-500']">
                  输入上限
                </dt><dd>{{ manager.configDraft.transcriptionMaxVoiceMB }} MB</dd>
              </div>
            </dl>
          </aside>
        </div>

        <div v-else :class="['max-w-2xl space-y-5']">
          <div :class="['grid grid-cols-2 gap-4']">
            <FieldInput v-model="manager.configDraft.transcriptionLanguage" label="默认语言" placeholder="zh" />
            <FieldInput v-model="manager.configDraft.transcriptionMaxVoiceMB" type="number" label="单次语音上限 MB" />
          </div>
          <Textarea v-model="manager.configDraft.transcriptionPrompt" label="转写提示词" placeholder="可选：人名、游戏名或常用专有词" />
          <Button label="保存转写参数" icon="i-solar:diskette-bold-duotone" :loading="manager.busy.value" @click="manager.saveTranscription" />
        </div>
      </div>
    </Transition>
  </ManagerPage>
</template>

<style scoped>
.transcription-view-enter-active,
.transcription-view-leave-active { transition: opacity 180ms ease, transform 240ms cubic-bezier(.22, 1, .36, 1); }
.transcription-view-enter-from { opacity: 0; transform: translateX(14px); }
.transcription-view-leave-to { opacity: 0; transform: translateX(-8px); }
@media (prefers-reduced-motion: reduce) {
  .transcription-view-enter-active,
  .transcription-view-leave-active { transition-duration: 1ms; }
}
</style>
