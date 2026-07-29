<script setup lang="ts">
import { Combobox } from '../combobox'

const props = withDefaults(defineProps<{
  options?: {
    label: string
    value: string | number
    description?: string
    disabled?: boolean
    icon?: string
  }[]
  placeholder?: string
  disabled?: boolean
  openOnClick?: boolean
  title?: string
  layout?: 'horizontal' | 'vertical'
  contentMinWidth?: string | number
  contentWidth?: string | number
  incrementalRender?: boolean
  initialOptionCount?: number
  optionBatchSize?: number
}>(), {
  disabled: false,
  openOnClick: true,
  incrementalRender: true,
  initialOptionCount: 36,
  optionBatchSize: 36,
})

const modelValue = defineModel<string | number>({ required: false })
</script>

<template>
  <Combobox
    v-model="modelValue"
    :options="[{ groupLabel: '', children: props.options }]"
    :disabled="props.disabled"
    :open-on-click="props.openOnClick"
    :content-min-width="props.contentMinWidth"
    :content-width="props.contentWidth"
    :placeholder="props.placeholder"
    :incremental-render="props.incrementalRender"
    :initial-option-count="props.initialOptionCount"
    :option-batch-size="props.optionBatchSize"
  >
    <template
      v-if="$slots.option"
      #option="{ option }"
    >
      <slot
        name="option"
        v-bind="{ option }"
      />
    </template>

    <template
      v-if="$slots.empty"
      #empty
    >
      <slot name="empty" />
    </template>
  </Combobox>
</template>
