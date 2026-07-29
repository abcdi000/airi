<script setup lang="ts">
import type { LanguageLearningConfig } from '@proj-airi/stage-ui/stores/lumi-social-language'

import { useLumiSocialLanguageStore } from '@proj-airi/stage-ui/stores/lumi-social-language'
import { FieldCheckbox, FieldRange, SelectTab } from '@proj-airi/ui'
import { storeToRefs } from 'pinia'
import { computed, onMounted, shallowRef } from 'vue'

import AgentRuntimeSettingsPanel from './components/AgentRuntimeSettingsPanel.vue'
import ContextContinuityPanel from './components/ContextContinuityPanel.vue'
import LanguageAssetsPanel from './components/LanguageAssetsPanel.vue'
import PromptInspector from './components/PromptInspector.vue'
import StickerLibraryManager from './components/StickerLibraryManager.vue'

type PageTab = 'assets' | 'stickers' | 'prompt' | 'context' | 'runtime' | 'settings'

const store = useLumiSocialLanguageStore()
const { config, snapshot } = storeToRefs(store)
const activeTab = shallowRef<PageTab>('assets')

const candidateCount = computed(() => snapshot.value.expressions.filter(item => item.status === 'observed').length)
const expressionCount = computed(() => snapshot.value.expressions.filter(item =>
  item.status !== 'observed' && item.status !== 'forgotten',
).length)
const habitCount = computed(() => snapshot.value.expressions.filter(item => item.status === 'habit').length)
const feedbackCount = computed(() => snapshot.value.decisions.filter(item => item.laterFeedback).length)

const tabs = [
  { label: '学习资产', value: 'assets', icon: 'i-solar:library-bold-duotone' },
  { label: '表情包', value: 'stickers', icon: 'i-solar:sticker-smile-circle-2-bold-duotone' },
  { label: 'Prompt', value: 'prompt', icon: 'i-solar:code-square-bold-duotone' },
  { label: '上下文', value: 'context', icon: 'i-solar:layers-minimalistic-bold-duotone' },
  { label: '运行时', value: 'runtime', icon: 'i-solar:branching-paths-up-bold-duotone' },
  { label: '学习设置', value: 'settings', icon: 'i-solar:tuning-square-2-bold-duotone' },
]

function setting<K extends keyof LanguageLearningConfig>(key: K) {
  return computed<LanguageLearningConfig[K]>({
    get: () => config.value[key],
    set: value => store.updateConfig({ [key]: value }),
  })
}

const enabled = setting('enabled')
const directLanguageCandidateLearningEnabled = setting('directLanguageCandidateLearningEnabled')
const groupExpressionLearningEnabled = setting('groupExpressionLearningEnabled')
const groupJargonLearningEnabled = setting('groupJargonLearningEnabled')
const groupBehaviorLearningEnabled = setting('groupBehaviorLearningEnabled')
const groupPublicKnowledgeLearningEnabled = setting('groupPublicKnowledgeLearningEnabled')
const expressionLearningEnabled = setting('expressionLearningEnabled')
const behaviorLearningEnabled = setting('behaviorLearningEnabled')
const jargonLearningEnabled = setting('jargonLearningEnabled')
const selfExpressionLearningEnabled = setting('selfExpressionLearningEnabled')
const globalDiffusionEnabled = setting('globalDiffusionEnabled')
const preciseSelectorEnabled = setting('preciseSelectorEnabled')
const feedbackLearningEnabled = setting('feedbackLearningEnabled')
const promptLoggingEnabled = setting('promptLoggingEnabled')
const multiMessageReplyEnabled = setting('multiMessageReplyEnabled')
const maxSelectedExpressions = setting('maxSelectedExpressions')
const vectorCandidateLimit = setting('vectorCandidateLimit')

onMounted(() => {
  void store.initialize()
})
</script>

