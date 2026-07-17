<script setup lang="ts">
import type { LumiUserProfileEntry, LumiUserProfileKey, LumiUserProfileLayer } from '@proj-airi/stage-ui/stores/lumi-user-profile'

import {
  LUMI_BOOTSTRAP_PROFILE_VERSION,
  keyLabel,
  layerLabel,
  useLumiUserProfileStore,
} from '@proj-airi/stage-ui/stores/lumi-user-profile'
import { useChatOrchestratorStore } from '@proj-airi/stage-ui/stores/chat'
import { Button, DoubleCheckButton } from '@proj-airi/ui'
import { storeToRefs } from 'pinia'
import { computed, reactive, ref } from 'vue'

const profileStore = useLumiUserProfileStore()
const chatOrchestratorStore = useChatOrchestratorStore()
const {
  activeEntries,
  coreEntries,
  dynamicEntries,
  dailyEntries,
  pendingActiveUpdates,
  recentEvents,
  autoUpdateEnabled,
  bootstrapStatus,
  persistenceReady,
  persistenceMode,
  persistenceDbPath,
  persistenceLastError,
} = storeToRefs(profileStore)

const copied = ref(false)
const showBootstrapPreview = ref(false)
const reviewingPendingIds = ref<string[]>([])
const newEntry = reactive<{
  layer: LumiUserProfileLayer
  key: LumiUserProfileKey
  value: string
}>({
  layer: 'dynamic',
  key: 'current_focus',
  value: '',
})
const editValues = reactive<Record<string, string>>({})
const bootstrapPreview = computed(() => profileStore.previewBootstrapProfile().slice(0, 12))

const sections = computed(() => [
  { id: 'core', title: '基础锚点', entries: coreEntries.value, tone: 'cyan' },
  { id: 'dynamic', title: '动态画像', entries: dynamicEntries.value, tone: 'emerald' },
  { id: 'daily', title: '每日状态', entries: dailyEntries.value, tone: 'amber' },
])

const keyOptions: Array<{ key: LumiUserProfileKey, layer: LumiUserProfileLayer, label: string }> = [
  { key: 'nickname', layer: 'core', label: '昵称' },
  { key: 'long_term_goals', layer: 'core', label: '长期目标' },
  { key: 'long_term_identity', layer: 'core', label: '长期身份与背景' },
  { key: 'long_term_interests', layer: 'core', label: '长期兴趣' },
  { key: 'learning_direction', layer: 'core', label: '学习方向' },
  { key: 'communication_preference', layer: 'core', label: '沟通偏好' },
  { key: 'relationship_to_lumi', layer: 'core', label: '与 Lumi 的关系认知' },
  { key: 'emotional_patterns', layer: 'core', label: '情绪模式' },
  { key: 'strengths', layer: 'core', label: '长期优势' },
  { key: 'encouragement_guidelines', layer: 'core', label: '鼓励方式' },
  { key: 'project_context', layer: 'core', label: '项目背景' },
  { key: 'relationship_guidelines', layer: 'core', label: '关系理解' },
  { key: 'important_understanding', layer: 'core', label: '重要理解' },
  { key: 'identity', layer: 'core', label: '身份认知' },
  { key: 'personality_traits', layer: 'core', label: '长期性格判断' },
  { key: 'relationship_boundary', layer: 'core', label: '关系边界' },
  { key: 'life_decisions', layer: 'core', label: '重大人生决定' },
  { key: 'current_focus', layer: 'dynamic', label: '当前关注' },
  { key: 'recent_interests', layer: 'dynamic', label: '近期兴趣' },
  { key: 'active_project', layer: 'dynamic', label: '当前项目' },
  { key: 'unresolved_problem', layer: 'dynamic', label: '未解决问题' },
  { key: 'current_learning_topic', layer: 'dynamic', label: '当前学习主题' },
  { key: 'mood', layer: 'daily', label: '今日情绪' },
  { key: 'energy', layer: 'daily', label: '今日精力' },
  { key: 'focus_level', layer: 'daily', label: '今日专注度' },
  { key: 'main_activity', layer: 'daily', label: '今日主要活动' },
  { key: 'pressure_source', layer: 'daily', label: '今日压力来源' },
]

