<script setup lang="ts">
import type { LumiMemoryPromotionCandidate } from '@proj-airi/stage-ui/stores/lumi-memory'

import { Button, DoubleCheckButton } from '@proj-airi/ui'

const props = defineProps<{
  candidates: LumiMemoryPromotionCandidate[]
}>()

const emit = defineEmits<{
  promote: [memoryId: string]
  promoteAll: [memoryIds: string[]]
}>()

function scopeLabel(scope: LumiMemoryPromotionCandidate['toScope']) {
  return scope === 'global' ? 'Lumi 全局' : '可分享'
}
</script>

<template>
  <section :class="['rounded-lg border border-amber-200 bg-amber-50/70 p-3 dark:border-amber-900/60 dark:bg-amber-950/20']">
    <div :class="['mb-3 flex flex-wrap items-center justify-between gap-2']">
      <div :class="['flex items-center gap-2']">
        <div :class="['i-solar:shield-check-line-duotone size-5 text-amber-700 dark:text-amber-300']" />
        <h2 :class="['text-sm text-amber-950 font-semibold dark:text-amber-100']">
          历史记忆晋升
        </h2>
        <span :class="['rounded bg-amber-500/15 px-2 py-0.5 text-xs text-amber-800 tabular-nums dark:text-amber-200']">
          {{ props.candidates.length }}
        </span>
      </div>
      <DoubleCheckButton
        size="sm"
        variant="secondary"
        @confirm="emit('promoteAll', props.candidates.map(candidate => candidate.memory.id))"
      >
        全部确认
        <template #confirm>
          确认全部晋升
        </template>
        <template #cancel>
          取消
        </template>
      </DoubleCheckButton>
    </div>

    <div :class="['max-h-72 overflow-auto border-t border-amber-200/70 dark:border-amber-900/50']">
      <div
        v-for="candidate in props.candidates"
        :key="candidate.memory.id"
        :class="['grid gap-2 border-b border-amber-200/70 py-3 last:border-b-0 md:grid-cols-[minmax(0,1fr)_auto] dark:border-amber-900/50']"
      >
        <div :class="['min-w-0']">
          <div :class="['mb-1 flex flex-wrap items-center gap-2']">
            <span :class="['rounded bg-white/70 px-1.5 py-0.5 text-xs text-amber-800 dark:bg-black/20 dark:text-amber-200']">
              {{ scopeLabel(candidate.toScope) }}
            </span>
            <span :class="['truncate text-xs text-amber-800/70 dark:text-amber-200/70']">
              {{ candidate.memory.type }}
            </span>
          </div>
          <div :class="['line-clamp-2 text-sm text-neutral-800 dark:text-neutral-100']">
            {{ candidate.memory.content }}
          </div>
          <div :class="['mt-1 line-clamp-2 text-xs text-neutral-500 dark:text-neutral-400']">
            {{ candidate.classificationReason }}
          </div>
        </div>
        <Button
          size="sm"
          variant="secondary"
          icon="i-solar:upload-minimalistic-line-duotone"
          :label="candidate.toScope === 'global' ? '晋升为全局' : '晋升为共享'"
          @click="emit('promote', candidate.memory.id)"
        />
      </div>
    </div>
  </section>
</template>
