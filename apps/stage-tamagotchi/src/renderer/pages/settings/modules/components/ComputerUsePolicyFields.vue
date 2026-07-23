<script setup lang="ts">
import type { ServerForm } from '../mcp-config'

import { FieldInput } from '@proj-airi/ui'
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'

import { DEFAULT_COMPUTER_USE_DENY_APPS } from '../mcp-config'

const model = defineModel<ServerForm>({ required: true })

const { t } = useI18n()
const tn = (key: string) => t(`settings.pages.modules.mcp-server.fields.computer-use-policy.${key}`)

function listEnvironmentValue(key: string, fallback = '') {
  return computed({
    get: () => {
      const value = model.value.envEntries.find(entry => entry.key === key)?.value ?? fallback
      return value.split(',').map(item => item.trim()).filter(Boolean).join('\n')
    },
    set: (value: string) => {
      const serialized = value
        .split(/[\n,]/u)
        .map(item => item.trim())
        .filter(Boolean)
        .join(',')
      const existing = model.value.envEntries.find(entry => entry.key === key)
      if (existing)
        existing.value = serialized
      else
        model.value.envEntries.push({ key, value: serialized })
    },
  })
}

const deniedApps = listEnvironmentValue('COMPUTER_USE_DENY_APPS', DEFAULT_COMPUTER_USE_DENY_APPS)
const deniedWindowTitles = listEnvironmentValue('COMPUTER_USE_DENY_WINDOW_TITLES')
</script>

<template>
  <section :class="['flex flex-col gap-4 border-y border-neutral-200/70 py-4 dark:border-neutral-800']">
    <div :class="['flex items-start gap-3']">
      <span :class="['i-solar:shield-warning-bold-duotone mt-0.5 size-5 shrink-0 text-amber-500']" />
      <div>
        <h3 :class="['text-sm font-semibold']">
          {{ tn('title') }}
        </h3>
        <p :class="['mt-1 text-xs leading-5 text-neutral-500 dark:text-neutral-400']">
          {{ tn('description') }}
        </p>
      </div>
    </div>

    <div :class="['grid grid-cols-1 gap-4 md:grid-cols-2']">
      <FieldInput
        v-model="deniedApps"
        :single-line="false"
        :label="tn('apps.label')"
        :description="tn('apps.description')"
        :placeholder="tn('apps.placeholder')"
        input-class="min-h-32 font-mono"
        :required="false"
      />
      <FieldInput
        v-model="deniedWindowTitles"
        :single-line="false"
        :label="tn('window-titles.label')"
        :description="tn('window-titles.description')"
        :placeholder="tn('window-titles.placeholder')"
        input-class="min-h-32 font-mono"
        :required="false"
      />
    </div>
    <p :class="['text-xs text-neutral-500 dark:text-neutral-400']">
      {{ tn('matching-note') }}
    </p>
  </section>
</template>
