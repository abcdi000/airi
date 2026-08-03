<script setup lang="ts">
import type { Sub2ApiClientAccountStatus, Sub2ApiClientConfig } from '@proj-airi/stage-ui/libs'

import { Button, FieldCheckbox, FieldInput, FieldSelect } from '@proj-airi/ui'
import { computed } from 'vue'

interface TestResult {
  success: boolean
  error?: string
  output: string
  protocol: string
  fallbackUsed: boolean
  requestedModel: string
  resolvedModel?: string
  firstTokenLatencyMs?: number
  durationMs: number
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
}

const props = defineProps<{
  config: Record<string, unknown>
  accountStatus?: Sub2ApiClientAccountStatus
  accountLoading?: boolean
  testResult?: TestResult
}>()

const emit = defineEmits<{
  change: [patch: Partial<Sub2ApiClientConfig>]
  refreshAccount: []
}>()

function field<K extends keyof Sub2ApiClientConfig>(key: K, fallback: Sub2ApiClientConfig[K]) {
  return computed<Sub2ApiClientConfig[K]>({
    get: () => (props.config[key] as Sub2ApiClientConfig[K] | undefined) ?? fallback,
    set: value => emit('change', { [key]: value }),
  })
}

const protocol = field('protocol', 'auto')
const reasoningEffort = field('reasoningEffort', 'auto')
const maxToolSteps = field('maxToolSteps', 64)
const multimodalEnabled = field('multimodalEnabled', false)
const accountApiBaseUrl = field('accountApiBaseUrl', '')
const accountAccessToken = field('accountAccessToken', '')

const protocolOptions = [
  { label: '自动（优先 Responses）', value: 'auto' },
  { label: 'Responses', value: 'responses' },
  { label: 'Chat Completions', value: 'chat-completions' },
]
const reasoningOptions = ['auto', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh']
  .map(value => ({ label: value, value }))
</script>

<template>
  <div :class="['flex flex-col gap-5']">
    <div :class="['grid gap-4']">
      <FieldSelect
        v-model="protocol"
        label="协议模式"
        description="自动模式先尝试 Responses，仅在端点明确不支持时回退一次 Chat Completions。"
        :options="protocolOptions"
      />
      <FieldSelect
        v-model="reasoningEffort"
        label="思考强度"
        description="是否生效由当前模型决定；自动表示不显式覆盖服务端默认值。"
        :options="reasoningOptions"
      />
      <FieldInput
        v-model="maxToolSteps"
        label="最大工具步数"
        description="客户端工具、MCP 和浏览器多步任务的单轮上限。"
        type="number"
        placeholder="64"
      />
      <FieldCheckbox
        v-model="multimodalEnabled"
        label="由 Sub2API 意识模型直接看图"
        description="开启后图片直接进入当前 Sub2API 模型；关闭后继续使用 Lumi 独立视觉模块生成理解结果。"
      />
    </div>

    <section
      v-if="testResult"
      :class="[
        'rounded-lg border p-4',
        testResult.success
          ? 'border-emerald-300/60 bg-emerald-500/5 dark:border-emerald-700/60'
          : 'border-red-300/60 bg-red-500/5 dark:border-red-700/60',
        'grid gap-2 text-xs',
      ]"
    >
      <h3 :class="['text-sm font-semibold']">
        最近一次 API 测试：{{ testResult.success ? '成功' : '失败' }}
      </h3>
      <div v-if="testResult.error" :class="['break-all text-red-600 dark:text-red-300']">
        {{ testResult.error }}
      </div>
      <div :class="['grid grid-cols-1 gap-1 sm:grid-cols-2']">
        <span>实际协议：{{ testResult.protocol }}</span>
        <span>发生回退：{{ testResult.fallbackUsed ? '是' : '否' }}</span>
        <span>请求模型：{{ testResult.requestedModel }}</span>
        <span>返回模型：{{ testResult.resolvedModel || '未返回' }}</span>
        <span>首 token：{{ testResult.firstTokenLatencyMs ?? '未记录' }} ms</span>
        <span>总耗时：{{ testResult.durationMs }} ms</span>
        <span>输入 token：{{ testResult.inputTokens ?? '未返回' }}</span>
        <span>输出 token：{{ testResult.outputTokens ?? '未返回' }}</span>
      </div>
      <div :class="['break-all text-neutral-600 dark:text-neutral-300']">
        输出：{{ testResult.output || '空' }}
      </div>
    </section>

    <section :class="['rounded-lg border border-neutral-200 p-4', 'dark:border-neutral-800', 'flex flex-col gap-4']">
      <div>
        <h3 :class="['text-sm font-semibold']">
          账户状态（可选）
        </h3>
        <p :class="['text-xs text-neutral-500 dark:text-neutral-400']">
          账户令牌只用于余额和配额查询，不影响模型聊天；不要填写网页密码或 Cookie。
        </p>
      </div>
      <FieldInput
        v-model="accountApiBaseUrl"
        label="账户 API Base URL"
        description="留空时根据模型 API 地址自动推导 /api/v1/。"
        placeholder="http://127.0.0.1:8080/api/v1/"
      />
      <FieldInput
        v-model="accountAccessToken"
        label="用户访问令牌"
        description="与模型 API Key 相互独立。"
        type="password"
        placeholder="可选"
      />
      <div :class="['flex items-center justify-between gap-3']">
        <div v-if="accountStatus" :class="['min-w-0 text-xs text-neutral-600 dark:text-neutral-300']">
          <div>余额：{{ accountStatus.balance ?? '未返回' }}</div>
          <div>冻结余额：{{ accountStatus.frozenBalance ?? '未返回' }}</div>
          <div>并发额度：{{ accountStatus.concurrency ?? '未返回' }}</div>
          <div>RPM 限额：{{ accountStatus.rpmLimit ?? '未返回' }}</div>
          <div>有效倍率：{{ accountStatus.effectiveRateMultiplier ?? '未返回' }}</div>
          <div v-for="quota in accountStatus.platformQuotas" :key="quota.platform">
            {{ quota.platform }}：{{ quota.dailyUsageUsd ?? '未返回' }} / {{ quota.dailyLimitUsd ?? '不限额' }} USD
          </div>
          <div v-if="accountStatus.errors.length" :class="['text-red-600 dark:text-red-300']">
            {{ accountStatus.errors.join('；') }}
          </div>
        </div>
        <span v-else :class="['text-xs text-neutral-500']">尚未查询</span>
        <Button
          label="查询账户"
          icon="i-solar:refresh-bold-duotone"
          variant="secondary"
          :loading="accountLoading"
          @click="emit('refreshAccount')"
        />
      </div>
    </section>
  </div>
</template>
