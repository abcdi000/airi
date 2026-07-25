<script setup lang="ts">
import type {
  ElectronLumiAstrBotGatewayState,
  ElectronLumiStickerLibraryConfig,
} from '../../../../../../shared/eventa'

import { Checkbox, FieldInput } from '@proj-airi/ui'

const props = defineProps<{
  disabled?: boolean
  state?: ElectronLumiAstrBotGatewayState['stickerLibrary']
}>()

const model = defineModel<ElectronLumiStickerLibraryConfig>({ required: true })

function updateNumber(
  key: 'maximumItems' | 'cooldownMessages',
  value: string,
) {
  const number = Number(value)
  if (Number.isFinite(number))
    model.value = { ...model.value, [key]: number }
}
</script>

<template>
  <section
    v-motion
    :class="['flex flex-col gap-5 border-t border-neutral-200 pt-6 dark:border-neutral-800']"
    :initial="{ opacity: 0, y: 10 }"
    :enter="{ opacity: 1, y: 0 }"
    :duration="260"
  >
    <header :class="['flex flex-wrap items-start justify-between gap-4']">
      <div>
        <h2 :class="['text-base font-semibold']">
          Lumi 表情包库
        </h2>
        <p :class="['mt-1 max-w-2xl text-sm text-neutral-500 dark:text-neutral-400']">
          从只读学习群收藏表情，并在私聊语境合适时偶尔发送。选择过程不依赖视觉模型，也不会让 Lumi 在学习群发言。
        </p>
      </div>
      <div :class="['flex items-center gap-3']">
        <span :class="['text-sm text-neutral-500']">启用</span>
        <Checkbox v-model="model.enabled" :disabled="props.disabled" />
      </div>
    </header>

    <div :class="['flex items-center justify-between gap-4 border-y border-neutral-200 py-4 dark:border-neutral-800']">
      <div>
        <div :class="['text-sm font-medium']">
          收藏学习群图片
        </div>
        <div :class="['mt-1 text-xs text-neutral-500']">
          按图片哈希去重，重复出现会增加观察次数和语境标签。
        </div>
      </div>
      <Checkbox
        v-model="model.collectFromStudyGroups"
        :disabled="props.disabled || !model.enabled"
      />
    </div>

    <FieldInput
      :model-value="model.relativePath"
      label="表情包库相对路径"
      placeholder="data/lumi-stickers"
      :disabled="props.disabled || !model.enabled"
      @update:model-value="model = { ...model, relativePath: $event ?? '' }"
    />
    <p :class="['-mt-3 text-xs text-neutral-500']">
      开发版相对于项目目录；安装版相对于 Lumi 用户数据目录。禁止绝对路径和跳出目录。
    </p>

    <div :class="['grid gap-4 md:grid-cols-2']">
      <FieldInput
        :model-value="String(model.maximumItems)"
        label="最多保留"
        inputmode="numeric"
        :disabled="props.disabled || !model.enabled"
        @update:model-value="updateNumber('maximumItems', $event ?? '')"
      />
      <FieldInput
        :model-value="String(model.cooldownMessages)"
        label="最少间隔消息数"
        inputmode="numeric"
        :disabled="props.disabled || !model.enabled"
        @update:model-value="updateNumber('cooldownMessages', $event ?? '')"
      />
    </div>

    <label :class="['flex flex-col gap-3']">
      <span :class="['flex items-center justify-between text-sm font-medium']">
        <span>私聊发送概率</span>
        <span :class="['tabular-nums text-neutral-500']">
          {{ Math.round(model.sendProbability * 100) }}%
        </span>
      </span>
      <input
        :value="model.sendProbability"
        type="range"
        min="0"
        max="1"
        step="0.01"
        :disabled="props.disabled || !model.enabled"
        :class="['h-2 w-full cursor-pointer accent-sky-500 disabled:cursor-not-allowed disabled:opacity-50']"
        @input="model = { ...model, sendProbability: Number(($event.target as HTMLInputElement).value) }"
      >
    </label>

    <div
      v-if="props.state"
      :class="['grid grid-cols-2 gap-x-5 gap-y-4 border-y border-neutral-200 py-5 md:grid-cols-5 dark:border-neutral-800']"
    >
      <div
        v-for="[label, value] in [
          ['库存', props.state.stats.owned],
          ['累计收到', props.state.stats.received],
          ['已发送', props.state.stats.sent],
          ['已淘汰', props.state.stats.discarded],
          ['全部记录', props.state.stats.total],
        ]"
        :key="label"
      >
        <div :class="['text-xs text-neutral-500']">
          {{ label }}
        </div>
        <div :class="['mt-1 text-xl font-semibold tabular-nums']">
          {{ value }}
        </div>
      </div>
    </div>
    <p v-if="props.state" :class="['break-all text-xs text-neutral-500']">
      当前目录：{{ props.state.rootPath }}
    </p>
  </section>
</template>
