<script setup lang="ts">
import { Button, Callout, FieldCheckbox, FieldInput } from '@proj-airi/ui'
import { computed, shallowRef } from 'vue'

import AgentRuntimeSettings from '../components/AgentRuntimeSettings.vue'
import ManagerPage from '../components/ManagerPage.vue'

import { SERVER_PROVIDER_PRESETS } from '../provider-catalog'
import { useServerManager } from '../useServerManager'

const manager = useServerManager()
const view = shallowRef<'catalog' | 'config' | 'advanced'>('catalog')
const search = shallowRef('')
const filteredProviders = computed(() => {
  const query = search.value.trim().toLowerCase()
  return query ? SERVER_PROVIDER_PRESETS.filter(item => `${item.name} ${item.description}`.toLowerCase().includes(query)) : SERVER_PROVIDER_PRESETS
})
const deprecatedDeepSeek = computed(() => manager.configDraft.modelProviderId === 'deepseek' && ['deepseek-chat', 'deepseek-reasoner'].includes(manager.configDraft.modelName))
const region = computed({
  get: () => String(manager.configDraft.modelProviderOptions.region ?? 'us-east-1'),
  set: (value) => {
    manager.configDraft.modelProviderOptions.region = value
    if (manager.configDraft.modelProviderId === 'amazon-bedrock')
      manager.configDraft.modelBaseURL = `https://bedrock-mantle.${value}.api.aws/v1/`
  },
})
const apiVersion = computed({
  get: () => String(manager.configDraft.modelProviderOptions.apiVersion ?? '2024-04-01-preview'),
  set: value => manager.configDraft.modelProviderOptions.apiVersion = value,
})
const accountId = computed({
  get: () => String(manager.configDraft.modelProviderOptions.accountId ?? ''),
  set: value => manager.configDraft.modelProviderOptions.accountId = value,
})

function selectProvider(id: string) {
  manager.selectProvider(id)
  view.value = 'config'
}
</script>

