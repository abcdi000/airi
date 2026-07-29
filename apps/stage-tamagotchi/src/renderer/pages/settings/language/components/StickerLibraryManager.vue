<script setup lang="ts">
import type { ElectronLumiStickerRecord } from '../../../../../shared/eventa'

import { Button, DoubleCheckButton, Input } from '@proj-airi/ui'
import { computed, nextTick, onMounted, reactive, shallowRef, useTemplateRef, watch } from 'vue'

import { useLocalAstrBotGateway } from '../../integrations/astrbot/useLocalAstrBotGateway'

const gateway = useLocalAstrBotGateway()
const query = shallowRef('')
const status = shallowRef<'all' | 'owned' | 'discarded'>('owned')
const visibleRecordCount = shallowRef(24)
const recordBatchSize = 24
const stickerViewport = useTemplateRef<HTMLDivElement>('stickerViewport')
const previews = reactive<Record<string, string>>({})
const tagDrafts = reactive<Record<string, string>>({})
const editingId = shallowRef('')

const records = computed(() => gateway.state.value?.stickerLibrary.records ?? [])
const filteredRecords = computed(() => {
  const normalized = query.value.trim().toLocaleLowerCase()
  return records.value
    .filter(record => status.value === 'all' || record.status === status.value)
    .filter(record => !normalized || record.tags.some(tag => tag.toLocaleLowerCase().includes(normalized)))
    .sort((left, right) => right.lastObservedAt - left.lastObservedAt)
})
const visibleRecords = computed(() => filteredRecords.value.slice(0, visibleRecordCount.value))
const hasMoreRecords = computed(() => visibleRecords.value.length < filteredRecords.value.length)

function loadMoreRecords(event: Event) {
  const target = event.currentTarget as HTMLElement
  const reachedEnd = target.scrollTop + target.clientHeight >= target.scrollHeight - 160
  if (reachedEnd && hasMoreRecords.value)
    visibleRecordCount.value += recordBatchSize
}

watch([query, status], async () => {
  visibleRecordCount.value = recordBatchSize
  await nextTick()
  stickerViewport.value?.scrollTo({ top: 0 })
})

watch(visibleRecords, async (items) => {
  await Promise.all(items.map(loadPreview))
}, { immediate: true })

onMounted(async () => {
  await gateway.load().catch(() => undefined)
})

async function loadPreview(record: ElectronLumiStickerRecord) {
  if (previews[record.id])
    return
  const preview = await gateway.getStickerPreview(record.id).catch(() => null)
  if (preview)
    previews[record.id] = `data:${preview.mimeType};base64,${preview.dataBase64}`
}

function startTagEdit(record: ElectronLumiStickerRecord) {
  editingId.value = record.id
  tagDrafts[record.id] = record.tags.join('，')
}

async function saveTags(record: ElectronLumiStickerRecord) {
  await gateway.updateSticker({
    id: record.id,
    tags: splitTags(tagDrafts[record.id] ?? ''),
  })
  editingId.value = ''
}

function splitTags(value: string) {
  return [...new Set(value.split(/[,，、]/).map(item => item.trim()).filter(Boolean))].slice(0, 12)
}

function formatTime(timestamp: number) {
  return new Date(timestamp).toLocaleString()
}
</script>

