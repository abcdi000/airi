<script setup lang="ts">
import { useChatOrchestratorStore } from '@proj-airi/stage-ui/stores/chat'
import { useLumiAgentRuntimeSettingsStore } from '@proj-airi/stage-ui/stores/lumi-agent-runtime-settings'
import { Callout, DoubleCheckButton, FieldCheckbox, FieldInput, FieldSelect } from '@proj-airi/ui'
import { storeToRefs } from 'pinia'
import { computed, shallowRef } from 'vue'

const store = useLumiAgentRuntimeSettingsStore()
const chatOrchestrator = useChatOrchestratorStore()
const {
  mode,
  plannerMaxRounds,
  plannerFinalizationMode,
  mergeWindowMs,
  toolMaxConcurrency,
  toolStepTimeoutMs,
  deferredToolsEnabled,
  expressionSelectorEnabled,
  directLanguageFeedbackEnabled,
  promptLoggingEnabled,
  plannerHistoryBudgetTokens,
  contextCompactionThresholdTokens,
  contextRecentTokens,
  contextCompactionIdleMs,
} = storeToRefs(store)

const modes = [
  {
    id: 'legacy',
    label: '旧运行链路',
    icon: 'i-solar:history-bold-duotone',
    description: '继续由原有 Lumi 编排回复，仅用于紧急回退。',
  },
  {
    id: 'shadow',
    label: '影子验证',
    icon: 'i-solar:ghost-smile-bold-duotone',
    description: '旧链路正常回复，新 Agent Runtime 只读运行，不发送消息或写入学习数据。',
  },
  {
    id: 'maisaka',
    label: '共享 Agent Runtime',
    icon: 'i-solar:branching-paths-up-bold-duotone',
    description: '由宿主管理多轮 Planner、工具、独立 Replyer 和最终消息发送。',
  },
] as const

const activeMode = computed(() => modes.find(candidate => candidate.id === mode.value) ?? modes[1])
const clearingContext = shallowRef(false)
const contextClearResult = shallowRef('')
const contextClearError = shallowRef('')

const finalizationOptions: Array<{
  label: string
  value: 'maibot' | 'stop_after_successful_reply'
  description: string
}> = [
  {
    label: '观察发送结果后收尾',
    value: 'maibot',
    description: 'Reply 成功后再运行一轮 Planner，由它确认本轮是否结束。',
  },
  {
    label: '回复成功后立即结束',
    value: 'stop_after_successful_reply',
    description: '减少一次模型请求，适合优先响应速度的场景。',
  },
]

async function clearConversationContext() {
  clearingContext.value = true
  contextClearResult.value = ''
  contextClearError.value = ''
  try {
    const result = await chatOrchestrator.clearLumiConversationContext()
    contextClearResult.value = `已清除 ${result.deletedSessionCount} 个本地 Lumi 私聊会话及其运行时上下文。`
  }
  catch (error) {
    contextClearError.value = error instanceof Error ? error.message : String(error)
  }
  finally {
    clearingContext.value = false
  }
}
</script>

