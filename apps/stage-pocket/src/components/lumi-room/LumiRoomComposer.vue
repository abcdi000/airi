<script setup lang="ts">
import { Button, Textarea } from '@proj-airi/ui'
import { computed, shallowRef } from 'vue'
import { useI18n } from 'vue-i18n'

const props = defineProps<{
  disabled?: boolean
  recording?: boolean
}>()

const emit = defineEmits<{
  cancelVoice: []
  send: [text: string]
  startVoice: []
  stopVoice: []
}>()

const { t } = useI18n()
const draft = shallowRef('')
const canSend = computed(() => !props.disabled && !props.recording && Boolean(draft.value.trim()))

function submit() {
  const text = draft.value.trim()
  if (!text || props.disabled)
    return
  emit('send', text)
  draft.value = ''
}
</script>

<template>
  <form
    :class="['border-t border-neutral-200 bg-white px-3 py-3 dark:border-neutral-800 dark:bg-neutral-950', 'flex items-end gap-2']"
    @submit.prevent="submit"
  >
    <Button
      v-if="!props.recording"
      type="button"
      shape="square"
      size="lg"
      variant="secondary"
      icon="i-solar:microphone-3-bold-duotone"
      :disabled="props.disabled"
      :title="t('stage.lumi-room.start-voice')"
      :aria-label="t('stage.lumi-room.start-voice')"
      @click="emit('startVoice')"
    />
    <template v-else>
      <Button
        type="button"
        shape="square"
        size="lg"
        variant="secondary"
        icon="i-solar:close-circle-bold-duotone"
        :title="t('stage.lumi-room.cancel-voice')"
        :aria-label="t('stage.lumi-room.cancel-voice')"
        @click="emit('cancelVoice')"
      />
      <Button
        type="button"
        shape="square"
        size="lg"
        icon="i-solar:stop-circle-bold-duotone"
        :title="t('stage.lumi-room.send-voice')"
        :aria-label="t('stage.lumi-room.send-voice')"
        @click="emit('stopVoice')"
      />
    </template>
    <Textarea
      v-model="draft"
      :placeholder="t('stage.lumi-room.composer-placeholder')"
      :disabled="props.disabled || props.recording"
      :rows="1"
      :class="['min-h-11 flex-1']"
      @keydown.ctrl.enter.prevent="submit"
    />
    <Button
      type="submit"
      shape="square"
      size="lg"
      icon="i-solar:plain-2-bold-duotone"
      :disabled="!canSend"
      :title="t('stage.lumi-room.send')"
      :aria-label="t('stage.lumi-room.send')"
    />
  </form>
</template>