const filteredKeyOptions = computed(() => keyOptions.filter(option => option.layer === newEntry.layer))

function syncKeyLayer() {
  const option = keyOptions.find(item => item.key === newEntry.key)
  if (option?.layer !== newEntry.layer)
    newEntry.key = filteredKeyOptions.value[0]?.key ?? 'current_focus'
}

function addEntry() {
  const value = newEntry.value.trim()
  if (!value)
    return

  profileStore.createManualEntry({
    layer: newEntry.layer,
    key: newEntry.key,
    value,
  })
  newEntry.value = ''
}

function importBootstrap() {
  profileStore.importBootstrapProfile()
}

function editValueFor(entry: LumiUserProfileEntry) {
  return editValues[entry.id] ?? entry.value
}

function updateEditValue(entryId: string, value: string) {
  editValues[entryId] = value
}

function saveEntry(entry: LumiUserProfileEntry) {
  const value = editValueFor(entry).trim()
  if (!value)
    return
  profileStore.updateEntry(entry.id, { value })
  delete editValues[entry.id]
}

function rollback(entry: LumiUserProfileEntry) {
  profileStore.rollbackEntry(entry.id)
}

async function reviewAndApprovePending(pendingId: string) {
  if (reviewingPendingIds.value.includes(pendingId))
    return

  reviewingPendingIds.value = [...reviewingPendingIds.value, pendingId]
  try {
    await chatOrchestratorStore.reviewAndApproveLumiUserProfilePending(pendingId)
  }
  finally {
    reviewingPendingIds.value = reviewingPendingIds.value.filter(id => id !== pendingId)
  }
}

async function exportProfile() {
  const raw = JSON.stringify(profileStore.exportSnapshot(), null, 2)
  await navigator.clipboard?.writeText(raw)
  copied.value = true
  window.setTimeout(() => {
    copied.value = false
  }, 1600)
}

function sourcePreview(entry: LumiUserProfileEntry) {
  const shown = entry.source
    .slice(0, 8)
    .map(source => `${source.kind}: ${source.quote}`)
    .join('\n')
  const hiddenCount = Math.max(0, entry.source.length - 8)
  return hiddenCount
    ? `${shown}\n... 还有 ${hiddenCount} 条证据`
    : shown
}

function pendingReviewLabel(pending: { source: unknown[], confidence: number, reason: string, autoReview?: { decision?: string } }) {
  if (pending.autoReview?.decision === 'approve')
    return '已自动确认'
  if (pending.autoReview?.decision === 'reject')
    return '已自动拒绝'
  if (pending.autoReview?.decision === 'keep_pending')
    return '意识模型暂缓，等待新证据'
  const protectedConflict = pending.reason.includes('protected_conflict:')
  const evidenceCount = Math.min(pending.source.length, 20)
  const evidenceScore = Math.log1p(evidenceCount) / Math.log1p(20)
  const maturity = Math.min(1, Math.max(0, evidenceScore * 0.62 + pending.confidence * 0.38))
  const minEvidence = protectedConflict ? 3 : 2
  const minMaturity = protectedConflict ? 0.66 : 0.58
  return pending.source.length >= minEvidence && maturity >= minMaturity
    ? `等待意识模型审阅 · 成熟度 ${maturity.toFixed(2)}`
    : `等待更多印象 · 成熟度 ${maturity.toFixed(2)}`
}
</script>

