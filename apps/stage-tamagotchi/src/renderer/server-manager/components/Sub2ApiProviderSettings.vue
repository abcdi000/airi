<script setup lang="ts">
import { Button, Callout, FieldInput } from '@proj-airi/ui'
import { computed, shallowRef } from 'vue'

import { useServerManager } from '../useServerManager'

const manager = useServerManager()
const modelSearch = shallowRef('')

const protocol = computed({
  get: () => {
    const value = manager.configDraft.modelProviderOptions.protocol
    return value === 'responses' || value === 'chat-completions' ? value : 'auto'
  },
  set: (value: 'auto' | 'responses' | 'chat-completions') => {
    manager.configDraft.modelProviderOptions.protocol = value
  },
})
const reasoningEffort = computed({
  get: () => {
    const value = manager.configDraft.modelProviderOptions.reasoningEffort
    return ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'].includes(String(value))
      ? String(value) as 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'
      : 'auto'
  },
  set: (value: 'auto' | 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh') => {
    manager.configDraft.modelProviderOptions.reasoningEffort = value
  },
})
const accountApiBaseURL = computed({
  get: () => String(manager.configDraft.modelProviderOptions.accountApiBaseURL ?? ''),
  set: (value) => {
    if (value.trim())
      manager.configDraft.modelProviderOptions.accountApiBaseURL = value
    else
      delete manager.configDraft.modelProviderOptions.accountApiBaseURL
  },
})
const visibleModels = computed(() => {
  const query = modelSearch.value.trim().toLowerCase()
  const models = query
    ? manager.models.value.filter(model => `${model.id} ${model.displayName ?? ''}`.toLowerCase().includes(query))
    : manager.models.value
  return models.slice(0, 200)
})
const modelMissingFromManifest = computed(() => manager.models.value.length > 0
  && Boolean(manager.configDraft.modelName)
  && !manager.models.value.some(model => model.id === manager.configDraft.modelName))
const test = computed(() => manager.providerTestResult.value)
const advancedTest = computed(() => manager.providerAdvancedTestResult.value)
const account = computed(() => manager.providerAccountStatus.value)

function formatNumber(value: number | null | undefined) {
  return value === null || value === undefined ? '未提供' : new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 6 }).format(value)
}
</script>

