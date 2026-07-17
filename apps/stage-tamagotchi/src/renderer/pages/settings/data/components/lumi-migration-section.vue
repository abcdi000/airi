<script setup lang="ts">
import { getLumiMigrationSummary, hasLumiMigratedRuntimeContext } from '@proj-airi/stage-ui/stores/lumi-migration'
import { useLumiMemoryStore } from '@proj-airi/stage-ui/stores/lumi-memory'
import { Button } from '@proj-airi/ui'
import { storeToRefs } from 'pinia'
import { computed, ref } from 'vue'

const summary = getLumiMigrationSummary()
const hasRuntimeContext = hasLumiMigratedRuntimeContext()
const lumiMemoryStore = useLumiMemoryStore()
lumiMemoryStore.initialize()

const { candidateMemories, statusCounts } = storeToRefs(lumiMemoryStore)
const copied = ref(false)
const showCandidates = ref(false)

const stats = computed(() => [
  { label: 'Chats', value: summary.chatSessionCount },
  { label: 'Total memories', value: summary.memoryCount },
  { label: 'Active memories', value: lumiMemoryStore.activeMemories.length },
  { label: 'Profiles', value: summary.profileCount },
  { label: 'States', value: summary.stateCount },
])

const candidatePreview = computed(() => candidateMemories.value.slice(0, 8))

async function copyChatExportPath() {
  if (!navigator.clipboard)
    return

  await navigator.clipboard.writeText(summary.chatExportPath)
  copied.value = true
  window.setTimeout(() => {
    copied.value = false
  }, 1600)
}

function setCandidateStatus(memoryId: string, status: 'active' | 'rejected' | 'archived') {
  lumiMemoryStore.updateMemoryStatus(memoryId, status)
}
</script>

<template>
  <div :class="['border-2 border-cyan-200/50 rounded-xl bg-cyan-50/80 p-4 shadow-sm', 'dark:border-cyan-500/10 dark:bg-cyan-500/10']">
    <div :class="['grid grid-cols-1 items-start gap-4 xl:grid-cols-[minmax(0,1fr)_auto]']">
      <div :class="['flex min-w-0 flex-col gap-3']">
        <div :class="['flex items-center gap-2']">
          <div :class="['i-solar:stars-line-duotone size-5 text-cyan-600 dark:text-cyan-300']" />
          <div :class="['text-lg text-cyan-900 font-medium dark:text-cyan-100']">
            Lumi migration
          </div>
          <div
            :class="[
              'rounded-md px-2 py-0.5 text-xs font-medium',
              hasRuntimeContext
                ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
                : 'bg-amber-500/10 text-amber-700 dark:text-amber-300',
            ]"
          >
            {{ hasRuntimeContext ? 'runtime context ready' : 'context missing' }}
          </div>
        </div>

        <div :class="['grid grid-cols-2 gap-2 lg:grid-cols-5']">
          <div
            v-for="stat in stats"
            :key="stat.label"
            :class="['rounded-lg bg-white/70 p-3 dark:bg-neutral-950/30']"
          >
            <div :class="['text-xs text-neutral-500 dark:text-neutral-400']">
              {{ stat.label }}
            </div>
            <div :class="['text-xl text-neutral-900 font-semibold tabular-nums dark:text-neutral-50']">
              {{ stat.value }}
            </div>
          </div>
        </div>

        <div :class="['min-w-0 rounded-lg bg-white/70 p-3 dark:bg-neutral-950/30']">
          <div :class="['mb-1 text-xs text-neutral-500 dark:text-neutral-400']">
            Chat import file
          </div>
          <code :class="['block break-all text-xs text-neutral-700 dark:text-neutral-200']">
            {{ summary.chatExportPath }}
          </code>
        </div>

        <div :class="['text-xs text-neutral-600 dark:text-neutral-300']">
          Generated {{ summary.generatedAt }}. Runtime context is injected only when the active card is Lumi.
        </div>

        <div :class="['flex flex-wrap gap-2']">
          <div
            v-for="item in statusCounts"
            :key="item.status"
            :class="['rounded-md bg-white/70 px-2 py-1 text-xs text-neutral-700 dark:bg-neutral-950/30 dark:text-neutral-200']"
          >
            {{ item.status }}: {{ item.count }}
          </div>
        </div>

        <div :class="['rounded-lg bg-white/70 p-3 dark:bg-neutral-950/30']">
          <div :class="['mb-2 flex items-center justify-between gap-2']">
            <div :class="['text-sm text-neutral-800 font-medium dark:text-neutral-100']">
              Candidate memory review
            </div>
            <Button
              variant="ghost"
              size="sm"
              :icon="showCandidates ? 'i-solar:alt-arrow-up-line-duotone' : 'i-solar:alt-arrow-down-line-duotone'"
              :label="showCandidates ? 'Hide' : 'Show'"
              @click="showCandidates = !showCandidates"
            />
          </div>

          <div v-if="showCandidates" :class="['flex flex-col gap-2']">
            <div
              v-for="memory in candidatePreview"
              :key="memory.id"
              :class="['rounded-md border border-neutral-200/70 bg-white/80 p-2 dark:border-neutral-800 dark:bg-neutral-950/40']"
            >
              <div :class="['mb-2 line-clamp-3 text-xs text-neutral-700 dark:text-neutral-200']">
                {{ memory.content }}
              </div>
              <div :class="['flex flex-wrap gap-2']">
                <Button variant="secondary" size="sm" label="Activate" @click="setCandidateStatus(memory.id, 'active')" />
                <Button variant="secondary" size="sm" label="Reject" @click="setCandidateStatus(memory.id, 'rejected')" />
                <Button variant="secondary" size="sm" label="Archive" @click="setCandidateStatus(memory.id, 'archived')" />
              </div>
            </div>
            <div v-if="candidatePreview.length === 0" :class="['text-xs text-neutral-500 dark:text-neutral-400']">
              No candidate memories left to review.
            </div>
          </div>
        </div>
      </div>

      <div :class="['flex flex-col items-start gap-2']">
        <Button
          variant="secondary"
          size="sm"
          :icon="copied ? 'i-solar:check-circle-bold-duotone' : 'i-solar:copy-line-duotone'"
          :label="copied ? 'Copied' : 'Copy path'"
          @click="copyChatExportPath"
        />
        <Button
          variant="secondary"
          size="sm"
          icon="i-solar:restart-line-duotone"
          label="Reset memories"
          @click="lumiMemoryStore.resetToMigratedSnapshot"
        />
      </div>
    </div>
  </div>
</template>