<template>
  <div :class="['border-2 border-sky-200/60 rounded-xl bg-sky-50/80 p-4 shadow-sm', 'dark:border-sky-500/10 dark:bg-sky-500/10']">
    <div :class="['mb-4 grid grid-cols-1 items-start gap-3 xl:grid-cols-[minmax(0,1fr)_auto]']">
      <div :class="['flex min-w-0 flex-col gap-2']">
        <div :class="['flex flex-wrap items-center gap-2']">
          <div :class="['i-solar:user-id-bold-duotone size-5 text-sky-700 dark:text-sky-300']" />
          <div :class="['text-lg text-sky-950 font-medium dark:text-sky-50']">
            Lumi 用户画像
          </div>
          <div :class="['rounded-md bg-white/70 px-2 py-0.5 text-xs text-sky-800 dark:bg-neutral-950/30 dark:text-sky-100']">
            {{ activeEntries.length }} 条 active
          </div>
          <div v-if="pendingActiveUpdates.length" :class="['rounded-md bg-amber-500/15 px-2 py-0.5 text-xs text-amber-800 dark:text-amber-200']">
            {{ pendingActiveUpdates.length }} 条待确认
          </div>
        </div>
        <p :class="['text-sm text-neutral-700 dark:text-neutral-300']">
          四层画像会随聊天成长，但高影响字段进入待确认区；Daily State 只代表当天，不会覆盖长期锚点。
        </p>
      </div>

      <div :class="['flex flex-wrap gap-2 xl:justify-end']">
        <Button
          variant="secondary"
          size="sm"
          :icon="autoUpdateEnabled ? 'i-solar:pause-circle-line-duotone' : 'i-solar:play-circle-line-duotone'"
          :label="autoUpdateEnabled ? '禁用自动更新' : '启用自动更新'"
          @click="profileStore.setAutoUpdateEnabled(!autoUpdateEnabled)"
        />
        <Button
          variant="secondary"
          size="sm"
          :icon="copied ? 'i-solar:check-circle-bold-duotone' : 'i-solar:copy-line-duotone'"
          :label="copied ? '已复制' : '导出 JSON'"
          @click="exportProfile"
        />
        <DoubleCheckButton variant="danger" size="sm" @confirm="profileStore.clearProfile">
          清空画像
          <template #confirm>
            确认清空
          </template>
          <template #cancel>
            取消
          </template>
        </DoubleCheckButton>
      </div>
    </div>

    <div :class="['mb-4 rounded-lg border border-emerald-200 bg-emerald-50/80 p-3 dark:border-emerald-800/50 dark:bg-emerald-950/25']">
      <div :class="['mb-2 flex flex-wrap items-center gap-2 text-sm text-emerald-950 font-medium dark:text-emerald-100']">
        <div :class="['i-solar:database-bold-duotone size-4']" />
        SQLite 持久化
        <span :class="['rounded-md bg-white/70 px-2 py-0.5 text-xs text-emerald-800 dark:bg-neutral-950/30 dark:text-emerald-100']">
          {{ persistenceMode }}
        </span>
        <span :class="['rounded-md bg-white/70 px-2 py-0.5 text-xs text-emerald-800 dark:bg-neutral-950/30 dark:text-emerald-100']">
          {{ persistenceReady ? '已加载' : '加载中' }}
        </span>
      </div>
      <div :class="['break-all text-xs text-neutral-700 dark:text-neutral-300']">
        {{ persistenceDbPath || '当前使用 localStorage 回退，尚未连接 SQLite。' }}
      </div>
      <div v-if="persistenceLastError" :class="['mt-2 rounded-md border border-amber-200 bg-amber-50 px-2 py-1 text-xs text-amber-800 dark:border-amber-800/50 dark:bg-amber-950/25 dark:text-amber-200']">
        最近持久化错误：{{ persistenceLastError }}
      </div>
    </div>

    <div :class="['mb-4 rounded-lg border border-violet-200 bg-violet-50/80 p-3 dark:border-violet-800/50 dark:bg-violet-950/25']">
      <div :class="['grid grid-cols-1 items-start gap-3 xl:grid-cols-[minmax(0,1fr)_auto]']">
        <div :class="['min-w-0']">
          <div :class="['mb-2 flex flex-wrap items-center gap-2 text-sm text-violet-950 font-medium dark:text-violet-100']">
            <div :class="['i-solar:bookmark-square-bold-duotone size-4']" />
            Bootstrap Profile 初始认知锚点
            <span :class="['rounded-md bg-white/70 px-2 py-0.5 text-xs text-violet-800 dark:bg-neutral-950/30 dark:text-violet-100']">
              {{ bootstrapStatus.imported ? '已导入' : '未导入' }}
            </span>
          </div>
          <div :class="['grid grid-cols-2 gap-2 lg:grid-cols-4']">
            <div :class="['rounded-md bg-white/70 p-2 dark:bg-neutral-950/30']">
              <div :class="['text-xs text-neutral-500 dark:text-neutral-400']">当前版本</div>
              <div :class="['break-all text-sm text-neutral-900 dark:text-neutral-50']">{{ bootstrapStatus.currentVersion || '无' }}</div>
            </div>
            <div :class="['rounded-md bg-white/70 p-2 dark:bg-neutral-950/30']">
              <div :class="['text-xs text-neutral-500 dark:text-neutral-400']">默认版本</div>
              <div :class="['break-all text-sm text-neutral-900 dark:text-neutral-50']">{{ LUMI_BOOTSTRAP_PROFILE_VERSION }}</div>
            </div>
            <div :class="['rounded-md bg-white/70 p-2 dark:bg-neutral-950/30']">
              <div :class="['text-xs text-neutral-500 dark:text-neutral-400']">已导入条目</div>
              <div :class="['text-sm text-neutral-900 dark:text-neutral-50']">{{ bootstrapStatus.importedCount }}</div>
            </div>
            <div :class="['rounded-md bg-white/70 p-2 dark:bg-neutral-950/30']">
              <div :class="['text-xs text-neutral-500 dark:text-neutral-400']">受保护条目</div>
              <div :class="['text-sm text-neutral-900 dark:text-neutral-50']">{{ bootstrapStatus.protectedCount }}</div>
            </div>
          </div>
          <p :class="['mt-2 text-xs text-neutral-600 dark:text-neutral-300']">
            导入会写入 Core Profile，但不会静默覆盖用户手动修改；版本冲突会进入待确认更新。
          </p>
        </div>
        <div :class="['flex flex-wrap gap-2 xl:justify-end']">
          <Button
            variant="secondary"
            size="sm"
            :icon="showBootstrapPreview ? 'i-solar:alt-arrow-up-line-duotone' : 'i-solar:alt-arrow-down-line-duotone'"
            :label="showBootstrapPreview ? '收起预览' : '预览'"
            @click="showBootstrapPreview = !showBootstrapPreview"
          />
          <DoubleCheckButton variant="primary" size="sm" @confirm="importBootstrap">
            {{ bootstrapStatus.imported ? '重新导入' : '导入初始认知锚点' }}
            <template #confirm>
              确认导入
            </template>
            <template #cancel>
              取消
            </template>
          </DoubleCheckButton>
        </div>
      </div>
      <div v-if="showBootstrapPreview" :class="['mt-3 grid grid-cols-1 gap-2 lg:grid-cols-2']">
        <div
          v-for="item in bootstrapPreview"
          :key="item.bootstrapId"
          :class="['rounded-md bg-white/75 p-2 text-xs dark:bg-neutral-950/30']"
        >
          <div :class="['mb-1 text-neutral-900 font-medium dark:text-neutral-50']">
            {{ keyLabel(item.key) }} · {{ item.confidence.toFixed(2) }} · protected
          </div>
          <div :class="['text-neutral-700 dark:text-neutral-300']">
            {{ item.value }}
          </div>
        </div>
      </div>
    </div>

    <div :class="['mb-4 grid grid-cols-1 gap-2 lg:grid-cols-[160px_220px_minmax(0,1fr)_auto]']">
      <select
        v-model="newEntry.layer"
        :class="['rounded-lg border border-sky-200 bg-white/80 px-3 py-2 text-sm outline-none dark:border-sky-900 dark:bg-neutral-950/40']"
        @change="syncKeyLayer"
      >
        <option value="core">
          基础锚点
        </option>
        <option value="dynamic">
          动态画像
        </option>
        <option value="daily">
          每日状态
        </option>
      </select>
      <select
        v-model="newEntry.key"
        :class="['rounded-lg border border-sky-200 bg-white/80 px-3 py-2 text-sm outline-none dark:border-sky-900 dark:bg-neutral-950/40']"
      >
        <option v-for="option in filteredKeyOptions" :key="option.key" :value="option.key">
          {{ option.label }}
        </option>
      </select>
      <input
        v-model="newEntry.value"
        :class="['min-w-0 rounded-lg border border-sky-200 bg-white/80 px-3 py-2 text-sm outline-none dark:border-sky-900 dark:bg-neutral-950/40']"
        placeholder="手动添加画像..."
        @keydown.enter.prevent="addEntry"
      >
      <Button variant="primary" size="sm" icon="i-solar:add-circle-line-duotone" label="添加" @click="addEntry" />
    </div>

    <div v-if="pendingActiveUpdates.length" :class="['mb-4 rounded-lg border border-amber-200 bg-amber-50/80 p-3 dark:border-amber-800/50 dark:bg-amber-950/30']">
      <div :class="['mb-2 flex items-center gap-2 text-sm text-amber-900 font-medium dark:text-amber-100']">
        <div :class="['i-solar:shield-warning-line-duotone size-4']" />
        待确认更新
      </div>
      <div :class="['mb-2']">
        <Button
          variant="secondary"
          size="sm"
          icon="i-solar:database-line-duotone"
          label="整理同类印象"
          @click="profileStore.consolidatePendingUpdates()"
        />
      </div>
      <div :class="['flex flex-col gap-2']">
        <div
          v-for="pending in pendingActiveUpdates"
          :key="pending.id"
          :class="['rounded-md bg-white/75 p-2 text-sm dark:bg-neutral-950/30']"
        >
          <div :class="['mb-1 text-neutral-900 dark:text-neutral-50']">
            {{ keyLabel(pending.key) }}：{{ pending.value }}
          </div>
          <div :class="['mb-2 text-xs text-neutral-600 dark:text-neutral-300']">
            置信度 {{ pending.confidence.toFixed(2) }} · {{ pending.reason }}
          </div>
          <div :class="['mb-2 rounded-md bg-amber-100/70 px-2 py-1 text-xs text-amber-900 dark:bg-amber-900/20 dark:text-amber-100']">
            自动审阅：{{ pendingReviewLabel(pending) }}
            <span v-if="pending.autoReview?.evidenceCount"> · 证据 {{ pending.autoReview.evidenceCount }}</span>
            <span v-else> · 证据 {{ pending.source.length }}</span>
            <span v-if="pending.autoReview?.summary"> · {{ pending.autoReview.summary }}</span>
          </div>
          <div :class="['flex flex-wrap gap-2']">
            <Button
              variant="secondary"
              size="sm"
              icon="i-solar:check-circle-line-duotone"
              label="意识审阅写入"
              :loading="reviewingPendingIds.includes(pending.id)"
              @click="reviewAndApprovePending(pending.id)"
            />
            <Button variant="secondary" size="sm" icon="i-solar:database-line-duotone" label="直接写入" @click="profileStore.approvePending(pending.id)" />
            <Button variant="secondary" size="sm" icon="i-solar:close-circle-line-duotone" label="拒绝" @click="profileStore.rejectPending(pending.id)" />
          </div>
        </div>
      </div>
    </div>

    <div :class="['grid grid-cols-1 gap-3 2xl:grid-cols-3']">
      <section
        v-for="section in sections"
        :key="section.id"
        :class="['min-w-0 rounded-lg bg-white/70 p-3 dark:bg-neutral-950/30']"
      >
        <div :class="['mb-2 flex items-center justify-between gap-2']">
          <div :class="['text-sm font-medium']">
            {{ section.title }}
          </div>
          <div :class="['rounded-md bg-neutral-100 px-2 py-0.5 text-xs text-neutral-600 dark:bg-neutral-900 dark:text-neutral-300']">
            {{ section.entries.length }}
          </div>
        </div>

        <div :class="['flex max-h-128 flex-col gap-2 overflow-auto pr-1']">
          <details
            v-for="entry in section.entries"
            :key="entry.id"
            :class="['rounded-md border border-neutral-200/70 bg-white/80 p-2 dark:border-neutral-800 dark:bg-neutral-950/40']"
          >
            <summary :class="['cursor-pointer select-none text-sm outline-none']">
              <span :class="['font-medium']">{{ keyLabel(entry.key) }}</span>
              <span :class="['ml-2 text-xs text-neutral-500']">{{ entry.confidence.toFixed(2) }}</span>
              <span v-if="entry.protected" :class="['ml-2 rounded bg-violet-500/10 px-1.5 py-0.5 text-xs text-violet-700 dark:text-violet-200']">protected</span>
            </summary>
            <div :class="['mt-2 flex flex-col gap-2']">
              <textarea
                :value="editValueFor(entry)"
                :class="['min-h-18 w-full resize-y rounded-md border border-neutral-200 bg-white/80 px-2 py-1 text-sm outline-none dark:border-neutral-800 dark:bg-neutral-950/60']"
                @input="updateEditValue(entry.id, ($event.target as HTMLTextAreaElement).value)"
              />
              <div :class="['text-xs text-neutral-500 dark:text-neutral-400']">
                层级 {{ layerLabel(entry.layer) }} · 权重 {{ entry.weight.toFixed(2) }} · 更新 {{ new Date(entry.updatedAt).toLocaleString() }}
              </div>
              <div v-if="entry.bootstrapVersion" :class="['text-xs text-violet-700 dark:text-violet-200']">
                Bootstrap {{ entry.bootstrapVersion }} · 创建 {{ new Date(entry.createdAt).toLocaleString() }}
              </div>
              <div v-if="entry.source.length" :class="['text-xs text-neutral-500 dark:text-neutral-400']">
                证据 {{ entry.source.length }} 条
              </div>
              <pre v-if="entry.source.length" :class="['max-h-32 overflow-auto whitespace-pre-wrap break-words rounded-md bg-neutral-100 p-2 text-xs text-neutral-600 dark:bg-neutral-900 dark:text-neutral-300']">{{ sourcePreview(entry) }}</pre>
              <div v-if="entry.history.length" :class="['text-xs text-neutral-500 dark:text-neutral-400']">
                历史 {{ entry.history.length }} 条 · 最近旧值：{{ entry.history[0]?.previousValue }}
              </div>
              <div :class="['flex flex-wrap gap-2']">
                <Button variant="secondary" size="sm" icon="i-solar:diskette-line-duotone" label="保存" @click="saveEntry(entry)" />
                <Button variant="secondary" size="sm" icon="i-solar:rewind-back-line-duotone" label="回滚" :disabled="entry.history.length === 0" @click="rollback(entry)" />
                <Button variant="secondary" size="sm" icon="i-solar:archive-down-line-duotone" label="归档" @click="profileStore.updateEntry(entry.id, { status: 'archived' })" />
                <Button variant="secondary" size="sm" icon="i-solar:trash-bin-trash-line-duotone" label="删除" @click="profileStore.deleteEntry(entry.id)" />
              </div>
            </div>
          </details>
          <div v-if="section.entries.length === 0" :class="['rounded-md border border-dashed border-neutral-200 p-3 text-sm text-neutral-500 dark:border-neutral-800 dark:text-neutral-400']">
            暂无{{ section.title }}。
          </div>
        </div>
      </section>
    </div>

    <details :class="['mt-4 rounded-lg bg-white/60 p-3 dark:bg-neutral-950/20']">
      <summary :class="['cursor-pointer select-none text-sm font-medium outline-none']">
        更新历史
      </summary>
      <div :class="['mt-2 flex max-h-48 flex-col gap-1 overflow-auto']">
        <div
          v-for="event in recentEvents"
          :key="event.id"
          :class="['rounded-md bg-neutral-50 px-2 py-1 text-xs text-neutral-600 dark:bg-neutral-900/60 dark:text-neutral-300']"
        >
          {{ new Date(event.createdAt).toLocaleString() }} · {{ event.kind }} · {{ event.key ? keyLabel(event.key) : '' }} {{ event.preview }}
        </div>
        <div v-if="recentEvents.length === 0" :class="['text-xs text-neutral-500']">
          暂无画像历史。
        </div>
      </div>
    </details>
  </div>
</template>