<template>
  <section :class="['flex flex-col gap-4 border-y border-neutral-200 py-4 dark:border-neutral-800']">
    <div :class="['grid grid-cols-2 gap-4']">
      <label :class="['block text-sm']">
        <span :class="['mb-1.5 block']">协议</span>
        <select v-model="protocol" :class="['h-10 w-full rounded-md border border-neutral-200 bg-transparent px-3 dark:border-neutral-800']">
          <option value="auto">自动（优先 Responses）</option>
          <option value="responses">Responses API</option>
          <option value="chat-completions">Chat Completions API</option>
        </select>
      </label>
      <label :class="['block text-sm']">
        <span :class="['mb-1.5 block']">思考强度</span>
        <select v-model="reasoningEffort" :class="['h-10 w-full rounded-md border border-neutral-200 bg-transparent px-3 dark:border-neutral-800']">
          <option value="auto">跟随模型默认</option>
          <option value="none">None</option>
          <option value="minimal">Minimal</option>
          <option value="low">Low</option>
          <option value="medium">Medium</option>
          <option value="high">High</option>
          <option value="xhigh">XHigh</option>
        </select>
      </label>
    </div>

    <div :class="['grid grid-cols-[minmax(0,1fr)_auto] items-end gap-2']">
      <FieldInput v-model="modelSearch" label="搜索已发现模型" placeholder="输入模型名称或 ID" />
      <Button variant="secondary" label="获取模型" icon="i-solar:list-bold-duotone" :loading="manager.providerBusy.value === 'models'" :disabled="Boolean(manager.providerBusy.value)" @click="manager.fetchModels" />
    </div>
    <div v-if="manager.models.value.length" :class="['max-h-48 overflow-y-auto rounded-md border border-neutral-200 p-1 dark:border-neutral-800']">
      <button
        v-for="model in visibleModels"
        :key="model.id"
        type="button"
        :class="['flex w-full items-center justify-between gap-3 rounded px-2.5 py-2 text-left text-sm', manager.configDraft.modelName === model.id ? 'bg-cyan-50 text-cyan-800 dark:bg-cyan-950/35 dark:text-cyan-200' : 'hover:bg-neutral-100 dark:hover:bg-neutral-900']"
        @click="manager.configDraft.modelName = model.id"
      >
        <span :class="['min-w-0']">
          <span :class="['block truncate']">{{ model.displayName || model.id }}</span>
          <span v-if="model.displayName" :class="['block truncate text-xs text-neutral-500']">{{ model.id }}</span>
        </span>
        <span v-if="manager.configDraft.modelName === model.id" :class="['i-solar:check-circle-bold size-4 shrink-0']" />
      </button>
      <p v-if="visibleModels.length === 200 && manager.models.value.length > 200" :class="['px-2 py-1 text-xs text-neutral-500']">
        继续输入关键词可缩小 {{ manager.models.value.length }} 个模型的范围
      </p>
    </div>
    <FieldInput v-model="manager.configDraft.modelName" label="模型 ID" placeholder="也可以手动输入服务端模型 ID" />
    <Callout v-if="modelMissingFromManifest" theme="orange" label="当前模型不在最新清单中">
      已保留手动模型 ID，不会自动切换为列表中的其他模型。
    </Callout>

    <div v-if="test" :class="['grid grid-cols-2 gap-x-5 gap-y-2 border-l-2 border-cyan-400/50 pl-4 text-sm']">
      <span :class="['text-neutral-500']">实际协议</span><span>{{ test.protocol }}{{ test.fallbackUsed ? '（已回退）' : '' }}</span>
      <span :class="['text-neutral-500']">响应耗时</span><span>{{ test.durationMs }} ms</span>
      <span :class="['text-neutral-500']">首字耗时</span><span>{{ test.firstTokenMs === undefined ? '未报告' : `${test.firstTokenMs} ms` }}</span>
      <span :class="['text-neutral-500']">请求模型</span><span :class="['break-all']">{{ test.requestedModel }}</span>
      <span :class="['text-neutral-500']">实际模型</span><span :class="['break-all']">{{ test.resolvedModel || '服务端未报告' }}</span>
      <span :class="['text-neutral-500']">返回文本</span><span :class="['break-words']">{{ test.text }}</span>
    </div>
    <details :class="['rounded-md border border-neutral-200 p-3 dark:border-neutral-800']">
      <summary :class="['cursor-pointer text-sm font-medium']">
        高级测试
      </summary>
      <div :class="['mt-3 flex flex-wrap gap-2']">
        <Button variant="secondary" label="测试本地多轮" icon="i-solar:chat-round-line-bold-duotone" :loading="manager.providerBusy.value === 'advanced'" :disabled="Boolean(manager.providerBusy.value)" @click="manager.testProviderAdvanced('multi-turn')" />
        <Button variant="secondary" label="测试 Planner 工具" icon="i-solar:widget-5-bold-duotone" :loading="manager.providerBusy.value === 'advanced'" :disabled="Boolean(manager.providerBusy.value)" @click="manager.testProviderAdvanced('planner-tool')" />
      </div>
      <dl v-if="advancedTest" :class="['mt-3 grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs']">
        <dt :class="['text-neutral-500']">
          测试
        </dt><dd>{{ advancedTest.kind }}</dd>
        <dt :class="['text-neutral-500']">
          协议
        </dt><dd>{{ advancedTest.protocol }}{{ advancedTest.fallbackUsed ? '（已回退）' : '' }}</dd>
        <dt :class="['text-neutral-500']">
          轮次
        </dt><dd>{{ advancedTest.rounds }}</dd>
        <dt :class="['text-neutral-500']">
          耗时
        </dt><dd>{{ advancedTest.durationMs }} ms</dd>
        <dt v-if="advancedTest.callId" :class="['text-neutral-500']">
          Call ID
        </dt><dd v-if="advancedTest.callId" :class="['break-all']">
          {{ advancedTest.callId }}
        </dd>
        <dt :class="['text-neutral-500']">
          结果
        </dt><dd :class="['break-words']">
          {{ advancedTest.text }}
        </dd>
      </dl>
    </details>
  </section>

  <section :class="['flex flex-col gap-4 border-b border-neutral-200 pb-4 dark:border-neutral-800']">
    <h3 :class="['text-sm font-semibold']">
      Sub2API 账户状态
    </h3>
    <FieldInput v-model="accountApiBaseURL" label="账户 API Base URL（可选）" placeholder="留空时根据模型地址推导 /api/v1/" />
    <FieldInput
      v-model="manager.configDraft.modelAccountAccessToken"
      type="password"
      :placeholder="manager.state.value?.config.model.accountAccessTokenSet ? '已安全保存，留空保持不变' : '输入 Sub2API 用户访问令牌'"
      label="用户访问令牌（可选）"
    />
    <div :class="['flex flex-wrap gap-2']">
      <Button variant="secondary" label="查询账户状态" icon="i-solar:wallet-money-bold-duotone" :loading="manager.providerBusy.value === 'account'" :disabled="Boolean(manager.providerBusy.value)" @click="manager.fetchProviderAccountStatus" />
      <Button variant="secondary" label="清除用户令牌" icon="i-solar:trash-bin-trash-linear" :disabled="manager.busy.value || (!manager.state.value?.config.model.accountAccessTokenSet && !manager.configDraft.modelAccountAccessToken)" @click="manager.clearProviderAccountToken" />
    </div>
    <Callout v-if="account && !account.accountTokenConfigured" theme="primary" label="模型 API 不受影响">
      未配置用户令牌，因此未查询账户余额和平台配额；API Key 计费倍率仍可查询。
    </Callout>

    <div v-if="account?.wallet" :class="['grid grid-cols-2 gap-x-5 gap-y-2 text-sm']">
      <span :class="['text-neutral-500']">账户余额</span><strong>{{ formatNumber(account.wallet.balance) }}</strong>
      <span :class="['text-neutral-500']">冻结余额</span><span>{{ formatNumber(account.wallet.frozenBalance) }}</span>
      <span :class="['text-neutral-500']">账户状态</span><span>{{ account.wallet.status || '未提供' }}</span>
      <span :class="['text-neutral-500']">并发限制</span><span>{{ formatNumber(account.limits?.concurrency) }}</span>
      <span :class="['text-neutral-500']">RPM 限制</span><span>{{ formatNumber(account.limits?.rpmLimit) }}</span>
    </div>

    <div v-if="account?.platformQuotas?.length" :class="['overflow-x-auto']">
      <table :class="['w-full border-collapse text-left text-xs']">
        <thead>
          <tr :class="['border-b border-neutral-200 text-neutral-500 dark:border-neutral-800']">
            <th :class="['py-2']">
              平台
            </th><th>日用量 / 限额</th><th>周用量 / 限额</th><th>月用量 / 限额</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="quota in account.platformQuotas" :key="quota.platform" :class="['border-b border-neutral-100 dark:border-neutral-900']">
            <td :class="['py-2']">
              {{ quota.platform }}
            </td><td>{{ formatNumber(quota.dailyUsageUsd) }} / {{ formatNumber(quota.dailyLimitUsd) }}</td><td>{{ formatNumber(quota.weeklyUsageUsd) }} / {{ formatNumber(quota.weeklyLimitUsd) }}</td><td>{{ formatNumber(quota.monthlyUsageUsd) }} / {{ formatNumber(quota.monthlyLimitUsd) }}</td>
          </tr>
        </tbody>
      </table>
    </div>

    <div v-if="account?.billingRate" :class="['grid grid-cols-2 gap-x-5 gap-y-2 border-l-2 border-amber-400/60 pl-4 text-sm']">
      <strong :class="['col-span-2 text-amber-700 dark:text-amber-300']">这是计费倍率，不是账户余额</strong>
      <span :class="['text-neutral-500']">分组倍率</span><span>{{ formatNumber(account.billingRate.groupRateMultiplier) }}</span>
      <span :class="['text-neutral-500']">用户倍率</span><span>{{ formatNumber(account.billingRate.userRateMultiplier) }}</span>
      <span :class="['text-neutral-500']">解析倍率</span><span>{{ formatNumber(account.billingRate.resolvedRateMultiplier) }}</span>
      <span :class="['text-neutral-500']">有效倍率</span><span>{{ formatNumber(account.billingRate.effectiveRateMultiplier) }}</span>
      <span :class="['text-neutral-500']">观察时间</span><span>{{ account.billingRate.observedAt || account.fetchedAt }}</span>
    </div>
    <Callout v-for="failure in account?.partialErrors" :key="failure.source" theme="orange" :label="`${failure.source} 查询失败`">
      {{ failure.message }}
    </Callout>
  </section>
</template>
