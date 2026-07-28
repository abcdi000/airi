<script setup lang="ts">
import { Callout, FieldCheckbox, FieldInput } from '@proj-airi/ui'
import { computed } from 'vue'

import { useServerManager } from '../useServerManager'

const manager = useServerManager()

const modes = [
  {
    id: 'legacy',
    label: '旧编排',
    icon: 'i-solar:history-bold-duotone',
    description: '继续使用原有意识编排，仅用于紧急回退。',
  },
  {
    id: 'shadow',
    label: '影子验证',
    icon: 'i-solar:ghost-smile-bold-duotone',
    description: '旧编排负责回复，新运行时在后台验证 Planner，不产生可见输出。',
  },
  {
    id: 'maisaka',
    label: '新运行时',
    icon: 'i-solar:branching-paths-up-bold-duotone',
    description: '由宿主管理多轮 Planner、工具执行和独立 Replyer。',
  },
] as const

const activeMode = computed(() => modes.find(mode => mode.id === manager.configDraft.agentRuntimeMode) ?? modes[2])
</script>

<template>
  <section :class="['space-y-4 border-b border-neutral-200 pb-6 dark:border-neutral-800']">
    <div>
      <h2 :class="['flex items-center gap-2 text-base font-semibold']">
        <span :class="['i-solar:branching-paths-up-bold-duotone size-5 text-cyan-600']" />
        Agent 运行时
      </h2>
      <p :class="['mt-1 text-xs leading-5 text-neutral-500']">
        控制旧编排向宿主管理 Planner 的迁移。切换后需要重启 Lumi Server 才会完整生效。
      </p>
    </div>

    <div :class="['grid grid-cols-1 gap-2 lg:grid-cols-3']">
      <button
        v-for="mode in modes"
        :key="mode.id"
        type="button"
        :class="[
          'min-h-24 border p-3 text-left transition-colors',
          'rounded-md',
          manager.configDraft.agentRuntimeMode === mode.id
            ? 'border-cyan-400 bg-cyan-50 text-cyan-950 dark:bg-cyan-950/30 dark:text-cyan-50'
            : 'border-neutral-200 hover:border-neutral-400 dark:border-neutral-800 dark:hover:border-neutral-600',
        ]"
        @click="manager.configDraft.agentRuntimeMode = mode.id"
      >
        <span :class="['flex items-center gap-2 text-sm font-semibold']">
          <span :class="[mode.icon, 'size-5']" />
          {{ mode.label }}
          <span
            v-if="manager.configDraft.agentRuntimeMode === mode.id"
            :class="['i-solar:check-circle-bold ml-auto size-5 text-cyan-600']"
          />
        </span>
        <span :class="['mt-2 block text-xs leading-5 text-neutral-500']">{{ mode.description }}</span>
      </button>
    </div>

    <Callout
      :theme="activeMode.id === 'legacy' ? 'orange' : activeMode.id === 'shadow' ? 'violet' : 'lime'"
      :label="activeMode.label"
    >
      {{ activeMode.description }}
    </Callout>

    <FieldInput
      v-model="manager.configDraft.agentPromptDirectory"
      label="Prompt 覆盖目录"
      description="可选。放置 planner.txt、replyer.txt、expression_selector.txt 等 UTF-8 文件；缺失文件继续使用内置模板。"
    />

    <div :class="['grid grid-cols-1 gap-4 md:grid-cols-3']">
      <FieldInput v-model="manager.configDraft.agentPlannerMaxRounds" type="number" label="Planner 最大轮数" />
      <FieldInput v-model="manager.configDraft.agentMergeWindowMs" type="number" label="连发合并窗口（ms）" />
      <FieldInput v-model="manager.configDraft.agentToolMaxConcurrency" type="number" label="工具最大并发" />
      <FieldInput v-model="manager.configDraft.agentToolStepTimeoutMs" type="number" label="单工具超时（ms）" />
      <label :class="['flex flex-col gap-1.5 text-sm']">
        <span>回复后的 Planner 行为</span>
        <select
          v-model="manager.configDraft.agentPlannerFinalizationMode"
          :class="['h-10 rounded-md border border-neutral-200 bg-transparent px-3 outline-none focus:border-cyan-500 dark:border-neutral-800']"
        >
          <option value="maibot">
            观察 reply 结果后再结束
          </option>
          <option value="stop_after_successful_reply">
            reply 成功后立即结束
          </option>
        </select>
      </label>
    </div>

    <div :class="['grid grid-cols-1 gap-4 md:grid-cols-2']">
      <FieldCheckbox v-model="manager.configDraft.agentDeferredToolsEnabled" label="允许按需发现工具" description="关闭后，Planner 不会发现延迟加载的 MCP、插件或 Tool Mesh 工具。" />
      <FieldCheckbox v-model="manager.configDraft.agentExpressionSelectorEnabled" label="启用表达精筛" description="让意识模型判断当前场景是否适合试用候选表达。" />
      <FieldCheckbox v-model="manager.configDraft.agentDirectLanguageFeedbackEnabled" label="接收私聊语言反馈" description="只更新已有群聊候选权重，不从私聊创建新候选。" />
      <FieldCheckbox v-model="manager.configDraft.agentPromptLoggingEnabled" label="记录完整 Prompt" description="仅用于服务器私密调试，默认关闭并对敏感字段脱敏。" />
    </div>

    <div :class="['grid grid-cols-1 gap-4 md:grid-cols-3']">
      <FieldInput v-model="manager.configDraft.agentPlannerHistoryBudgetTokens" type="number" label="Planner 历史预算" />
      <FieldInput v-model="manager.configDraft.agentContextCompactionThresholdTokens" type="number" label="上下文压缩阈值" />
      <FieldInput v-model="manager.configDraft.agentContextRecentTokens" type="number" label="压缩后保留近期 Tokens" />
    </div>
  </section>
</template>
