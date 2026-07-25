<script setup lang="ts">
import type { LanguageDecisionLog } from '@proj-airi/stage-ui/stores/lumi-social-language'

import { useLumiSocialLanguageStore } from '@proj-airi/stage-ui/stores/lumi-social-language'
import { Button, DoubleCheckButton, SelectTab } from '@proj-airi/ui'
import { useIntervalFn } from '@vueuse/core'
import { storeToRefs } from 'pinia'
import { computed, shallowRef, watch } from 'vue'

import ConsciousnessRequestTimeline from './ConsciousnessRequestTimeline.vue'

type InspectorMode = 'requests' | 'decision'
type DecisionTab = 'final' | 'planner' | 'selection'

interface PromptMessage {
  role: string
  content: string
  name?: string
}

const store = useLumiSocialLanguageStore()
const { config, snapshot } = storeToRefs(store)
const inspectorMode = shallowRef<InspectorMode>('requests')
const decisionTab = shallowRef<DecisionTab>('final')
const selectedDecisionId = shallowRef('')
const copied = shallowRef(false)

const loggedDecisions = computed(() => snapshot.value.decisions
  .filter(decision => isPromptMessages(decision.replyerPromptSnapshot))
  .slice()
  .reverse())
const selectedDecision = computed(() =>
  loggedDecisions.value.find(decision => decision.id === selectedDecisionId.value) ?? loggedDecisions.value[0],
)
const promptMessages = computed(() =>
  isPromptMessages(selectedDecision.value?.replyerPromptSnapshot)
    ? selectedDecision.value.replyerPromptSnapshot
    : [],
)
const selectedExpressions = computed(() => selectedDecision.value?.selectedExpressions
  .map(id => snapshot.value.expressions.find(item => item.id === id))
  .filter(item => item !== undefined) ?? [])
const realizedExpressionIds = computed(() => new Set(selectedDecision.value?.realizedExpressions ?? []))
const selectedBehaviors = computed(() => selectedDecision.value?.selectedBehaviors
  .map(id => snapshot.value.behaviors.find(item => item.id === id))
  .filter(item => item !== undefined) ?? [])

useIntervalFn(() => {
  void store.refreshFromPersistence()
}, 1_000, { immediate: true })

watch(loggedDecisions, (decisions) => {
  if (!decisions.some(item => item.id === selectedDecisionId.value))
    selectedDecisionId.value = decisions[0]?.id ?? ''
}, { immediate: true })

function isPromptMessages(value: unknown): value is PromptMessage[] {
  return Array.isArray(value) && value.every(item =>
    item !== null
    && typeof item === 'object'
    && 'role' in item
    && typeof item.role === 'string'
    && 'content' in item
    && typeof item.content === 'string',
  )
}

function formatDecision(decision: LanguageDecisionLog) {
  const reply = decision.actuallySentReply.messages.map(item => item.text).join(' / ')
  return `${new Date(decision.timestamp).toLocaleString()} · ${reply || '静默'}`
}

async function copyCurrent() {
  const value = decisionTab.value === 'final'
    ? JSON.stringify(promptMessages.value, null, 2)
    : decisionTab.value === 'planner'
      ? JSON.stringify(selectedDecision.value?.plannerIntent ?? {}, null, 2)
      : JSON.stringify({
          selectedExpressions: selectedExpressions.value,
          realizedExpressionIds: [...realizedExpressionIds.value],
          selectedBehaviors: selectedBehaviors.value,
          reasons: selectedDecision.value?.selectedExpressionReasons ?? {},
        }, null, 2)
  await navigator.clipboard.writeText(value)
  copied.value = true
  window.setTimeout(() => {
    copied.value = false
  }, 1_500)
}
</script>