<template>
  <section :class="['flex flex-col gap-5']">
    <header :class="['flex flex-wrap items-start justify-between gap-4 border-b border-neutral-200 pb-5 dark:border-neutral-800']">
      <div>
        <h2 :class="['text-lg font-semibold']">
          表情包库
        </h2>
        <p :class="['mt-1 max-w-2xl text-sm text-neutral-500']">
          标签由意识模型归纳，你可以人工纠正。图片预览按当前页加载，不会一次把整个图库塞进内存。
        </p>
      </div>
      <Button variant="secondary" size="sm" icon="i-solar:refresh-bold-duotone" :loading="gateway.busy.value" @click="gateway.load()">
        刷新
      </Button>
    </header>

    <div v-if="gateway.error.value" :class="['border-l-3 border-red-500 bg-red-500/8 px-4 py-3 text-sm text-red-600']">
      {{ gateway.error.value }}
    </div>

    <div v-if="gateway.state.value" :class="['grid grid-cols-2 gap-3 md:grid-cols-5']">
      <div
        v-for="[label, value] in [
          ['可用', gateway.state.value.stickerLibrary.stats.owned],
          ['已淘汰', gateway.state.value.stickerLibrary.stats.discarded],
          ['累计观察', gateway.state.value.stickerLibrary.stats.received],
          ['发送次数', gateway.state.value.stickerLibrary.stats.sent],
          ['全部记录', gateway.state.value.stickerLibrary.stats.total],
        ]" :key="label" :class="['border-b border-neutral-200 pb-3 dark:border-neutral-800']"
      >
        <div :class="['text-xs text-neutral-500']">
          {{ label }}
        </div>
        <div :class="['mt-1 text-xl font-semibold tabular-nums']">
          {{ value }}
        </div>
      </div>
    </div>

    <div :class="['grid gap-3 md:grid-cols-[1fr_180px]']">
      <Input v-model="query" placeholder="按标签搜索" />
      <select v-model="status" :class="['h-9 rounded-lg border border-neutral-200 bg-white px-3 text-sm outline-none dark:border-neutral-800 dark:bg-neutral-900']">
        <option value="owned">
          可用表情
        </option>
        <option value="discarded">
          已淘汰
        </option>
        <option value="all">
          全部
        </option>
      </select>
    </div>

    <div v-if="!gateway.state.value" :class="['py-12 text-center text-sm text-neutral-500']">
      正在读取表情包库
    </div>
    <div v-else-if="!visibleRecords.length" :class="['py-12 text-center text-sm text-neutral-500']">
      当前筛选下没有表情包
    </div>
    <div
      v-else
      ref="stickerViewport"
      :class="[
        'max-h-[70dvh]',
        'overflow-y-auto',
        'overscroll-contain',
        'pr-2',
        '[scrollbar-gutter:stable]',
      ]"
      @scroll="loadMoreRecords"
    >
      <div :class="['grid grid-cols-2 gap-4 md:grid-cols-3']">
        <article
          v-for="record in visibleRecords"
          :key="record.id"
          v-motion
          :initial="{ opacity: 0, scale: 0.98 }"
          :enter="{ opacity: 1, scale: 1 }"
          :class="['overflow-hidden rounded-lg border border-neutral-200 bg-neutral-50/70 dark:border-neutral-800 dark:bg-neutral-900/50']"
        >
          <div :class="['aspect-square bg-neutral-100 dark:bg-neutral-950']">
            <img v-if="previews[record.id]" :src="previews[record.id]" alt="" :class="['size-full object-contain']">
            <div v-else :class="['flex size-full items-center justify-center text-2xl text-neutral-400']">
              <span class="i-solar:gallery-minimalistic-bold-duotone" />
            </div>
          </div>
          <div :class="['flex flex-col gap-3 p-3']">
            <template v-if="editingId === record.id">
              <Input v-model="tagDrafts[record.id]" placeholder="标签，用逗号分隔" />
              <div :class="['flex gap-2']">
                <Button size="sm" @click="saveTags(record)">
                  保存标签
                </Button>
                <Button size="sm" variant="secondary" @click="editingId = ''">
                  取消
                </Button>
              </div>
            </template>
            <template v-else>
              <div :class="['flex min-h-6 flex-wrap gap-1.5']">
                <span v-for="tag in record.tags" :key="tag" :class="['rounded bg-primary-500/10 px-2 py-0.5 text-xs text-primary-600 dark:text-primary-300']">{{ tag }}</span>
                <span v-if="record.tagsManuallyEdited" :class="['rounded bg-emerald-500/10 px-2 py-0.5 text-xs text-emerald-600 dark:text-emerald-300']">人工标签</span>
                <span v-if="!record.tags.length" :class="['text-xs text-amber-600']">尚无标签</span>
              </div>
              <p :class="['text-xs text-neutral-500']">
                观察 {{ record.observedCount }} · 发送 {{ record.sentCount }} · {{ formatTime(record.lastObservedAt) }}
              </p>
              <div :class="['flex flex-wrap gap-2']">
                <Button size="sm" variant="secondary" icon="i-solar:pen-bold-duotone" @click="startTagEdit(record)">
                  编辑
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  :icon="record.status === 'owned' ? 'i-solar:archive-down-bold-duotone' : 'i-solar:restart-bold-duotone'"
                  @click="gateway.updateSticker({ id: record.id, status: record.status === 'owned' ? 'discarded' : 'owned' })"
                >
                  {{ record.status === 'owned' ? '淘汰' : '恢复' }}
                </Button>
                <DoubleCheckButton size="sm" variant="danger" @confirm="gateway.deleteSticker(record.id)">
                  删除
                  <template #confirm>
                    永久删除
                  </template>
                  <template #cancel>
                    取消
                  </template>
                </DoubleCheckButton>
              </div>
            </template>
          </div>
        </article>
      </div>
      <div :class="['py-3 text-center text-xs tabular-nums text-neutral-500']">
        {{ visibleRecords.length }} / {{ filteredRecords.length }}
      </div>
    </div>
    <p v-if="gateway.state.value" :class="['break-all text-xs text-neutral-500']">
      存储目录：{{ gateway.state.value.stickerLibrary.rootPath }}
    </p>
  </section>
</template>