<template>
  <div :class="['mx-auto flex max-w-5xl flex-col gap-7 pb-16']">
    <section
      v-motion
      :initial="{ opacity: 0, y: 8 }"
      :enter="{ opacity: 1, y: 0 }"
      :duration="220"
      :class="['grid grid-cols-2 gap-x-6 gap-y-4 border-b border-neutral-200 pb-6 md:grid-cols-4 dark:border-neutral-800']"
    >
      <button :class="['text-left']" @click="activeTab = 'assets'">
        <div :class="['text-xs text-neutral-500']">
          待积累候选
        </div>
        <div :class="['mt-1 text-2xl font-semibold tabular-nums']">
          {{ candidateCount }}
        </div>
      </button>
      <button :class="['text-left']" @click="activeTab = 'assets'">
        <div :class="['text-xs text-neutral-500']">
          可用表达
        </div>
        <div :class="['mt-1 text-2xl font-semibold tabular-nums']">
          {{ expressionCount }}
        </div>
      </button>
      <button :class="['text-left']" @click="activeTab = 'assets'">
        <div :class="['text-xs text-neutral-500']">
          已内化习惯
        </div>
        <div :class="['mt-1 text-2xl font-semibold tabular-nums']">
          {{ habitCount }}
        </div>
      </button>
      <button :class="['text-left']" @click="activeTab = 'assets'">
        <div :class="['text-xs text-neutral-500']">
          已收到反馈
        </div>
        <div :class="['mt-1 text-2xl font-semibold tabular-nums']">
          {{ feedbackCount }}
        </div>
      </button>
    </section>

    <div
      :class="[
        'sticky top-0 z-98',
        'overflow-x-auto py-2',
      ]"
      bg="$bg-color"
    >
      <SelectTab v-model="activeTab" :options="tabs" size="sm" tab-space="compact" />
    </div>

    <Transition name="language-page" mode="out-in">
      <LanguageAssetsPanel v-if="activeTab === 'assets'" key="assets" />
      <StickerLibraryManager v-else-if="activeTab === 'stickers'" key="stickers" />
      <PromptInspector v-else-if="activeTab === 'prompt'" key="prompt" />
      <ContextContinuityPanel v-else-if="activeTab === 'context'" key="context" />
      <AgentRuntimeSettingsPanel v-else-if="activeTab === 'runtime'" key="runtime" />
      <div v-else key="settings" :class="['flex flex-col gap-8']">
        <section :class="['flex flex-col gap-5 border-b border-neutral-200 pb-8 dark:border-neutral-800']">
          <div>
            <h2 :class="['text-lg font-semibold']">
              学习范围
            </h2>
            <p :class="['mt-1 text-sm text-neutral-500']">
              学习只影响最终措辞和参与节奏，不会覆盖 Lumi 的人格、事实、权限、隐私或防御边界。
            </p>
          </div>
          <FieldCheckbox v-model="enabled" label="启用语言学习与独立回复器" description="关闭后不再学习新表达，当前对话回到原有生成链路。" />
          <FieldCheckbox
            v-model="directLanguageCandidateLearningEnabled"
            :disabled="!enabled"
            label="允许私聊创建新的语言候选（兼容模式）"
            description="默认关闭。私聊仍会反馈和调整已有候选；新的口癖、黑话与互动行为只从已授权学习群获得。"
          />
          <div :class="['mt-2 border-l-2 border-cyan-400/45 pl-4']">
            <h3 :class="['text-sm font-semibold']">
              授权学习群的独立归纳器
            </h3>
            <p :class="['mt-1 text-xs text-neutral-500']">
              四类知识独立归纳和重试。关闭其中一类不会阻塞或清除其他学习成果。
            </p>
          </div>
          <FieldCheckbox v-model="groupExpressionLearningEnabled" :disabled="!enabled" label="归纳群聊表达" description="学习口癖、短句、标点和自然的多消息节奏。" />
          <FieldCheckbox v-model="groupJargonLearningEnabled" :disabled="!enabled" label="归纳群聊黑话" description="理解网络用语在当前语境里的实际含义。" />
          <FieldCheckbox v-model="groupBehaviorLearningEnabled" :disabled="!enabled" label="归纳群聊互动行为" description="学习何时接话、追问、吐槽或保持沉默。" />
          <FieldCheckbox v-model="groupPublicKnowledgeLearningEnabled" :disabled="!enabled" label="归纳群聊公共知识" description="仅保存可公开分享且有当前批次消息证据的群体知识。" />
          <FieldCheckbox v-model="expressionLearningEnabled" :disabled="!enabled" label="学习口语与表达节奏" description="从确认作者的真实聊天中学习口癖、短句、标点和多消息节奏。" />
          <FieldCheckbox v-model="jargonLearningEnabled" :disabled="!enabled" label="理解黑话和网络用语" description="语用含义保存在独立语言知识中，不混入事实记忆。" />
          <FieldCheckbox v-model="behaviorLearningEnabled" :disabled="!enabled" label="学习互动行为" description="学习何时简短回应、追问、吐槽或保持沉默。" />
          <FieldCheckbox v-model="selfExpressionLearningEnabled" :disabled="!enabled" label="允许 Lumi 内化自己的成功表达" description="Lumi 的原创说法先成为候选，获得后续正向反馈后逐步内化。" />
          <FieldCheckbox v-model="feedbackLearningEnabled" :disabled="!enabled" label="根据后续聊天调整权重" description="赞同、复述、继续玩梗或明确拒绝会影响熟悉度和内化程度；沉默不算失败。" />
          <FieldCheckbox v-model="globalDiffusionEnabled" :disabled="!enabled" label="允许成熟表达跨场景扩散" description="只调整表达使用概率，不会跨用户泄露私聊事实或关系记忆。" />
        </section>

        <section :class="['flex flex-col gap-6']">
          <div>
            <h2 :class="['text-lg font-semibold']">
              选择与输出
            </h2>
            <p :class="['mt-1 text-sm text-neutral-500']">
              控制每轮注入 Replyer 的候选规模。没有合适表达时，Lumi 会正常说话。
            </p>
          </div>
          <FieldRange v-model="maxSelectedExpressions" :min="0" :max="3" :step="1" label="每轮最多使用的表达参考" description="建议保持 2 至 3 条，避免堆叠口癖。" />
          <FieldRange v-model="vectorCandidateLimit" :min="4" :max="100" :step="4" label="初步召回候选数" description="只影响内部候选池，最终仍只选择上方设定的少量表达。" />
          <FieldCheckbox v-model="preciseSelectorEnabled" :disabled="!enabled" label="使用模型精细选择表达" description="复杂场景增加一次轻量模型调用；关闭时使用确定性召回和评分。" />
          <FieldCheckbox v-model="multiMessageReplyEnabled" :disabled="!enabled" label="允许连续发送短消息" description="最多生成三条消息，只在自然节奏确实需要时拆分。" />
          <FieldCheckbox v-model="promptLoggingEnabled" :disabled="!enabled" label="记录意识请求与 Prompt" description="开启后可实时查看 Planner、Replyer、学习、记忆和上下文摘要的输入、输出及响应速度；其中可能包含本地聊天上下文。" />
        </section>
      </div>
    </Transition>
  </div>
</template>

<style scoped>
.language-page-enter-active,
.language-page-leave-active {
  transition: opacity 180ms ease, transform 180ms ease;
}

.language-page-enter-from,
.language-page-leave-to {
  opacity: 0;
  transform: translateY(6px);
}
</style>

<route lang="yaml">
meta:
  layout: settings
  title: 语言与表达
  description: 管理 Lumi 的口语、黑话、互动习惯、表情包与最终 Prompt
  icon: i-solar:chat-round-like-bold-duotone
  settingsEntry: true
  order: 32
  stageTransition:
    name: slide
</route>
