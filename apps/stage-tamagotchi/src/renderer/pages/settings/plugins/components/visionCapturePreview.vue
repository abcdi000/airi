<script setup lang="ts">
import { useDownload } from '@proj-airi/stage-ui/composables/download'
import { Button } from '@proj-airi/ui'
import { computed, reactive } from 'vue'

const props = defineProps<{
  capturedAt: number | null
  sourceId: string
  sourceName: string
  capturedImageDataUrl: string
  visionInputImageDataUrl: string
}>()

const emit = defineEmits<{
  clear: []
}>()

const dimensions = reactive({
  captured: '',
  visionInput: '',
})

const capturedAtLabel = computed(() => props.capturedAt
  ? new Date(props.capturedAt).toLocaleString()
  : '尚未捕获')

function dataUrlSizeLabel(dataUrl: string) {
  if (!dataUrl)
    return '0 B'

  const payload = dataUrl.slice(dataUrl.indexOf(',') + 1)
  const padding = payload.endsWith('==') ? 2 : payload.endsWith('=') ? 1 : 0
  const bytes = Math.max(0, Math.floor(payload.length * 3 / 4) - padding)
  if (bytes < 1024)
    return `${bytes} B`
  if (bytes < 1024 * 1024)
    return `${(bytes / 1024).toFixed(1)} KiB`
  return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`
}

function recordDimensions(stage: keyof typeof dimensions, event: Event) {
  const image = event.currentTarget
  if (!(image instanceof HTMLImageElement))
    return
  dimensions[stage] = `${image.naturalWidth} x ${image.naturalHeight}`
}

async function downloadImage(dataUrl: string, stage: 'captured' | 'vision-input') {
  const response = await fetch(dataUrl)
  const blob = await response.blob()
  const timestamp = new Date(props.capturedAt || Date.now()).toISOString().replace(/[:.]/g, '-')
  useDownload(blob, `lumi-${stage}-${timestamp}.${blob.type === 'image/png' ? 'png' : 'jpg'}`).download()
}
</script>

<template>
  <div :class="['grid', 'gap-3']">
    <div :class="['flex', 'flex-wrap', 'items-center', 'justify-between', 'gap-3']">
      <div :class="['min-w-0']">
        <div :class="['font-semibold']">
          最近一次视觉输入
        </div>
        <div :class="['truncate', 'text-xs', 'opacity-65']" :title="sourceId">
          {{ capturedAtLabel }} · {{ sourceName || sourceId || '未知来源' }}
        </div>
      </div>
      <Button
        label="清除"
        icon="i-solar:trash-bin-trash-line-duotone"
        size="sm"
        variant="secondary"
        @click="emit('clear')"
      />
    </div>

    <div :class="['grid', 'gap-3', 'xl:grid-cols-2']">
      <div :class="['overflow-hidden', 'rounded-lg', 'border', 'border-neutral-200/70', 'dark:border-neutral-800']">
        <div :class="['flex', 'items-center', 'justify-between', 'gap-3', 'px-3', 'py-2']">
          <div>
            <div :class="['text-sm', 'font-semibold']">
              原始捕获图
            </div>
            <div :class="['text-xs', 'opacity-60']">
              {{ dimensions.captured || '读取尺寸中' }} · {{ dataUrlSizeLabel(capturedImageDataUrl) }}
            </div>
          </div>
          <Button
            icon="i-solar:download-minimalistic-line-duotone"
            title="下载原始捕获图"
            size="sm"
            variant="secondary"
            @click="downloadImage(capturedImageDataUrl, 'captured')"
          />
        </div>
        <a :href="capturedImageDataUrl" target="_blank" title="在新窗口查看原始捕获图">
          <img
            :src="capturedImageDataUrl"
            alt="Lumi 原始屏幕捕获"
            :class="['block', 'max-h-520px', 'min-h-180px', 'w-full', 'bg-black', 'object-contain']"
            @load="recordDimensions('captured', $event)"
          >
        </a>
      </div>

      <div :class="['overflow-hidden', 'rounded-lg', 'border', 'border-neutral-200/70', 'dark:border-neutral-800']">
        <div :class="['flex', 'items-center', 'justify-between', 'gap-3', 'px-3', 'py-2']">
          <div>
            <div :class="['text-sm', 'font-semibold']">
              实际送模图
            </div>
            <div :class="['text-xs', 'opacity-60']">
              {{ dimensions.visionInput || '读取尺寸中' }} · {{ dataUrlSizeLabel(visionInputImageDataUrl) }}
            </div>
          </div>
          <Button
            icon="i-solar:download-minimalistic-line-duotone"
            title="下载实际送模图"
            size="sm"
            variant="secondary"
            @click="downloadImage(visionInputImageDataUrl, 'vision-input')"
          />
        </div>
        <a :href="visionInputImageDataUrl" target="_blank" title="在新窗口查看实际送模图">
          <img
            :src="visionInputImageDataUrl"
            alt="Lumi 实际发送给视觉模型的图片"
            :class="['block', 'max-h-520px', 'min-h-180px', 'w-full', 'bg-black', 'object-contain']"
            @load="recordDimensions('visionInput', $event)"
          >
        </a>
      </div>
    </div>

    <div :class="['text-xs', 'opacity-60']">
      左图用于判断截图是否正确，右图才是视觉模型真正收到的内容。图片仅保留在本次运行内存中。
    </div>
  </div>
</template>
