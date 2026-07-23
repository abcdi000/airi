<script setup lang="ts">
import type { ServerChannelQrPayload } from '@proj-airi/stage-shared/server-channel-qr'

import { errorMessageFrom } from '@moeru/std'
import { useElectronEventaInvoke } from '@proj-airi/electron-vueuse'
import { Button, Callout, Collapsible } from '@proj-airi/ui'
import { storeToRefs } from 'pinia'
import { renderSVG } from 'uqr'
import { computed, shallowRef, watch } from 'vue'
import { useI18n } from 'vue-i18n'

import { electronGetServerChannelQrPayload } from '../../../../../shared/eventa'
import { useServerChannelSettingsStore } from '../../../../stores/settings/server-channel'

const { t } = useI18n()
const getServerChannelQrPayload = useElectronEventaInvoke(electronGetServerChannelQrPayload)
const { authToken, hostname, tlsConfig } = storeToRefs(useServerChannelSettingsStore())

const loading = shallowRef(false)
const payload = shallowRef<ServerChannelQrPayload>()
const errorMessage = shallowRef('')
const payloadText = computed(() => payload.value ? JSON.stringify(payload.value) : '')
const qrCodeSource = computed(() => {
  if (!payloadText.value)
    return ''

  // NOTICE:
  // Android barcode readers can miss inverted dark-theme QR codes.
  // Keep a fixed dark-on-white palette until the scanner supports inverted detection.
  // Source/context: `@capacitor/barcode-scanner` and AIRI issue #1606.
  // Removal condition: the Pocket scanner reliably supports inverted QR codes.
  const svg = renderSVG(payloadText.value, {
    border: 2,
    ecc: 'M',
    pixelSize: 8,
    whiteColor: '#FFFFFF',
    blackColor: '#121212',
  })
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`
})

async function refreshPayload() {
  loading.value = true
  errorMessage.value = ''
  try {
    payload.value = await getServerChannelQrPayload()
  }
  catch (error) {
    payload.value = undefined
    errorMessage.value = errorMessageFrom(error) ?? t('settings.pages.connection.qr.errors.unavailable')
  }
  finally {
    loading.value = false
  }
}

watch([hostname, tlsConfig, authToken], () => void refreshPayload(), { immediate: true })
</script>

<template>
  <Collapsible :default="false">
    <template #trigger="slotProps">
      <button
        :class="['w-full flex items-center justify-between gap-3 rounded-lg text-left outline-none transition-all duration-250 ease-in-out']"
        @click="slotProps.setVisible(!slotProps.visible)"
      >
        <div :class="['min-w-0 flex flex-col gap-1']">
          <div :class="['text-sm font-medium text-neutral-900 dark:text-neutral-100']">
            {{ t('settings.pages.connection.qr.title') }}
          </div>
          <p :class="['m-0 text-xs leading-5 text-neutral-500 dark:text-neutral-400']">
            {{ t('settings.pages.connection.qr.description') }}
          </p>
        </div>
        <div :class="['i-solar:alt-arrow-down-linear shrink-0 text-neutral-400 transition-transform duration-250', slotProps.visible ? 'rotate-180' : 'rotate-0']" />
      </button>
    </template>

    <div :class="['mt-3 flex flex-col gap-4 rounded-lg bg-white/70 p-4 dark:bg-neutral-900/50']">
      <p :class="['m-0 text-xs leading-5 text-neutral-500 dark:text-neutral-400']">
        {{ t('settings.pages.connection.qr.token-hint') }}
      </p>
      <Callout v-if="errorMessage" theme="orange" :label="t('settings.pages.connection.qr.errors.title')">
        {{ errorMessage }}
      </Callout>
      <div v-else-if="payload" :class="['grid grid-cols-1 gap-4 md:grid-cols-[auto_minmax(0,1fr)]']">
        <img :src="qrCodeSource" :alt="t('settings.pages.connection.qr.image-alt')" :class="['h-48 w-48']">
        <div :class="['min-w-0 flex flex-col gap-3']">
          <Button size="sm" variant="secondary-muted" :loading="loading" :label="t('settings.pages.connection.qr.refresh')" @click="refreshPayload" />
          <div :class="['text-xs font-medium text-neutral-600 dark:text-neutral-300']">
            {{ t('settings.pages.connection.qr.candidates') }}
          </div>
          <ul :class="['m-0 list-none flex flex-col gap-2 p-0']">
            <li v-for="url in payload.urls" :key="url" :class="['break-all rounded-lg bg-neutral-100/80 px-3 py-2 font-mono text-xs dark:bg-neutral-800/80']">
              {{ url }}
            </li>
          </ul>
        </div>
      </div>
    </div>
  </Collapsible>
</template>
