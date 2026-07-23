<script setup lang="ts">
import type { ServerForm } from '../mcp-config'

import { Checkbox, FieldInput, FieldSelect } from '@proj-airi/ui'
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'

const model = defineModel<ServerForm>({ required: true })

const { t } = useI18n()
const tn = (key: string) => t(`settings.pages.modules.mcp-server.fields.browser-backend.${key}`)

function envValue(key: string, fallback: string): string {
  return model.value.envEntries.find(entry => entry.key.trim() === key)?.value ?? fallback
}

function setEnvValue(key: string, value: string): void {
  const existing = model.value.envEntries.find(entry => entry.key.trim() === key)
  if (existing) {
    existing.value = value
    return
  }
  model.value.envEntries.push({ key, value })
}

function removeEnvValue(key: string): void {
  const index = model.value.envEntries.findIndex(entry => entry.key.trim() === key)
  if (index >= 0)
    model.value.envEntries.splice(index, 1)
}

const defaultBackend = computed({
  get: () => envValue('LUMI_BROWSER_DEFAULT_BACKEND', 'patchright'),
  set: value => setEnvValue('LUMI_BROWSER_DEFAULT_BACKEND', value),
})
const fallbackBackend = computed({
  get: () => envValue('LUMI_BROWSER_FALLBACK_BACKEND', 'playwright'),
  set: value => setEnvValue('LUMI_BROWSER_FALLBACK_BACKEND', value),
})
const patchrightChannel = computed({
  get: () => envValue('LUMI_PATCHRIGHT_CHANNEL', 'chrome'),
  set: value => setEnvValue('LUMI_PATCHRIGHT_CHANNEL', value),
})
const profilePath = computed({
  get: () => envValue(
    'LUMI_BROWSER_PROFILE_PATH',
    envValue('LUMI_PLAYWRIGHT_USER_DATA_DIR', ''),
  ),
  set: (value) => {
    if (!value.trim()) {
      removeEnvValue('LUMI_BROWSER_PROFILE_PATH')
      removeEnvValue('LUMI_PLAYWRIGHT_USER_DATA_DIR')
      return
    }
    setEnvValue('LUMI_BROWSER_PROFILE_PATH', value)
    setEnvValue('LUMI_PLAYWRIGHT_USER_DATA_DIR', value)
  },
})

function booleanEnvironmentModel(key: string, fallback: boolean) {
  return computed({
    get: () => envValue(key, String(fallback)).toLowerCase() === 'true',
    set: value => setEnvValue(key, String(value)),
  })
}

const patchrightHeadless = booleanEnvironmentModel('LUMI_PATCHRIGHT_HEADLESS', false)
const persistentContext = booleanEnvironmentModel('LUMI_PATCHRIGHT_PERSISTENT_CONTEXT', true)
const noViewport = booleanEnvironmentModel('LUMI_PATCHRIGHT_NO_VIEWPORT', true)

const backendOptions = [
  { label: 'Patchright', value: 'patchright' },
  { label: 'Playwright', value: 'playwright' },
]
const fallbackOptions = [
  { label: 'Playwright', value: 'playwright' },
  { label: tn('disabled'), value: 'none' },
]
const channelOptions = [
  { label: 'Google Chrome', value: 'chrome' },
  { label: 'Chromium', value: 'chromium' },
]
</script>

<template>
  <section
    :class="[
      'flex flex-col gap-4 rounded-lg border border-cyan-500/25 p-4',
      'bg-cyan-500/5 dark:bg-cyan-400/5',
    ]"
  >
    <div class="flex items-center gap-3">
      <span class="i-solar:global-line-duotone size-6 shrink-0 text-cyan-600 dark:text-cyan-300" />
      <div class="min-w-0 flex flex-col gap-0.5">
        <h4 class="text-sm font-semibold">
          {{ tn('title') }}
        </h4>
        <p class="text-xs text-neutral-500 dark:text-neutral-400">
          {{ tn('description') }}
        </p>
      </div>
    </div>

    <div class="grid grid-cols-1 gap-3 md:grid-cols-2">
      <FieldSelect
        v-model="defaultBackend"
        :label="tn('default.label')"
        :description="tn('default.description')"
        :options="backendOptions"
      />
      <FieldSelect
        v-model="fallbackBackend"
        :label="tn('fallback.label')"
        :description="tn('fallback.description')"
        :options="fallbackOptions"
      />
    </div>

    <div class="grid grid-cols-1 gap-3 md:grid-cols-2">
      <FieldSelect
        v-model="patchrightChannel"
        :label="tn('channel.label')"
        :description="tn('channel.description')"
        :options="channelOptions"
      />
      <FieldInput
        v-model="profilePath"
        :label="tn('profile.label')"
        :description="tn('profile.description')"
        input-class="font-mono"
        :required="false"
      />
    </div>

    <div class="grid grid-cols-1 gap-3 md:grid-cols-3">
      <label class="flex items-start gap-3 border border-neutral-200/70 rounded-lg p-3 text-sm dark:border-neutral-800">
        <Checkbox v-model="patchrightHeadless" class="mt-0.5 shrink-0" />
        <span class="flex flex-col gap-1">
          <span class="font-medium">{{ tn('headless.label') }}</span>
          <span class="text-xs text-neutral-500 dark:text-neutral-400">{{ tn('headless.description') }}</span>
        </span>
      </label>
      <label class="flex items-start gap-3 border border-neutral-200/70 rounded-lg p-3 text-sm dark:border-neutral-800">
        <Checkbox v-model="persistentContext" class="mt-0.5 shrink-0" />
        <span class="flex flex-col gap-1">
          <span class="font-medium">{{ tn('persistent.label') }}</span>
          <span class="text-xs text-neutral-500 dark:text-neutral-400">{{ tn('persistent.description') }}</span>
        </span>
      </label>
      <label class="flex items-start gap-3 border border-neutral-200/70 rounded-lg p-3 text-sm dark:border-neutral-800">
        <Checkbox v-model="noViewport" class="mt-0.5 shrink-0" />
        <span class="flex flex-col gap-1">
          <span class="font-medium">{{ tn('no-viewport.label') }}</span>
          <span class="text-xs text-neutral-500 dark:text-neutral-400">{{ tn('no-viewport.description') }}</span>
        </span>
      </label>
    </div>
  </section>
</template>
