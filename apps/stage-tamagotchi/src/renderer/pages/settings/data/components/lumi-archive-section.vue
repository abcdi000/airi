<script setup lang="ts">
import type { DataSettingsStatusEmits } from '@proj-airi/stage-pages/pages/settings/data/status'

import { createDataSettingsStatusHelpers } from '@proj-airi/stage-pages/pages/settings/data/status'
import { useDataMaintenance } from '@proj-airi/stage-ui/composables/use-data-maintenance'
import { Button } from '@proj-airi/ui'
import { shallowRef, useTemplateRef } from 'vue'

const emit = defineEmits<DataSettingsStatusEmits>()
const importFileInput = useTemplateRef<HTMLInputElement>('importFileInput')
const importing = shallowRef(false)
const exporting = shallowRef(false)
const importError = shallowRef('')
const { exportLumiDataArchive, importLumiDataArchive } = useDataMaintenance()
const { emitStatus, handleActionError } = createDataSettingsStatusHelpers(emit)

function triggerImportPicker() {
  importFileInput.value?.click()
}

async function triggerExport() {
  exporting.value = true
  try {
    const blob = await exportLumiDataArchive()
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `lumi-data-archive-${new Date().toISOString()}.json`
    anchor.click()
    URL.revokeObjectURL(url)
    emitStatus('Lumi 完整数据归档已导出。')
  }
  catch (error) {
    handleActionError(error)
  }
  finally {
    exporting.value = false
  }
}

async function handleImport(event: Event) {
  const target = event.target as HTMLInputElement
  const file = target.files?.[0]
  if (!file)
    return

  importing.value = true
  try {
    const raw = await file.text()
    const parsed = JSON.parse(raw) as Record<string, unknown>
    await importLumiDataArchive(parsed)
    importError.value = ''
    emitStatus('Lumi 完整数据归档已导入。部分桌面运行设置可能需要重启窗口后完全刷新。')
  }
  catch (error) {
    importError.value = '导入失败，请确认文件是 Lumi 数据归档 JSON。'
    handleActionError(error)
  }
  finally {
    importing.value = false
    target.value = ''
  }
}
</script>

<template>
  <div :class="['border-2 border-emerald-200/70 rounded-xl bg-emerald-50/80 p-4 shadow-sm', 'dark:border-emerald-500/15 dark:bg-emerald-500/10']">
    <div :class="['grid grid-cols-1 items-start gap-3 md:grid-cols-[minmax(0,1fr)_auto]']">
      <div :class="['flex min-w-0 flex-col gap-2 md:max-w-[680px]']">
        <div :class="['flex flex-wrap items-center gap-2']">
          <div :class="['i-solar:archive-down-bold-duotone size-5 text-emerald-700 dark:text-emerald-300']" />
          <div :class="['text-lg text-emerald-950 font-medium dark:text-emerald-50']">
            Lumi 完整数据归档
          </div>
          <div :class="['rounded-md bg-white/70 px-2 py-0.5 text-xs text-emerald-800 dark:bg-neutral-950/30 dark:text-emerald-100']">
            v1
          </div>
        </div>
        <p :class="['text-sm text-neutral-700 dark:text-neutral-300']">
          包含聊天、长期记忆、短期状态、用户画像/印象、情绪状态、私人笔记、自主生活计划、Todo、日记调度设置、工具网格日志，以及自定义背景/日记图。
        </p>
        <p :class="['text-xs text-neutral-500 dark:text-neutral-400']">
          Markdown 日记正文保存在本机日记目录中，此归档会保存应用内调度与路径相关状态，但不会复制外部目录里的文件。
        </p>
      </div>

      <div :class="['flex flex-wrap gap-2 md:justify-end']">
        <Button
          variant="secondary"
          icon="i-solar:download-minimalistic-line-duotone"
          label="导出完整归档"
          :loading="exporting"
          @click="triggerExport"
        />
        <Button
          variant="primary"
          icon="i-solar:upload-minimalistic-line-duotone"
          label="导入完整归档"
          :loading="importing"
          @click="triggerImportPicker"
        />
      </div>
    </div>

    <input ref="importFileInput" type="file" accept="application/json" :class="['hidden']" @change="handleImport">
    <p v-if="importError" :class="['mt-3 text-sm text-red-500']">
      {{ importError }}
    </p>
  </div>
</template>
