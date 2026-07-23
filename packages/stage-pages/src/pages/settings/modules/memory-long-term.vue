<script setup lang="ts">
import type { LumiMemoryFragment, LumiMemoryStatus, LumiMemoryType } from '@proj-airi/stage-ui/stores/lumi-memory'

import { useLumiIdentityStore } from '@proj-airi/stage-ui/stores/lumi-identity'
import { useLumiMemoryStore } from '@proj-airi/stage-ui/stores/lumi-memory'
import { Button, DoubleCheckButton } from '@proj-airi/ui'
import { storeToRefs } from 'pinia'
import { computed, reactive, ref, watch } from 'vue'

import MemoryPromotionReview from '../../../components/memoryPromotionReview.vue'

const MEMORY_TYPES: LumiMemoryType[] = [
  'user_preference',
  'user_fact',
  'relationship_event',
  'shared_event',
  'persona_preference',
  'persona_fact',
  'conflict_event',
  'promise',
  'project_context',
  'temporary_context',
  'emotional_echo',
]

const STATUS_FILTERS: Array<LumiMemoryStatus | 'all'> = ['all', 'active', 'candidate', 'rejected', 'archived', 'contradicted']

const TYPE_LABELS: Record<LumiMemoryType | 'all', string> = {
  all: '全部类型',
  user_preference: '用户偏好',
  user_fact: '用户事实',
  relationship_event: '关系事件',
  shared_event: '共同经历',
  persona_preference: '人格偏好',
  persona_fact: 'Lumi 自我事实',
  conflict_event: '冲突事件',
  promise: '承诺',
  project_context: '项目上下文',
  temporary_context: '临时上下文',
  emotional_echo: '情绪回声',
}

const STATUS_LABELS: Record<LumiMemoryStatus | 'all', string> = {
  all: '全部状态',
  active: '活跃',
  candidate: '待审阅',
  rejected: '已拒绝',
  archived: '已归档',
  contradicted: '已冲突',
}

const EVENT_KIND_LABELS: Record<string, string> = {
  search: '检索',
  save: '保存',
  update: '更新',
  promote: '晋升',
  forget: '遗忘',
  delete: '删除',
  reject_duplicate: '拒绝重复',
  merge: '合并',
}

const memoryStore = useLumiMemoryStore()
const identityStore = useLumiIdentityStore()
memoryStore.initialize()

const {
  allMemories,
  inspectableMemories,
  promotionCandidates,
  duplicateMemoryGroups,
  recentMemoryEvents,
  persistenceDbPath,
  persistenceLastError,
  persistenceMode,
  persistenceReady,
  semanticIndexDevice,
  semanticDownloadPercent,
  semanticIndexError,
  semanticIndexLoading,
  semanticIndexedCount,
  semanticIndexProgress,
  semanticIndexReady,
  semanticIndexStatus,
  semanticSearchPoolSize,
} = storeToRefs(memoryStore)
const { activeUserId } = storeToRefs(identityStore)

const query = ref('')
const statusFilter = ref<LumiMemoryStatus | 'all'>('active')
const typeFilter = ref<LumiMemoryType | 'all'>('all')
const selectedId = ref(inspectableMemories.value[0]?.id ?? '')
const savedFlash = ref(false)
const draft = reactive({
  content: '',
  type: 'user_fact' as LumiMemoryType,
  status: 'candidate' as LumiMemoryStatus,
  tagsText: '',
  confidence: 0.8,
  importance: 0.7,
  emotionalIntensity: 0,
  relationshipRelevance: 0.3,
})

const selectedMemory = computed(() => inspectableMemories.value.find(memory => memory.id === selectedId.value))
const selectedMemoryOwnedByViewer = computed(() => selectedMemory.value?.userId === activeUserId.value)