<template>
  <div :class="['flex flex-col gap-8']">
    <section :class="['flex flex-col gap-5 border-b border-neutral-200 pb-8 dark:border-neutral-800']">
      <div>
        <h2 :class="['flex items-center gap-2 text-lg font-semibold']">
          <span :class="['i-solar:branching-paths-up-bold-duotone size-5 text-cyan-600']" />
          对话运行时
        </h2>
        <p :class="['mt-1 text-sm leading-6 text-neutral-500']">
          只影响本机离线 Lumi 的私聊链路。在线模式继续由 Lumi Server 的运行时配置负责。
        </p>
      </div>

      <div :class="['grid grid-cols-1 gap-3 md:grid-cols-3']">
        <button
          v-for="candidate in modes"
          :key="candidate.id"
          type="button"
          :class="[
            'min-h-28 border p-4 text-left transition-colors',
            'rounded-md',
            mode === candidate.id
              ? 'border-cyan-400 bg-cyan-50 text-cyan-950 dark:bg-cyan-950/30 dark:text-cyan-50'
              : 'border-neutral-200 hover:border-neutral-400 dark:border-neutral-800 dark:hover:border-neutral-600',
          ]"
          @click="mode = candidate.id"
        >
          <span :class="['flex items-center gap-2 text-sm font-semibold']">
            <span :class="[candidate.icon, 'size-5']" />
            {{ candidate.label }}
            <span
              v-if="mode === candidate.id"
              :class="['i-solar:check-circle-bold ml-auto size-5 text-cyan-600']"
            />
          </span>
          <span :class="['mt-2 block text-xs leading-5 text-neutral-500']">
            {{ candidate.description }}
          </span>
        </button>
      </div>

      <Callout
        :theme="activeMode.id === 'legacy' ? 'orange' : activeMode.id === 'shadow' ? 'violet' : 'lime'"
        :label="activeMode.label"
      >
        {{ activeMode.description }}
      </Callout>
    </section>

    <section :class="['flex flex-col gap-6 border-b border-neutral-200 pb-8 dark:border-neutral-800']">
      <div>
        <h2 :class="['text-lg font-semibold']">
          Planner 与工具
        </h2>
        <p :class="['mt-1 text-sm leading-6 text-neutral-500']">
          调整连续消息合并、Planner 内部轮数和工具执行上限。新设置从下一轮对话生效。
        </p>
      </div>

      <FieldSelect
        v-model="plannerFinalizationMode"
        layout="vertical"
        label="回复后的 Planner 行为"
        description="选择自然的宿主收尾，或优先降低一次模型请求的延迟。"
        :options="finalizationOptions"
      />

      <div :class="['grid grid-cols-1 gap-5 md:grid-cols-2']">
        <FieldInput v-model="plannerMaxRounds" type="number" label="Planner 最大轮数" description="包含工具调用、Reply 和收尾轮次，默认 10。" />
        <FieldInput v-model="mergeWindowMs" type="number" label="连续消息合并窗口（毫秒）" description="短时间连续输入会合并后重新规划，默认 80。" />
        <FieldInput v-model="toolMaxConcurrency" type="number" label="工具最大并发" description="互不依赖的工具可并行执行，默认 4。" />
        <FieldInput v-model="toolStepTimeoutMs" type="number" label="单工具超时（毫秒）" description="只限制单次工具执行，不限制完整 Planner 回合。" />
      </div>

      <div :class="['grid grid-cols-1 gap-4 md:grid-cols-2']">
        <FieldCheckbox v-model="deferredToolsEnabled" label="允许按需发现工具" description="关闭后，Planner 看不到延迟加载的 MCP、插件和 Tool Mesh 工具。" />
        <FieldCheckbox v-model="expressionSelectorEnabled" label="启用表达精筛" description="由意识模型从候选表达中选择当前场景真正适合试用的内容。" />
        <FieldCheckbox v-model="directLanguageFeedbackEnabled" label="接收私聊语言反馈" description="只调整已有群聊候选的权重，不会从私聊创建新口癖或黑话。" />
        <FieldCheckbox v-model="promptLoggingEnabled" label="记录完整 Prompt" description="仅用于本机私密调试；默认关闭，开启后仍会递归隐藏密钥字段。" />
      </div>
    </section>

    <section :class="['flex flex-col gap-6']">
      <div>
        <h2 :class="['text-lg font-semibold']">
          上下文预算
        </h2>
        <p :class="['mt-1 text-sm leading-6 text-neutral-500']">
          达到压缩阈值时冻结旧对话段并生成稳定摘要，不会每轮滑动丢弃最早消息。
        </p>
      </div>

      <div :class="['grid grid-cols-1 gap-5 md:grid-cols-2']">
        <FieldInput v-model="plannerHistoryBudgetTokens" type="number" label="Planner 历史预算" description="Planner 可选择的历史与内部工具记录总预算。" />
        <FieldInput v-model="contextCompactionThresholdTokens" type="number" label="上下文压缩阈值" description="超过此估算值后创建新的稳定摘要 checkpoint。" />
        <FieldInput v-model="contextRecentTokens" type="number" label="压缩后保留近期 Tokens" description="摘要之外仍完整保留的近期真实对话预算。" />
        <FieldInput v-model="contextCompactionIdleMs" type="number" label="压缩空闲等待（毫秒）" description="有新消息时优先回复，持续空闲超过此时间后才在后台压缩。" />
      </div>
    </section>

    <section :class="['flex flex-col gap-4 border-t border-neutral-200 pt-8 dark:border-neutral-800']">
      <div :class="['grid grid-cols-1 items-start gap-5 md:grid-cols-[minmax(0,1fr)_auto]']">
        <div>
          <h2 :class="['text-lg font-semibold']">
            清除本地对话上下文
          </h2>
          <p :class="['mt-1 max-w-3xl text-sm leading-6 text-neutral-500']">
            清除 Agent Runtime 会话、滚动摘要、Prompt 调试快照和本地 Lumi 私聊记录。长期记忆、人物印象、日记、私人笔记、用户画像、学习表达、行为、黑话和表情包都会保留。
          </p>
        </div>
        <DoubleCheckButton
          variant="danger"
          :disabled="clearingContext"
          @confirm="clearConversationContext"
        >
          {{ clearingContext ? '正在清除…' : '清除上下文' }}
          <template #confirm>
            确认清除
          </template>
          <template #cancel>
            取消
          </template>
        </DoubleCheckButton>
      </div>

      <Callout v-if="contextClearResult" theme="lime" label="清除完成">
        {{ contextClearResult }}
      </Callout>
      <Callout v-else-if="contextClearError" theme="orange" label="清除失败">
        {{ contextClearError }}
      </Callout>
    </section>
  </div>
</template>
