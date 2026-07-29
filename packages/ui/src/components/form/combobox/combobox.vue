<script setup lang="ts" generic="T extends AcceptableValue">
import type { AcceptableValue } from 'reka-ui'

import {
  ComboboxAnchor,
  ComboboxContent,
  ComboboxGroup,
  ComboboxInput,
  ComboboxItem,
  ComboboxItemIndicator,
  ComboboxLabel,
  ComboboxPortal,
  ComboboxRoot,
  ComboboxSeparator,
  ComboboxTrigger,
  ComboboxViewport,
} from 'reka-ui'
import { computed, nextTick, shallowRef, useTemplateRef, watch } from 'vue'

interface ComboboxOptionItem<T extends AcceptableValue> {
  label: string
  value: T
  description?: string
  disabled?: boolean
  icon?: string
}

interface ComboboxOptionGroupItem<T extends AcceptableValue> {
  groupLabel?: string
  children?: ComboboxOptionItem<T>[]
}

const props = withDefaults(defineProps<{
  options: ComboboxOptionItem<T>[] | ComboboxOptionGroupItem<T>[]
  placeholder?: string
  disabled?: boolean
  openOnClick?: boolean
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

const modelValue = defineModel<T>({ required: false })
const open = shallowRef(false)
const searchTerm = shallowRef('')
const renderedOptionCount = shallowRef(props.initialOptionCount)
const optionViewport = useTemplateRef<HTMLDivElement>('optionViewport')

const normalizedOptions = computed<ComboboxOptionGroupItem<T>[]>(() => {
  if (!props.options.length) {
    return []
  }

  const [firstOption] = props.options
  if ('value' in firstOption) {
    return [
      {
        groupLabel: '',
        children: props.options as ComboboxOptionItem<T>[],
      },
    ]
  }

  return props.options as ComboboxOptionGroupItem<T>[]
})

const flattenedOptions = computed<ComboboxOptionItem<T>[]>(() =>
  normalizedOptions.value.flatMap(group => group.children ?? []),
)

const filteredOptions = computed<ComboboxOptionGroupItem<T>[]>(() => {
  const query = searchTerm.value.trim().toLocaleLowerCase()
  if (!query)
    return normalizedOptions.value

  return normalizedOptions.value
    .map(group => ({
      ...group,
      children: (group.children ?? []).filter((option) => {
        return option.label.toLocaleLowerCase().includes(query)
          || option.description?.toLocaleLowerCase().includes(query)
      }),
    }))
    .filter(group => Boolean(group.children?.length))
})

const filteredOptionCount = computed(() =>
  filteredOptions.value.reduce((count, group) => count + (group.children?.length ?? 0), 0),
)

const renderedOptions = computed<ComboboxOptionGroupItem<T>[]>(() => {
  if (!props.incrementalRender)
    return filteredOptions.value

  let remaining = renderedOptionCount.value
  const groups: ComboboxOptionGroupItem<T>[] = []
  for (const group of filteredOptions.value) {
    if (remaining <= 0)
      break

    const children = (group.children ?? []).slice(0, remaining)
    if (children.length) {
      groups.push({
        ...group,
        children,
      })
      remaining -= children.length
    }
  }
  return groups
})

const renderedFlatOptions = computed(() =>
  renderedOptions.value.flatMap(group => group.children ?? []),
)
const hasMoreOptions = computed(() =>
  props.incrementalRender && renderedFlatOptions.value.length < filteredOptionCount.value,
)

function loadMoreOptions(event: Event) {
  const target = event.currentTarget as HTMLElement
  const reachedEnd = target.scrollTop + target.clientHeight >= target.scrollHeight - 64
  if (reachedEnd && hasMoreOptions.value)
    renderedOptionCount.value += props.optionBatchSize
}

watch(searchTerm, () => {
  renderedOptionCount.value = props.initialOptionCount
  optionViewport.value?.scrollTo({ top: 0 })
})

watch(open, async (isOpen) => {
  if (!isOpen) {
    searchTerm.value = ''
    return
  }

  renderedOptionCount.value = props.initialOptionCount
  await nextTick()
  optionViewport.value?.scrollTo({ top: 0 })
})

function toDisplayValue(value: T): string {
  const option = flattenedOptions.value.find(option => option.value === value)
  return option?.label ?? props.placeholder ?? ''
}

function toCssSize(value?: string | number): string | undefined {
  if (value == null) {
    return undefined
  }

  return typeof value === 'number' ? `${value}px` : value
}

function handleSearchInput(event: Event) {
  searchTerm.value = (event.target as HTMLInputElement).value
}

function handleHighlight(payload?: { value: T }) {
  if (!payload || !hasMoreOptions.value)
    return

  const lastOption = renderedFlatOptions.value.at(-1)
  if (lastOption?.value === payload.value)
    renderedOptionCount.value += props.optionBatchSize
}
</script>

<template>
  <ComboboxRoot
    v-model="modelValue"
    v-model:open="open"
    :disabled="props.disabled"
    :ignore-filter="true"
    :open-on-click="props.openOnClick"
    :class="['relative', 'w-full', 'h-fit']"
    @highlight="handleHighlight"
  >
    <ComboboxAnchor
      :class="[
        'w-full inline-flex items-center justify-between rounded-xl border px-3 leading-none h-9 gap-[5px] outline-none',
        'text-sm text-neutral-700 dark:text-neutral-200 data-[placeholder]:text-neutral-200',
        'bg-white dark:bg-neutral-900 hover:bg-neutral-50 dark:hover:bg-neutral-700',
        'border-neutral-200 dark:border-neutral-800 border-solid border-2 focus:border-primary-300 dark:focus:border-primary-400/50',
        'shadow-sm focus:shadow-[0_0_0_2px] focus:shadow-black',
        'transition-colors duration-200 ease-in-out',
        props.disabled ? 'cursor-not-allowed bg-neutral-100 opacity-60 dark:bg-neutral-900' : 'cursor-pointer',
      ]"
    >
      <ComboboxInput
        :class="[
          '!bg-transparent outline-none h-full selection:bg-grass5 placeholder-stone-400 w-full',
          'text-neutral-700 dark:text-neutral-200',
          'transition-colors duration-200 ease-in-out',
        ]"
        :disabled="props.disabled"
        :placeholder="props.placeholder"
        :display-value="(val) => toDisplayValue(val)"
        @input="handleSearchInput"
      />
      <ComboboxTrigger>
        <div
          i-solar:alt-arrow-down-linear
          :class="[
            'h-4 w-4',
            'text-neutral-700 dark:text-neutral-200',
            'transition-colors duration-200 ease-in-out',
          ]"
        />
      </ComboboxTrigger>
    </ComboboxAnchor>

    <ComboboxPortal>
      <ComboboxContent
        position="popper"
        side="bottom"
        align="start"
        :side-offset="4"
        :avoid-collisions="true"
        :class="[
          // NOTICE: DialogContent/DialogOverlay use z-[9999], and DrawerContent uses z-[1000].
          // ComboboxContent must render above these layers so that dropdowns inside
          // Dialog/Drawer are not hidden behind the overlay or dismissed unexpectedly.
          // Read more at: https://github.com/moeru-ai/airi/issues/1136
          'z-[10010]',
          'w-full overflow-hidden rounded-xl shadow-sm border will-change-[opacity,transform]',
          'data-[side=top]:animate-slideDownAndFade data-[side=right]:animate-slideLeftAndFade data-[side=bottom]:animate-slideUpAndFade data-[side=left]:animate-slideRightAndFade',
          'bg-white dark:bg-neutral-900',
          'border-neutral-200 dark:border-neutral-800 border-solid border-2 focus:border-neutral-300 dark:focus:border-neutral-600',
        ]"
        :style="{
          width: toCssSize(props.contentWidth) ?? 'var(--reka-combobox-trigger-width)',
          minWidth: toCssSize(props.contentMinWidth) ?? '160px',
        }"
      >
        <ComboboxViewport :class="['p-[2px]']">
          <div
            ref="optionViewport"
            :class="[
              'max-h-50dvh',
              'overflow-y-auto',
              'overscroll-contain',
              '[scrollbar-gutter:stable]',
            ]"
            @scroll="loadMoreOptions"
          >
            <div
              v-if="filteredOptionCount === 0"
              :class="[
                'font-medium py-2 px-2',
                'text-xs text-neutral-700 dark:text-neutral-200',
                'transition-colors duration-200 ease-in-out',
              ]"
            >
              <slot name="empty" />
            </div>

            <template
              v-for="(group, groupIndex) in renderedOptions"
              :key="group.groupLabel || `group-${groupIndex}`"
            >
              <ComboboxGroup :class="['overflow-x-hidden']">
                <ComboboxSeparator
                  v-if="groupIndex !== 0"
                  :class="['m-[5px]', 'h-[1px]', 'bg-neutral-400']"
                />

                <ComboboxLabel
                  v-if="group.groupLabel"
                  :class="[
                    'px-[25px] text-xs leading-[25px]',
                    'text-neutral-500 dark:text-neutral-400',
                    'transition-colors duration-200 ease-in-out',
                  ]"
                >
                  {{ group.groupLabel }}
                </ComboboxLabel>

                <ComboboxItem
                  v-for="(option, optionIndex) in group.children || []"
                  :key="`${group.groupLabel || groupIndex}-${option.label}-${optionIndex}`"
                  :text-value="option.label"
                  :value="option.value"
                  :disabled="option.disabled"
                  :class="[
                    'leading-normal rounded-lg grid grid-cols-[1rem_minmax(0,1fr)] items-center gap-2 min-h-8 px-2 relative select-none data-[disabled]:pointer-events-none data-[highlighted]:outline-none',
                    'data-[highlighted]:bg-neutral-100 dark:data-[highlighted]:bg-neutral-800',
                    'text-sm text-neutral-700 dark:text-neutral-200 data-[disabled]:text-neutral-400 dark:data-[disabled]:text-neutral-600 data-[highlighted]:text-grass1',
                    'transition-colors duration-200 ease-in-out',
                    option.disabled ? 'cursor-not-allowed' : 'cursor-pointer',
                  ]"
                >
                  <ComboboxItemIndicator
                    :class="[
                      'col-start-1 row-start-1',
                      'inline-flex items-center justify-center',
                      'w-[1rem]',
                      'opacity-30',
                      'text-current',
                    ]"
                  >
                    <div i-solar:alt-arrow-right-outline class="size-4" />
                  </ComboboxItemIndicator>

                  <div :class="['col-start-2', 'min-w-0', 'flex', 'items-center', 'gap-2', 'py-1']">
                    <slot
                      name="option"
                      v-bind="{ option }"
                    >
                      <span
                        v-if="option.icon"
                        :class="[
                          'size-4 shrink-0',
                          'text-current',
                          option.icon,
                        ]"
                      />

                      <div :class="['min-w-0', 'flex', 'flex-1', 'flex-col']">
                        <span
                          :class="[
                            'line-clamp-1',
                            'overflow-hidden',
                            'text-ellipsis',
                            'whitespace-nowrap',
                          ]"
                        >
                          {{ option.label }}
                        </span>

                        <span
                          v-if="option.description"
                          :class="[
                            'line-clamp-2',
                            'text-xs',
                            'text-neutral-500 dark:text-neutral-400',
                          ]"
                        >
                          {{ option.description }}
                        </span>
                      </div>
                    </slot>
                  </div>
                </ComboboxItem>
              </ComboboxGroup>
            </template>
            <div
              v-if="hasMoreOptions"
              :class="[
                'px-3 py-2',
                'text-center text-xs text-neutral-500 dark:text-neutral-400',
              ]"
            >
              {{ renderedFlatOptions.length }} / {{ filteredOptionCount }}
            </div>
          </div>
        </ComboboxViewport>
      </ComboboxContent>
    </ComboboxPortal>
  </ComboboxRoot>
</template>