<template>
  <section :class="['flex flex-col gap-6']">
    <header :class="['flex flex-wrap items-start justify-between gap-4 border-b border-neutral-200 pb-5 dark:border-neutral-800']">
      <div>
        <h2 :class="['text-lg font-semibold']">
          意识与 Prompt 检查器
        </h2>
        <p :class="['mt-1 max-w-2xl text-sm text-neutral-500']">
          记录 Planner、表达选择、Replyer、学习、反馈和上下文摘要的每次真实模型请求，并实时显示生成速度。
        </p>
      </div>
      <Button
        v-if="!config.promptLoggingEnabled"
        size="sm"
        icon="i-solar:record-circle-bold-duotone"
        @click="store.updateConfig({ promptLoggingEnabled: true })"
      >
        开始记录
      </Button>
      <Button
        v-else
        size="sm"
        variant="secondary"
        icon="i-solar:stop-circle-bold-duotone"
        @click="store.updateConfig({ promptLoggingEnabled: false })"
      >
        停止记录
      </Button>
    </header>

    <div :class="['border-l-3 border-amber-500 bg-amber-500/8 px-4 py-3 text-sm text-amber-700 dark:text-amber-300']">
      调试记录可能包含聊天上下文，只保存在本机。最终聊天回复仍会等待 Replyer 结构解析与隐私校验，实时流仅在本检查器中展示。
    </div>

    <SelectTab
      v-model="inspectorMode"
      :options="[
        { label: '意识请求', value: 'requests', icon: 'i-solar:pulse-2-bold-duotone' },
        { label: '回复决策', value: 'decision', icon: 'i-solar:document-text-bold-duotone' },
      ]"
      size="sm"
      tab-space="compact"
    />

    <Transition name="prompt-panel" mode="out-in">
      <ConsciousnessRequestTimeline v-if="inspectorMode === 'requests'" key="requests" />

      <section v-else key="decision" :class="['flex flex-col gap-5']">
        <div v-if="!loggedDecisions.length" :class="['py-14 text-center text-sm text-neutral-500']">
          暂无完整回复决策。开启记录后和 Lumi 聊一轮，这里会出现 Replyer 的最终输入。
        </div>

        <template v-else>
          <label :class="['flex flex-col gap-2']">
            <span :class="['text-xs font-medium text-neutral-500']">选择一次回复</span>
            <select
              v-model="selectedDecisionId"
              :class="['h-10 rounded-lg border border-neutral-200 bg-white px-3 text-sm outline-none dark:border-neutral-800 dark:bg-neutral-900']"
            >
              <option v-for="decision in loggedDecisions" :key="decision.id" :value="decision.id">
                {{ formatDecision(decision) }}
              </option>
            </select>
          </label>

          <div :class="['flex flex-wrap items-center justify-between gap-3']">
            <SelectTab
              v-model="decisionTab"
              :options="[
                { label: '最终模型输入', value: 'final', icon: 'i-solar:code-square-bold-duotone' },
                { label: 'Planner 意图', value: 'planner', icon: 'i-solar:route-bold-duotone' },
                { label: '学习项注入', value: 'selection', icon: 'i-solar:filter-bold-duotone' },
              ]"
              size="sm"
              tab-space="compact"
            />
            <div :class="['flex gap-2']">
              <Button
                size="sm"
                variant="secondary"
                :icon="copied ? 'i-solar:check-circle-bold-duotone' : 'i-solar:copy-bold-duotone'"
                @click="copyCurrent"
              >
                {{ copied ? '已复制' : '复制' }}
              </Button>
              <DoubleCheckButton
                v-if="selectedDecision"
                size="sm"
                variant="danger"
                @confirm="store.deleteDecision(selectedDecision.id)"
              >
                删除
                <template #confirm>
                  确认删除
                </template>
                <template #cancel>
                  取消
                </template>
              </DoubleCheckButton>
            </div>
          </div>

          <div v-if="decisionTab === 'final'" :class="['flex flex-col gap-3']">
            <article
              v-for="(message, index) in promptMessages"
              :key="`${index}-${message.role}`"
              :class="['overflow-hidden rounded-lg border border-neutral-200 dark:border-neutral-800']"
            >
              <div :class="['flex items-center justify-between bg-neutral-100/70 px-3 py-2 text-xs font-semibold uppercase dark:bg-neutral-900']">
                <span>{{ message.role }}</span>
                <span v-if="message.name" :class="['normal-case text-neutral-500']">{{ message.name }}</span>
              </div>
              <pre :class="['max-h-96 overflow-auto whitespace-pre-wrap break-words p-4 text-xs leading-5 font-mono']">{{ message.content }}</pre>
            </article>
          </div>
          <pre
            v-else-if="decisionTab === 'planner'"
            :class="['max-h-[620px] overflow-auto whitespace-pre-wrap rounded-lg border border-neutral-200 p-4 text-xs leading-5 font-mono dark:border-neutral-800']"
          >{{ JSON.stringify(selectedDecision?.plannerIntent ?? {}, null, 2) }}</pre>
          <div v-else :class="['grid gap-5 md:grid-cols-2']">
            <section :class="['border-y border-neutral-200 py-4 dark:border-neutral-800']">
              <h3 :class="['text-sm font-semibold']">
                注入的表达
              </h3>
              <div v-if="!selectedExpressions.length" :class="['mt-3 text-sm text-neutral-500']">
                本轮没有注入表达
              </div>
              <div v-for="expression in selectedExpressions" :key="expression.id" :class="['mt-3']">
                <div :class="['flex flex-wrap items-center gap-2']">
                  <strong :class="['text-sm']">{{ expression.phrase || expression.pragmaticFunction }}</strong>
                  <span
                    :class="[
                      'rounded px-2 py-0.5 text-xs',
                      realizedExpressionIds.has(expression.id)
                        ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-300'
                        : 'bg-neutral-500/10 text-neutral-500',
                    ]"
                  >
                    {{ realizedExpressionIds.has(expression.id) ? '实际采用' : '仅注入' }}
                  </span>
                </div>
                <p :class="['mt-1 text-xs text-neutral-500']">
                  {{ expression.situation }}
                </p>
                <p :class="['mt-1 text-xs text-neutral-500']">
                  {{ selectedDecision?.selectedExpressionReasons[expression.id]?.join(' · ') }}
                </p>
              </div>
            </section>
            <section :class="['border-y border-neutral-200 py-4 dark:border-neutral-800']">
              <h3 :class="['text-sm font-semibold']">
                注入的行为
              </h3>
              <div v-if="!selectedBehaviors.length" :class="['mt-3 text-sm text-neutral-500']">
                本轮没有注入行为
              </div>
              <div v-for="behavior in selectedBehaviors" :key="behavior.id" :class="['mt-3']">
                <strong :class="['text-sm']">{{ behavior.situation }}</strong>
                <p :class="['mt-1 text-xs text-neutral-500']">
                  {{ behavior.action }}
                </p>
              </div>
            </section>
          </div>

          <div
            v-if="selectedDecision"
            :class="['grid gap-3 border-t border-neutral-200 pt-4 text-xs text-neutral-500 md:grid-cols-3 dark:border-neutral-800']"
          >
            <span>验证：{{ selectedDecision.validator.passed ? '通过' : '失败' }}</span>
            <span>生成尝试：{{ selectedDecision.validator.attempts }}</span>
            <span>兜底：{{ selectedDecision.validator.fallbackUsed ? '是' : '否' }}</span>
          </div>
        </template>
      </section>
    </Transition>
  </section>
</template>

<style scoped>
.prompt-panel-enter-active,
.prompt-panel-leave-active {
  transition: opacity 160ms ease, transform 160ms ease;
}

.prompt-panel-enter-from,
.prompt-panel-leave-to {
  opacity: 0;
  transform: translateY(5px);
}
</style>