const filteredMemories = computed(() => {
  const lowered = query.value.trim().toLowerCase()
  return inspectableMemories.value
    .filter(memory => statusFilter.value === 'all' || memory.status === statusFilter.value)
    .filter(memory => typeFilter.value === 'all' || memory.type === typeFilter.value)
    .filter((memory) => {
      if (!lowered)
        return true
      return [
        memory.content,
        memory.type,
        memory.status,
        memory.tags.join(' '),
        memory.conversationId ?? '',
      ].join(' ').toLowerCase().includes(lowered)
    })
    .slice(0, 200)
})

const recallPreview = computed(() => {
  if (!query.value.trim())
    return []

  const inspectableIds = new Set(inspectableMemories.value.map(memory => memory.id))
  return memoryStore.retrieve({
    query: query.value,
    userId: 'local',
    personaId: 'lumi',
    limit: 6,
    conversationType: 'direct',
  }).rankedMemories.filter(item => inspectableIds.has(item.memory.id))
})

const activeInspectableMemories = computed(() => inspectableMemories.value.filter(memory => memory.status === 'active'))
const candidateInspectableMemories = computed(() => inspectableMemories.value.filter(memory => memory.status === 'candidate'))
const inspectableStatusCounts = computed(() => {
  const counts = new Map<LumiMemoryStatus, number>()
  for (const memory of inspectableMemories.value)
    counts.set(memory.status, (counts.get(memory.status) ?? 0) + 1)
  return [...counts.entries()].map(([status, count]) => ({ status, count }))
})
const inspectableDuplicateGroups = computed(() => {
  const inspectableIds = new Set(inspectableMemories.value.map(memory => memory.id))
  return duplicateMemoryGroups.value.filter(group => group.memories.every(memory => inspectableIds.has(memory.id)))
})

const stats = computed(() => [
  { label: '可检查', value: inspectableMemories.value.length },
  { label: '活跃', value: activeInspectableMemories.value.length },
  { label: '待审阅', value: candidateInspectableMemories.value.length },
  { label: '当前显示', value: filteredMemories.value.length },
])

const semanticIndexTarget = computed(() => allMemories.value.filter(memory => memory.status !== 'rejected').length)
const semanticIndexMissing = computed(() => Math.max(0, semanticIndexTarget.value - semanticIndexedCount.value))
const semanticIndexPercent = computed(() => {
  if (semanticIndexTarget.value <= 0)
    return 0
  return Math.min(100, Math.round((semanticIndexedCount.value / semanticIndexTarget.value) * 100))
})
const semanticProgressPercent = computed(() => semanticDownloadPercent.value ?? semanticIndexPercent.value)

watch(selectedMemory, (memory) => {
  if (!memory)
    return
  loadDraft(memory)
}, { immediate: true })

watch(filteredMemories, (memories) => {
  if (selectedId.value && memories.some(memory => memory.id === selectedId.value))
    return
  selectedId.value = memories[0]?.id ?? inspectableMemories.value[0]?.id ?? ''
}, { immediate: true })

function loadDraft(memory: LumiMemoryFragment) {
  draft.content = memory.content
  draft.type = memory.type
  draft.status = memory.status
  draft.tagsText = memory.tags.join(', ')
  draft.confidence = memory.confidence
  draft.importance = memory.importance
  draft.emotionalIntensity = memory.emotionalIntensity
  draft.relationshipRelevance = memory.relationshipRelevance
}

function saveSelectedMemory() {
  const memory = selectedMemory.value
  if (!memory)
    return

  memoryStore.updateMemory(memory.id, {
    content: draft.content.trim(),
    type: draft.type,
    status: draft.status,
    tags: parseTags(draft.tagsText),
    confidence: draft.confidence,
    importance: draft.importance,
    emotionalIntensity: draft.emotionalIntensity,
    relationshipRelevance: draft.relationshipRelevance,
  })

  savedFlash.value = true
  window.setTimeout(() => {
    savedFlash.value = false
  }, 1200)
}

function setSelectedStatus(status: LumiMemoryStatus) {
  draft.status = status
  saveSelectedMemory()
}