<template>
  <ManagerPage title="模型与意识" description="选择服务商、验证模型连接，再配置 Lumi 的回复与工具调用策略。" icon="i-solar:magic-stick-2-bold-duotone">
    <template #actions>
      <Button v-if="view !== 'catalog'" variant="secondary" label="服务商目录" icon="i-solar:arrow-left-linear" @click="view = 'catalog'" />
    </template>
    <div :class="['flex w-fit gap-1 rounded-md bg-neutral-100 p-1 dark:bg-neutral-900']">
      <button v-for="tab in [{ id: 'catalog', label: '选择服务商', icon: 'i-solar:server-square-cloud-bold-duotone' }, { id: 'config', label: '连接与模型', icon: 'i-solar:link-circle-bold-duotone' }, { id: 'advanced', label: '意识参数', icon: 'i-solar:tuning-2-bold-duotone' }]" :key="tab.id" type="button" :class="['relative h-8 px-4 text-sm', view === tab.id ? 'text-cyan-800 dark:text-cyan-200' : 'text-neutral-500']" @click="manager.clearNotices(); view = tab.id as typeof view">
        <span v-if="view === tab.id" :class="['absolute inset-0 rounded bg-white shadow-sm transition-all duration-200 dark:bg-neutral-800']" />
        <span :class="['relative flex items-center gap-2']"><span :class="[tab.icon, 'inline-block size-4']" />{{ tab.label }}</span>
      </button>
    </div>

    <Transition name="consciousness-view" mode="out-in">
      <div :key="view">
        <div v-if="view === 'catalog'" :class="['flex flex-col gap-4']">
          <div :class="['relative max-w-md']">
            <span :class="['i-solar:magnifer-linear absolute left-3 top-2.5 size-4 text-neutral-400']" />
            <input v-model="search" type="search" placeholder="搜索服务商" :class="['h-10 w-full rounded-md border border-neutral-200 bg-transparent pl-9 pr-3 text-sm outline-none focus:border-cyan-500 dark:border-neutral-800']">
          </div>
          <div :class="['grid grid-cols-2 gap-2 xl:grid-cols-3']">
            <button v-for="(item, index) in filteredProviders" :key="item.id" v-motion :initial="{ opacity: 0, y: 8 }" :enter="{ opacity: 1, y: 0, transition: { delay: Math.min(index * 22, 220) } }" type="button" :class="['flex min-h-20 items-center gap-3 rounded-md border p-3 text-left transition-colors', manager.configDraft.modelProviderId === item.id ? 'border-cyan-400 bg-cyan-50 dark:bg-cyan-950/30' : 'border-neutral-200 hover:border-neutral-400 dark:border-neutral-800 dark:hover:border-neutral-600']" @click="selectProvider(item.id)">
              <span :class="[item.icon, 'inline-block size-8 shrink-0']" />
              <span :class="['min-w-0']"><span :class="['block truncate text-sm font-medium']">{{ item.name }}</span><span :class="['mt-0.5 line-clamp-2 block text-xs text-neutral-500']">{{ item.description }}</span></span>
              <span v-if="manager.configDraft.modelProviderId === item.id" :class="['i-solar:check-circle-bold ml-auto size-5 shrink-0 text-cyan-600']" />
            </button>
          </div>
        </div>

        <div v-else-if="view === 'config'" :class="['grid grid-cols-[minmax(0,1fr)_260px] gap-8']">
          <div :class="['flex flex-col gap-4']">
            <div :class="['flex items-center gap-3 border-b border-neutral-200 pb-4 dark:border-neutral-800']">
              <span :class="[manager.provider.value.icon, 'inline-block size-9 shrink-0']" /><div>
                <div :class="['font-semibold']">
                  {{ manager.provider.value.name }}
                </div><div :class="['text-xs text-neutral-500']">
                  {{ manager.provider.value.description }}
                </div>
              </div>
            </div>
            <FieldInput v-model="manager.configDraft.modelBaseURL" label="API Base URL" />
            <FieldInput v-model="manager.configDraft.modelApiKey" type="password" :placeholder="manager.state.value?.config.model.apiKeySet ? '已安全保存，留空保持不变' : '输入 API Key'" label="API Key" />
            <FieldInput v-if="manager.provider.value.fields?.includes('region')" v-model="region" label="AWS Region" />
            <FieldInput v-if="manager.provider.value.fields?.includes('apiVersion')" v-model="apiVersion" label="Azure API Version" />
            <FieldInput v-if="manager.provider.value.fields?.includes('accountId')" v-model="accountId" label="Cloudflare Account ID" />
            <div :class="['grid grid-cols-[minmax(0,1fr)_auto] items-end gap-2']">
              <label :class="['flex flex-col gap-1.5 text-sm']"><span>意识模型</span><input v-model="manager.configDraft.modelName" list="server-provider-models" :class="['h-10 rounded-md border border-neutral-200 bg-transparent px-3 outline-none focus:border-cyan-500 dark:border-neutral-800']"><datalist id="server-provider-models"><option v-for="model in manager.models.value" :key="model.id" :value="model.id" /></datalist></label>
              <Button variant="secondary" label="获取模型" icon="i-solar:list-bold-duotone" :loading="manager.providerBusy.value === 'models'" @click="manager.fetchModels" />
            </div>
            <Callout v-if="deprecatedDeepSeek" theme="orange" label="模型即将弃用">
              DeepSeek 已将该别名标记为弃用，请改用 deepseek-v4-flash 或 deepseek-v4-pro。
            </Callout>
            <div :class="['flex gap-2 pt-2']">
              <Button label="测试连接" icon="i-solar:wi-fi-router-minimalistic-bold-duotone" :loading="manager.providerBusy.value === 'test'" @click="manager.testProvider" />
              <Button variant="secondary" label="保存并应用" icon="i-solar:diskette-bold-duotone" :loading="manager.busy.value" @click="manager.saveConsciousness" />
            </div>
          </div>
          <aside :class="['border-l border-neutral-200 pl-6 dark:border-neutral-800']">
            <h2 :class="['text-sm font-semibold']">
              连接状态
            </h2>
            <dl :class="['mt-4 space-y-4 text-sm']">
              <div>
                <dt :class="['text-xs text-neutral-500']">
                  服务商
                </dt><dd>{{ manager.provider.value.name }}</dd>
              </div><div>
                <dt :class="['text-xs text-neutral-500']">
                  发现模型
                </dt><dd>{{ manager.models.value.length }}</dd>
              </div><div>
                <dt :class="['text-xs text-neutral-500']">
                  当前模型
                </dt><dd :class="['break-all']">
                  {{ manager.configDraft.modelName || '尚未选择' }}
                </dd>
              </div>
            </dl>
            <div v-if="manager.provider.value.balance" :class="['mt-6 border-t border-neutral-200 pt-5 dark:border-neutral-800']">
              <Button variant="secondary" label="查询账户余额" icon="i-solar:wallet-money-bold-duotone" :loading="manager.providerBusy.value === 'balance'" @click="manager.fetchBalance" /><div v-for="item in manager.balance.value?.balances" :key="item.currency" :class="['mt-3 text-sm']">
                <span :class="['text-neutral-500']">{{ item.currency }}</span><strong :class="['ml-2 tabular-nums']">{{ item.total }}</strong>
              </div>
            </div>
          </aside>
        </div>

        <div v-else :class="['max-w-2xl space-y-5']">
          <AgentRuntimeSettings />
          <div :class="['grid grid-cols-3 gap-4']">
            <FieldInput v-model="manager.configDraft.modelTemperature" type="number" label="Temperature" /><FieldInput v-model="manager.configDraft.modelMaxOutputTokens" type="number" label="最大输出 Tokens" /><FieldInput v-model="manager.configDraft.modelMaxSteps" type="number" label="最大工具步数" />
          </div>
          <div :class="['grid grid-cols-3 gap-4']">
            <FieldInput v-model="manager.configDraft.modelMaxContextTokens" type="number" label="上下文窗口 Tokens" description="DeepSeek V4 支持 1,000,000 Token。" />
            <FieldInput v-model="manager.configDraft.modelOutputReserveTokens" type="number" label="输出与推理预留" description="为推理和最终回复保留。" />
            <FieldInput v-model="manager.configDraft.modelPromptReserveTokens" type="number" label="人格与工具预留" description="为系统提示、记忆和工具保留。" />
          </div>
          <template v-if="manager.configDraft.modelProviderId === 'deepseek'">
            <label :class="['block text-sm']"><span :class="['mb-1.5 block']">思考模式</span><select v-model="manager.configDraft.modelThinkingMode" :class="['h-10 w-full rounded-md border border-neutral-200 bg-transparent px-3 dark:border-neutral-800']"><option value="auto">跟随模型默认</option><option value="enabled">启用</option><option value="disabled">禁用</option></select></label>
            <label :class="['block text-sm']"><span :class="['mb-1.5 block']">推理强度</span><select v-model="manager.configDraft.modelReasoningEffort" :class="['h-10 w-full rounded-md border border-neutral-200 bg-transparent px-3 dark:border-neutral-800']"><option value="auto">自动</option><option value="high">High</option><option value="max">Max</option></select></label>
          </template>
          <FieldCheckbox
            v-model="manager.configDraft.directLanguageCandidateLearningEnabled"
            label="允许私聊创建新的语言候选（兼容模式）"
            description="默认关闭。私聊反馈仍会调整已有候选，新的表达、黑话与互动行为只从授权学习群获得。"
          />
          <div :class="['border-l-2 border-cyan-400/45 pl-4']">
            <h3 :class="['text-sm font-semibold']">
              授权学习群的独立归纳器
            </h3>
            <p :class="['mt-1 text-xs text-neutral-500']">
              每类归纳器独立执行、持久化和失败重试，不会互相阻塞。
            </p>
          </div>
          <FieldCheckbox v-model="manager.configDraft.groupExpressionLearningEnabled" label="归纳群聊表达" description="学习口癖、短句、标点和多消息节奏。" />
          <FieldCheckbox v-model="manager.configDraft.groupJargonLearningEnabled" label="归纳群聊黑话" description="理解网络用语在具体语境里的含义。" />
          <FieldCheckbox v-model="manager.configDraft.groupBehaviorLearningEnabled" label="归纳群聊互动行为" description="学习接话、追问、吐槽和沉默的社交节奏。" />
          <FieldCheckbox v-model="manager.configDraft.groupPublicKnowledgeLearningEnabled" label="归纳群聊公共知识" description="仅保存当前批次有证据、允许公开复用的群体知识。" />
          <Button label="保存意识参数" icon="i-solar:diskette-bold-duotone" :loading="manager.busy.value" @click="manager.saveConsciousness" />
        </div>
      </div>
    </Transition>
  </ManagerPage>
</template>

<style scoped>
.consciousness-view-enter-active,
.consciousness-view-leave-active {
  transition: opacity 180ms ease, transform 240ms cubic-bezier(.22, 1, .36, 1);
}
.consciousness-view-enter-from { opacity: 0; transform: translateX(14px); }
.consciousness-view-leave-to { opacity: 0; transform: translateX(-8px); }
@media (prefers-reduced-motion: reduce) {
  .consciousness-view-enter-active,
  .consciousness-view-leave-active { transition-duration: 1ms; }
}
</style>
