<script setup lang="ts">
import { Button, FieldCheckbox, FieldInput } from '@proj-airi/ui'

import ManagerPage from '../components/ManagerPage.vue'

import { useServerManager } from '../useServerManager'

const manager = useServerManager()
function save() {
  return manager.applyConfig({ vectorEnabled: manager.configDraft.vectorEnabled, vectorModel: manager.configDraft.vectorModel, vectorDevice: manager.configDraft.vectorDevice, vectorPythonPath: manager.configDraft.vectorPythonPath }, '向量服务配置已保存并应用')
}
</script>

<template>
  <ManagerPage title="记忆与向量" description="监控服务器唯一的长期语义记忆索引，并管理 GPU 向量工作进程。" icon="i-solar:database-bold-duotone">
    <template #actions>
      <Button label="保存配置" icon="i-solar:diskette-bold-duotone" :loading="manager.busy.value" @click="save" />
    </template>
    <div :class="['grid grid-cols-[minmax(0,1fr)_280px] gap-8']">
      <div :class="['space-y-5']">
        <FieldCheckbox v-model="manager.configDraft.vectorEnabled" label="启用语义向量索引" /><FieldInput v-model="manager.configDraft.vectorModel" label="嵌入模型" /><label :class="['block text-sm']"><span :class="['mb-1.5 block']">计算设备</span><select v-model="manager.configDraft.vectorDevice" :class="['h-10 w-full rounded-md border border-neutral-200 bg-transparent px-3 dark:border-neutral-800']"><option value="auto">自动选择</option><option value="cuda">NVIDIA CUDA</option><option value="cpu">CPU</option><option value="mps">Apple MPS</option></select></label><FieldInput v-model="manager.configDraft.vectorPythonPath" label="独立 Python 路径（可选）" />
      </div>
      <aside :class="['border-l border-neutral-200 pl-6 dark:border-neutral-800']">
        <div :class="['text-xs text-neutral-500']">
          索引进度
        </div><div :class="['mt-1 text-3xl font-semibold tabular-nums']">
          {{ manager.vectorProgress.value }}%
        </div><div :class="['mt-3 h-2 overflow-hidden rounded bg-neutral-100 dark:bg-neutral-800']">
          <div :class="['h-full bg-emerald-500 transition-all duration-500']" :style="{ width: `${manager.vectorProgress.value}%` }" />
        </div><dl :class="['mt-4 space-y-2 text-sm']">
          <div :class="['flex justify-between']">
            <dt>已索引</dt><dd>{{ manager.vector.value?.indexedCount ?? 0 }}</dd>
          </div><div :class="['flex justify-between']">
            <dt>总数</dt><dd>{{ manager.vector.value?.totalCount ?? 0 }}</dd>
          </div><div :class="['flex justify-between']">
            <dt>缺失</dt><dd>{{ manager.vector.value?.missingCount ?? 0 }}</dd>
          </div>
        </dl><Button :class="['mt-5']" variant="secondary" label="继续补向量" icon="i-solar:refresh-bold" :disabled="!manager.running.value" @click="manager.backfillVectors" />
      </aside>
    </div>
  </ManagerPage>
</template>