function deleteSelectedMemory() {
  const memory = selectedMemory.value
  if (!memory)
    return

  memoryStore.deleteMemory(memory.id)
  selectedId.value = filteredMemories.value[0]?.id ?? inspectableMemories.value[0]?.id ?? ''
}

function mergeDuplicateGroup(memoryIds: string[]) {
  const merged = memoryStore.mergeMemories(memoryIds)
  if (!merged)
    return

  statusFilter.value = 'all'
  selectedId.value = merged.id
}

function promoteMemory(memoryId: string) {
  memoryStore.promoteMemoryScope(memoryId)
}

function promoteAllMemories(memoryIds: string[]) {
  memoryStore.promoteMemoryScopes(memoryIds)
}

function createNewMemory() {
  const now = new Date().toISOString()
  const memory = memoryStore.remember({
    id: `manual_${Date.now().toString(36)}`,
    userId: 'local',
    personaId: 'lumi',
    type: 'user_fact',
    content: '新记忆',
    confidence: 0.8,
    importance: 0.7,
    emotionalIntensity: 0,
    relationshipRelevance: 0.3,
    createdAt: now,
    updatedAt: now,
    decay: 0,
    tags: ['manual'],
    status: 'candidate',
  })
  statusFilter.value = 'all'
  selectedId.value = memory.id
}

function continueSemanticIndexing() {
  void memoryStore.initializePersistence()
    .then(() => memoryStore.prewarmSemanticIndex())
    .catch(error => console.warn('[memory-long-term] failed to continue semantic indexing', error))
}

function parseTags(value: string) {
  return value
    .split(',')
    .map(tag => tag.trim())
    .filter(Boolean)
    .slice(0, 12)
}

function formatDate(value?: string) {
  if (!value)
    return '未知'
  const date = new Date(value)
  if (Number.isNaN(date.getTime()))
    return value
  return date.toLocaleString()
}

function typeLabel(type: LumiMemoryType | 'all') {
  return TYPE_LABELS[type] ?? type
}

function statusLabel(status: LumiMemoryStatus | 'all') {
  return STATUS_LABELS[status] ?? status
}

function eventKindLabel(kind: string) {
  return EVENT_KIND_LABELS[kind] ?? kind
}

function semanticStatusLabel(status: string) {
  if (semanticIndexReady.value)
    return '已就绪'
  if (semanticIndexLoading.value)
    return '补向量中'
  if (status === 'fallback')
    return '已回退'
  if (status === 'loading')
    return '加载中'
  if (status === 'ready')
    return '已就绪'
  return '未启动'
}

function statusTone(status: LumiMemoryStatus) {
  if (status === 'active')
    return 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
  if (status === 'candidate')
    return 'bg-amber-500/10 text-amber-700 dark:text-amber-300'
  if (status === 'archived')
    return 'bg-neutral-500/10 text-neutral-600 dark:text-neutral-300'
  return 'bg-rose-500/10 text-rose-700 dark:text-rose-300'
}

function eventTone(kind: string) {
  if (kind === 'search')
    return 'text-sky-700 dark:text-sky-300'
  if (kind === 'save' || kind === 'promote')
    return 'text-emerald-700 dark:text-emerald-300'
  if (kind === 'update' || kind === 'forget')
    return 'text-amber-700 dark:text-amber-300'
  if (kind === 'merge')
    return 'text-violet-700 dark:text-violet-300'
  if (kind === 'delete' || kind === 'reject_duplicate')
    return 'text-rose-700 dark:text-rose-300'
  return 'text-neutral-600 dark:text-neutral-300'
}
</script>

