<script setup lang="ts">
import type { ServerForm } from '../mcp-config'

import { Button, Checkbox, FieldInput, FieldKeyValues, FieldSelect } from '@proj-airi/ui'
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'

import ComputerUsePolicyFields from './ComputerUsePolicyFields.vue'
import LumiBrowserBackendFields from './LumiBrowserBackendFields.vue'

defineEmits<{ remove: [] }>()

const model = defineModel<ServerForm>({ required: true })

const { t } = useI18n()
const tn = (k: string) => t(`settings.pages.modules.mcp-server.${k}`)

const startupModeOptions = [
  { label: tn('fields.startup-mode.options.on-startup'), value: 'on_startup' },
  { label: tn('fields.startup-mode.options.on-first-use'), value: 'on_first_use' },
  { label: tn('fields.startup-mode.options.manual'), value: 'manual' },
]

const isComputerUseServer = computed(() => model.value.identifier.trim() === 'computer_use')
const isLumiBrowserServer = computed(() => model.value.argsText.includes('@proj-airi/playwright-extra-mcp'))
const interruptShortcut = computed({
  get: () => model.value.envEntries.find(entry => entry.key === 'COMPUTER_USE_INTERRUPT_SHORTCUT')?.value ?? 'End',
  set: (value: string) => {
    const existing = model.value.envEntries.find(entry => entry.key === 'COMPUTER_USE_INTERRUPT_SHORTCUT')
    if (existing)
      existing.value = value.trim() || 'End'
    else
      model.value.envEntries.push({ key: 'COMPUTER_USE_INTERRUPT_SHORTCUT', value: value.trim() || 'End' })
  },
})
</script>

<template>
  <div flex="~ col gap-4">
    <FieldInput
      v-model="model.identifier"
      :label="tn('fields.identifier.label')"
      :description="tn('fields.identifier.description')"
      :placeholder="tn('fields.identifier.placeholder')"
      required
    />
    <FieldInput
      v-model="model.command"
      :label="tn('fields.command.label')"
      :description="tn('fields.command.description')"
      :placeholder="tn('fields.command.placeholder')"
      :required="!model.url"
    />
    <FieldInput
      v-model="model.url"
      :label="tn('fields.url.label')"
      :description="tn('fields.url.description')"
      :placeholder="tn('fields.url.placeholder')"
      input-class="font-mono"
      :required="!model.command"
    />
    <FieldInput
      v-model="model.argsText"
      :single-line="false"
      :label="tn('fields.args.label')"
      :description="tn('fields.args.description')"
      :placeholder="tn('fields.args.placeholder')"
      input-class="font-mono"
    />
    <FieldInput
      v-model="model.cwd"
      :label="tn('fields.cwd.label')"
      :description="tn('fields.cwd.description')"
      :placeholder="tn('fields.cwd.placeholder')"
      input-class="font-mono"
      :required="false"
    />
    <FieldInput
      v-if="isComputerUseServer"
      v-model="interruptShortcut"
      :label="tn('fields.computer-use-interrupt-shortcut.label')"
      :description="tn('fields.computer-use-interrupt-shortcut.description')"
      placeholder="End"
      input-class="font-mono"
      :required="false"
    />
    <ComputerUsePolicyFields
      v-if="isComputerUseServer"
      v-model="model"
    />
    <LumiBrowserBackendFields
      v-if="isLumiBrowserServer"
      v-model="model"
    />
    <FieldSelect
      v-model="model.startupMode"
      :label="tn('fields.startup-mode.label')"
      :description="tn('fields.startup-mode.description')"
      :options="startupModeOptions"
    />
    <div class="grid grid-cols-1 gap-3 md:grid-cols-2">
      <label class="flex items-start gap-3 border border-neutral-200/70 rounded-lg p-3 text-sm dark:border-neutral-800">
        <Checkbox v-model="model.longRunning" class="mt-0.5 shrink-0" />
        <span class="flex flex-col gap-1">
          <span class="font-medium">{{ tn('fields.long-running.label') }}</span>
          <span class="text-xs text-neutral-500 dark:text-neutral-400">{{ tn('fields.long-running.description') }}</span>
        </span>
      </label>
      <label class="flex items-start gap-3 border border-neutral-200/70 rounded-lg p-3 text-sm dark:border-neutral-800">
        <Checkbox v-model="model.persistent" class="mt-0.5 shrink-0" />
        <span class="flex flex-col gap-1">
          <span class="font-medium">{{ tn('fields.persistent.label') }}</span>
          <span class="text-xs text-neutral-500 dark:text-neutral-400">{{ tn('fields.persistent.description') }}</span>
        </span>
      </label>
    </div>
    <div class="grid grid-cols-1 gap-3 md:grid-cols-2">
      <FieldInput
        v-model="model.requestTimeoutMs"
        :label="tn('fields.request-timeout.label')"
        :description="tn('fields.request-timeout.description')"
        :placeholder="tn('fields.request-timeout.placeholder')"
        input-class="font-mono"
        :required="false"
      />
      <FieldInput
        v-model="model.maxTotalTimeoutMs"
        :label="tn('fields.max-total-timeout.label')"
        :description="tn('fields.max-total-timeout.description')"
        :placeholder="tn('fields.max-total-timeout.placeholder')"
        input-class="font-mono"
        :required="false"
      />
    </div>
    <div flex="~ col gap-2">
      <FieldKeyValues
        v-model="model.envEntries"
        :label="tn('fields.env.label')"
        :description="tn('fields.env.description')"
        :key-placeholder="tn('fields.env.key-placeholder')"
        :value-placeholder="tn('fields.env.value-placeholder')"
        :required="false"
        @remove="(i) => model.envEntries.splice(i, 1)"
      />
      <div class="flex justify-end">
        <Button
          variant="ghost" size="sm"
          icon="i-solar:add-circle-bold-duotone" :label="tn('actions.add-env')"
          @click="model.envEntries.push({ key: '', value: '' })"
        />
      </div>
    </div>
    <div class="flex flex-col gap-2">
      <FieldKeyValues
        v-model="model.headersEntries"
        :label="tn('fields.headers.label')"
        :description="tn('fields.headers.description')"
        :key-placeholder="tn('fields.headers.key-placeholder')"
        :value-placeholder="tn('fields.headers.value-placeholder')"
        :required="false"
        @remove="(i) => model.headersEntries.splice(i, 1)"
      />
      <div class="flex justify-end">
        <Button
          variant="ghost" size="sm"
          icon="i-solar:add-circle-bold-duotone" :label="tn('actions.add-header')"
          @click="model.headersEntries.push({ key: '', value: '' })"
        />
      </div>
    </div>

    <div class="flex justify-end border-t border-neutral-200/70 pt-2 dark:border-neutral-800">
      <Button
        variant="danger" size="sm"
        icon="i-solar:trash-bin-2-bold-duotone" :label="tn('actions.remove')"
        @click="$emit('remove')"
      />
    </div>
  </div>
</template>