<template>
  <div :class="['flex flex-col gap-4 pb-4']">
    <div :class="['grid grid-cols-2 gap-2 lg:grid-cols-4']">
      <div
        v-for="stat in stats"
        :key="stat.label"
        :class="['rounded-lg bg-white/70 p-3 shadow-sm dark:bg-neutral-950/30']"
      >
        <div :class="['text-xs text-neutral-500 dark:text-neutral-400']">
          {{ stat.label }}
        </div>
        <div :class="['text-xl text-neutral-900 font-semibold tabular-nums dark:text-neutral-50']">
          {{ stat.value }}
        </div>
      </div>
    </div>

    <div :class="['rounded-lg border border-emerald-200 bg-emerald-50/80 p-3 text-sm text-emerald-900 dark:border-emerald-900/60 dark:bg-emerald-950/30 dark:text-emerald-100']">
      <div :class="['flex flex-wrap items-center gap-2']">
        <span :class="['font-semibold']">存储</span>
        <span>{{ persistenceMode === 'sqlite' ? 'SQLite 数据库' : 'localStorage 兜底' }}</span>
        <span :class="['rounded-full px-2 py-0.5 text-xs', persistenceReady ? 'bg-emerald-500/15' : 'bg-amber-500/15']">
          {{ persistenceReady ? '已就绪' : '初始化中' }}
        </span>
      </div>
      <div v-if="persistenceDbPath" :class="['mt-1 break-all font-mono text-xs opacity-80']">
        {{ persistenceDbPath }}
      </div>
      <div v-if="persistenceLastError" :class="['mt-2 rounded-md bg-rose-500/10 p-2 text-xs text-rose-700 dark:text-rose-200']">
        SQLite/后端桥连接失败：{{ persistenceLastError }}
      </div>
    </div>

    <div :class="['rounded-lg border border-cyan-200 bg-cyan-50/80 p-3 text-sm text-cyan-950 dark:border-cyan-900/60 dark:bg-cyan-950/30 dark:text-cyan-100']">
      <div :class="['flex flex-wrap items-center justify-between gap-3']">
        <div :class="['flex flex-col gap-1']">
          <div :class="['flex flex-wrap items-center gap-2']">
            <span :class="['font-semibold']">语义向量索引</span>
            <span :class="['rounded-full px-2 py-0.5 text-xs', semanticIndexReady ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-200' : semanticIndexLoading ? 'bg-cyan-500/15 text-cyan-700 dark:text-cyan-200' : 'bg-neutral-500/15 text-neutral-700 dark:text-neutral-200']">
              {{ semanticStatusLabel(semanticIndexStatus) }}
            </span>
          </div>
          <div :class="['text-xs opacity-80']">
            已索引 {{ semanticIndexedCount }} / {{ semanticIndexTarget }}，缺失 {{ semanticIndexMissing }}，最近搜索池 {{ semanticSearchPoolSize }}
          </div>
          <div :class="['text-xs opacity-80']">
            设备 {{ semanticIndexDevice }}<span v-if="semanticIndexProgress"> · {{ semanticIndexProgress }}</span>
          </div>
        </div>
        <Button
          size="sm"
          variant="secondary"
          icon="i-solar:refresh-line-duotone"
          label="继续补向量"
          :disabled="semanticIndexLoading"
          @click="continueSemanticIndexing"
        />
      </div>
      <div :class="['mt-3 h-2 overflow-hidden rounded-full bg-cyan-950/10 dark:bg-cyan-100/10']">
        <div
          :class="['h-full rounded-full bg-cyan-500 transition-all duration-300']"
          :style="{ width: `${semanticProgressPercent}%` }"
        />
      </div>
      <div v-if="semanticIndexError" :class="['mt-2 rounded-md bg-rose-500/10 p-2 text-xs text-rose-700 dark:text-rose-200']">
        {{ semanticIndexError }}
      </div>
    </div>

    <MemoryPromotionReview
      v-if="promotionCandidates.length"
      :candidates="promotionCandidates"
      @promote="promoteMemory"
      @promote-all="promoteAllMemories"
    />

    <div :class="['grid grid-cols-1 gap-4 xl:grid-cols-[minmax(320px,0.9fr)_minmax(0,1.4fr)]']">
      <section :class="['min-h-0 rounded-lg bg-white/70 p-3 shadow-sm dark:bg-neutral-950/30']">
        <div :class="['mb-3 flex flex-wrap items-center gap-2']">
          <div :class="['relative min-w-[220px] flex-1']">
            <div :class="['i-solar:magnifer-line-duotone pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-neutral-400']" />
            <input
              v-model="query"
              :class="['h-10 w-full rounded-lg border border-neutral-200 bg-white pl-9 pr-3 text-sm outline-none dark:border-neutral-800 dark:bg-neutral-950']"
              placeholder="搜索记忆"
            >
          </div>

          <select
            v-model="statusFilter"
            :class="['h-10 rounded-lg border border-neutral-200 bg-white px-3 text-sm outline-none dark:border-neutral-800 dark:bg-neutral-950']"
          >
            <option v-for="status in STATUS_FILTERS" :key="status" :value="status">
              {{ statusLabel(status) }}
            </option>
          </select>

          <select
            v-model="typeFilter"
            :class="['h-10 rounded-lg border border-neutral-200 bg-white px-3 text-sm outline-none dark:border-neutral-800 dark:bg-neutral-950']"
          >
            <option value="all">
              全部类型
            </option>
            <option v-for="type in MEMORY_TYPES" :key="type" :value="type">
              {{ typeLabel(type) }}
            </option>
          </select>

          <Button size="sm" icon="i-solar:add-circle-line-duotone" label="新建" @click="createNewMemory" />
        </div>

        <div :class="['mb-3 flex flex-wrap gap-2']">
          <div
            v-for="item in inspectableStatusCounts"
            :key="item.status"
            :class="['rounded-md px-2 py-1 text-xs font-medium', statusTone(item.status)]"
          >
            {{ statusLabel(item.status) }}: {{ item.count }}
          </div>
        </div>

        <div :class="['max-h-[62vh] overflow-auto pr-1']">
          <button
            v-for="memory in filteredMemories"
            :key="memory.id"
            :class="[
              'mb-2 block w-full rounded-lg border p-3 text-left transition',
              selectedId === memory.id
                ? 'border-cyan-300 bg-cyan-50 dark:border-cyan-500/40 dark:bg-cyan-500/10'
                : 'border-neutral-200 bg-white/80 hover:border-neutral-300 dark:border-neutral-800 dark:bg-neutral-950/40 dark:hover:border-neutral-700',
            ]"
            @click="selectedId = memory.id"
          >
            <div :class="['mb-2 flex items-center justify-between gap-2']">
              <span :class="['truncate text-xs text-neutral-500 dark:text-neutral-400']">{{ typeLabel(memory.type) }}</span>
              <span :class="['shrink-0 rounded px-2 py-0.5 text-xs font-medium', statusTone(memory.status)]">{{ statusLabel(memory.status) }}</span>
            </div>
            <div :class="['line-clamp-3 text-sm text-neutral-800 dark:text-neutral-100']">
              {{ memory.content }}
            </div>
            <div :class="['mt-2 flex flex-wrap gap-1']">
              <span
                v-for="tag in memory.tags.slice(0, 4)"
                :key="tag"
                :class="['rounded bg-neutral-100 px-1.5 py-0.5 text-[11px] text-neutral-500 dark:bg-neutral-900 dark:text-neutral-400']"
              >
                {{ tag }}
              </span>
            </div>
          </button>

          <div v-if="filteredMemories.length === 0" :class="['rounded-lg border border-dashed border-neutral-300 p-6 text-center text-sm text-neutral-500 dark:border-neutral-800 dark:text-neutral-400']">
            没有符合当前筛选条件的记忆。
          </div>
        </div>
      </section>

      <section :class="['rounded-lg bg-white/70 p-4 shadow-sm dark:bg-neutral-950/30']">
        <div v-if="selectedMemory" :class="['flex flex-col gap-4']">
          <div :class="['flex flex-wrap items-start justify-between gap-3']">
            <div>
              <div :class="['text-lg text-neutral-900 font-semibold dark:text-neutral-50']">
                记忆编辑器
              </div>
              <div :class="['text-xs text-neutral-500 dark:text-neutral-400']">
                更新于 {{ formatDate(selectedMemory.updatedAt) }}
              </div>
            </div>
            <div v-if="selectedMemoryOwnedByViewer" :class="['flex flex-wrap gap-2']">
              <Button variant="secondary" size="sm" icon="i-solar:check-circle-line-duotone" label="设为活跃" @click="setSelectedStatus('active')" />
              <Button variant="secondary" size="sm" icon="i-solar:archive-line-duotone" label="归档" @click="setSelectedStatus('archived')" />
              <Button variant="secondary" size="sm" icon="i-solar:close-circle-line-duotone" label="拒绝" @click="setSelectedStatus('rejected')" />
              <DoubleCheckButton variant="danger" size="sm" @confirm="deleteSelectedMemory">
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

          <textarea
            v-model="draft.content"
            :readonly="!selectedMemoryOwnedByViewer"
            :class="['min-h-32 w-full resize-y rounded-lg border border-neutral-200 bg-white p-3 text-sm leading-6 outline-none dark:border-neutral-800 dark:bg-neutral-950']"
          />

          <div :class="['grid grid-cols-1 gap-2 rounded-lg bg-neutral-50 p-3 text-xs text-neutral-600 md:grid-cols-2 dark:bg-neutral-950/50 dark:text-neutral-300']">
            <div>
              <span :class="['text-neutral-400']">范围</span> {{ selectedMemory.scope }}
            </div>
            <div>
              <span :class="['text-neutral-400']">来源会话</span> {{ selectedMemory.sourceConversationType }}
            </div>
            <div v-if="selectedMemoryOwnedByViewer && selectedMemory.sourceActorId">
              <span :class="['text-neutral-400']">来源身份</span> {{ selectedMemory.sourceActorId }}
            </div>
            <div>
              <span :class="['text-neutral-400']">可见性</span> {{ selectedMemory.visibility }}
            </div>
            <div :class="['md:col-span-2']">
              <span :class="['text-neutral-400']">分类依据</span> {{ selectedMemory.classificationReason }}
            </div>
            <div :class="['md:col-span-2']">
              <span :class="['text-neutral-400']">披露规则</span> {{ selectedMemory.disclosureReason }}
            </div>
          </div>

          <div :class="['grid grid-cols-1 gap-3 md:grid-cols-2']">
            <label :class="['flex flex-col gap-1 text-xs text-neutral-500 dark:text-neutral-400']">
              类型
              <select v-model="draft.type" :disabled="!selectedMemoryOwnedByViewer" :class="['h-10 rounded-lg border border-neutral-200 bg-white px-3 text-sm text-neutral-900 outline-none disabled:opacity-60 dark:border-neutral-800 dark:bg-neutral-950 dark:text-neutral-50']">
                <option v-for="type in MEMORY_TYPES" :key="type" :value="type">
                  {{ typeLabel(type) }}
                </option>
              </select>
            </label>

            <label :class="['flex flex-col gap-1 text-xs text-neutral-500 dark:text-neutral-400']">
              状态
              <select v-model="draft.status" :disabled="!selectedMemoryOwnedByViewer" :class="['h-10 rounded-lg border border-neutral-200 bg-white px-3 text-sm text-neutral-900 outline-none disabled:opacity-60 dark:border-neutral-800 dark:bg-neutral-950 dark:text-neutral-50']">
                <option v-for="status in STATUS_FILTERS.filter(item => item !== 'all')" :key="status" :value="status">
                  {{ statusLabel(status) }}
                </option>
              </select>
            </label>
          </div>

          <label :class="['flex flex-col gap-1 text-xs text-neutral-500 dark:text-neutral-400']">
            标签
            <input
              v-model="draft.tagsText"
              :readonly="!selectedMemoryOwnedByViewer"
              :class="['h-10 rounded-lg border border-neutral-200 bg-white px-3 text-sm text-neutral-900 outline-none dark:border-neutral-800 dark:bg-neutral-950 dark:text-neutral-50']"
            >
          </label>

          <div :class="['grid grid-cols-1 gap-3 md:grid-cols-2']">
            <label :class="['flex flex-col gap-2 text-xs text-neutral-500 dark:text-neutral-400']">
              置信度 {{ draft.confidence.toFixed(2) }}
              <input v-model.number="draft.confidence" :disabled="!selectedMemoryOwnedByViewer" type="range" min="0" max="1" step="0.01">
            </label>
            <label :class="['flex flex-col gap-2 text-xs text-neutral-500 dark:text-neutral-400']">
              重要性 {{ draft.importance.toFixed(2) }}
              <input v-model.number="draft.importance" :disabled="!selectedMemoryOwnedByViewer" type="range" min="0" max="1" step="0.01">
            </label>
            <label :class="['flex flex-col gap-2 text-xs text-neutral-500 dark:text-neutral-400']">
              情绪强度 {{ draft.emotionalIntensity.toFixed(2) }}
              <input v-model.number="draft.emotionalIntensity" :disabled="!selectedMemoryOwnedByViewer" type="range" min="0" max="1" step="0.01">
            </label>
            <label :class="['flex flex-col gap-2 text-xs text-neutral-500 dark:text-neutral-400']">
              关系相关度 {{ draft.relationshipRelevance.toFixed(2) }}
              <input v-model.number="draft.relationshipRelevance" :disabled="!selectedMemoryOwnedByViewer" type="range" min="0" max="1" step="0.01">
            </label>
          </div>

          <div v-if="selectedMemoryOwnedByViewer" :class="['flex flex-wrap items-center gap-2']">
            <Button
              :icon="savedFlash ? 'i-solar:check-circle-bold-duotone' : 'i-solar:diskette-line-duotone'"
              :label="savedFlash ? '已保存' : '保存修改'"
              @click="saveSelectedMemory"
            />
            <Button variant="secondary" icon="i-solar:restart-line-duotone" label="重置草稿" @click="loadDraft(selectedMemory)" />
          </div>

          <div v-if="recallPreview.length" :class="['rounded-lg bg-neutral-50 p-3 dark:bg-neutral-950/50']">
            <div :class="['mb-2 text-sm text-neutral-800 font-medium dark:text-neutral-100']">
              Alaya 召回预览
            </div>
            <div :class="['flex flex-col gap-2']">
              <div
                v-for="item in recallPreview"
                :key="item.memory.id"
                :class="['rounded-md bg-white/80 p-2 text-xs dark:bg-neutral-900/70']"
              >
                <div :class="['mb-1 flex items-center justify-between gap-2 text-neutral-500 dark:text-neutral-400']">
                  <span>{{ typeLabel(item.memory.type) }}</span>
                  <span>{{ item.finalScore.toFixed(3) }}</span>
                </div>
                <div :class="['line-clamp-2 text-neutral-700 dark:text-neutral-200']">
                  {{ item.memory.content }}
                </div>
                <div :class="['mt-1 flex flex-wrap gap-1 text-[11px] text-neutral-500 dark:text-neutral-400']">
                  <span>语义 {{ item.scoreBreakdown.semanticScore.toFixed(2) }}</span>
                  <span>关键词 {{ item.scoreBreakdown.keywordScore.toFixed(2) }}</span>
                  <span>词面 {{ item.scoreBreakdown.lexicalScore.toFixed(2) }}</span>
                  <span>向量 {{ item.scoreBreakdown.vectorScore.toFixed(2) }}</span>
                </div>
              </div>
            </div>
          </div>

          <div v-if="inspectableDuplicateGroups.length" :class="['rounded-lg bg-neutral-50 p-3 dark:bg-neutral-950/50']">
            <div :class="['mb-2 flex items-center justify-between gap-2']">
              <div :class="['text-sm text-neutral-800 font-medium dark:text-neutral-100']">
                可能重复
              </div>
              <div :class="['text-xs text-neutral-500 dark:text-neutral-400']">
                {{ inspectableDuplicateGroups.length }} 组
              </div>
            </div>
            <div :class="['max-h-64 overflow-auto pr-1']">
              <div
                v-for="group in inspectableDuplicateGroups.slice(0, 8)"
                :key="group.id"
                :class="['mb-2 rounded-md bg-white/80 p-2 text-xs last:mb-0 dark:bg-neutral-900/70']"
              >
                <div :class="['mb-2 flex items-center justify-between gap-2']">
                  <span :class="['text-neutral-500 dark:text-neutral-400']">
                    {{ group.memories.length }} 条记忆 · 相似度 {{ group.score.toFixed(2) }}
                  </span>
                  <Button
                    variant="secondary"
                    size="sm"
                    icon="i-solar:minimalistic-magnifer-bug-line-duotone"
                    label="合并"
                    @click="mergeDuplicateGroup(group.memories.map(memory => memory.id))"
                  />
                </div>
                <div :class="['mb-2 line-clamp-2 text-neutral-800 dark:text-neutral-100']">
                  {{ group.primaryMemory.content }}
                </div>
                <div v-if="group.sharedTokens.length" :class="['flex flex-wrap gap-1']">
                  <span
                    v-for="token in group.sharedTokens.slice(0, 8)"
                    :key="token"
                    :class="['rounded bg-neutral-100 px-1.5 py-0.5 text-[11px] text-neutral-500 dark:bg-neutral-950 dark:text-neutral-400']"
                  >
                    {{ token }}
                  </span>
                </div>
              </div>
            </div>
          </div>

          <div v-if="recentMemoryEvents.length" :class="['rounded-lg bg-neutral-50 p-3 dark:bg-neutral-950/50']">
            <div :class="['mb-2 text-sm text-neutral-800 font-medium dark:text-neutral-100']">
              记忆审计记录
            </div>
            <div :class="['max-h-56 overflow-auto pr-1']">
              <div
                v-for="event in recentMemoryEvents.slice(0, 20)"
                :key="event.id"
                :class="['border-b border-neutral-200/70 py-2 text-xs last:border-b-0 dark:border-neutral-800/70']"
              >
                <div :class="['mb-1 flex flex-wrap items-center justify-between gap-2']">
                  <span :class="['font-medium', eventTone(event.kind)]">{{ eventKindLabel(event.kind) }}</span>
                  <span :class="['text-neutral-400']">{{ formatDate(event.createdAt) }}</span>
                </div>
                <div :class="['text-neutral-600 dark:text-neutral-300']">
                  <span v-if="event.memoryId">{{ event.memoryId }}</span>
                  <span v-if="event.relatedMemoryIds?.length"> 关联 {{ event.relatedMemoryIds.length }}</span>
                  <span v-if="event.route"> 路由 {{ event.route }}</span>
                  <span v-if="event.resultCount !== undefined"> {{ event.resultCount }} 条结果</span>
                  <span v-if="event.beforeStatus || event.afterStatus"> {{ event.beforeStatus ? statusLabel(event.beforeStatus) : '无' }} -> {{ event.afterStatus ? statusLabel(event.afterStatus) : '无' }}</span>
                </div>
                <div v-if="event.preview" :class="['mt-1 line-clamp-2 text-neutral-500 dark:text-neutral-400']">
                  {{ event.preview }}
                </div>
              </div>
            </div>
          </div>
        </div>

        <div v-else :class="['rounded-lg border border-dashed border-neutral-300 p-8 text-center text-sm text-neutral-500 dark:border-neutral-800 dark:text-neutral-400']">
          选择一条记忆进行编辑。
        </div>
      </section>
    </div>
  </div>
</template>

<route lang="yaml">
meta:
  layout: settings
  titleKey: settings.pages.modules.memory-long-term.title
  subtitleKey: settings.title
  stageTransition:
    name: slide
</route>
