<script setup lang="ts">
import type { LumiUserRecord } from '../../../../stores/lumi-identity'

import { Button, Input } from '@proj-airi/ui'
import { computed, shallowRef } from 'vue'
import { useI18n } from 'vue-i18n'

const props = defineProps<{
  users: readonly LumiUserRecord[]
  activeUserId: string
  mode?: 'create' | 'edit'
  initialParticipantUserIds?: readonly string[]
  initialTitle?: string
  busy?: boolean
  error?: string
}>()

const emit = defineEmits<{
  cancel: []
  submit: [payload: { participantUserIds: string[], title: string }]
}>()

const { t } = useI18n()
const title = shallowRef(props.initialTitle ?? '')
const selectedUserIds = shallowRef(
  props.users
    .filter(user => user.status === 'active'
      && user.id !== props.activeUserId
      && (props.initialParticipantUserIds?.includes(user.id) ?? true))
    .map(user => user.id),
)

const activeUsers = computed(() => props.users.filter(user => user.status === 'active'))
const isEditing = computed(() => props.mode === 'edit')
const canSubmit = computed(() => selectedUserIds.value.length > 0 && !props.busy)
const generatedTitle = computed(() => {
  const names = activeUsers.value
    .filter(user => user.id === props.activeUserId || selectedUserIds.value.includes(user.id))
    .map(user => user.displayName)
  return [...names, 'Lumi'].join(', ')
})

function isSelected(userId: string) {
  return userId === props.activeUserId || selectedUserIds.value.includes(userId)
}

function toggleUser(userId: string) {
  if (userId === props.activeUserId || props.busy)
    return
  selectedUserIds.value = selectedUserIds.value.includes(userId)
    ? selectedUserIds.value.filter(id => id !== userId)
    : [...selectedUserIds.value, userId]
}

function submit() {
  if (!canSubmit.value)
    return
  emit('submit', {
    participantUserIds: selectedUserIds.value,
    title: title.value.trim() || generatedTitle.value,
  })
}
</script>

<template>
  <section :class="['border-y border-neutral-200/70 bg-neutral-50/70 px-5 py-4 dark:border-neutral-800 dark:bg-neutral-950/35']">
    <div :class="['mb-3 flex items-start gap-3']">
      <div :class="['mt-0.5 h-8 w-8 shrink-0 flex items-center justify-center rounded-md bg-primary-500/12 text-primary-600 dark:text-primary-300']">
        <div class="i-solar:users-group-rounded-bold-duotone h-5 w-5" />
      </div>
      <div :class="['min-w-0']">
        <h3 :class="['text-sm font-semibold text-neutral-800 dark:text-neutral-100']">
          {{ t(isEditing ? 'stage.chat.sessions.group-edit-title' : 'stage.chat.sessions.group-create-title') }}
        </h3>
        <p :class="['mt-0.5 text-xs text-neutral-500 dark:text-neutral-400']">
          {{ t(isEditing ? 'stage.chat.sessions.group-edit-description' : 'stage.chat.sessions.group-create-description') }}
        </p>
      </div>
    </div>

    <label :class="['mb-3 block']">
      <span :class="['mb-1.5 block text-xs font-medium text-neutral-600 dark:text-neutral-300']">
        {{ t('stage.chat.sessions.group-name') }}
      </span>
      <Input
        v-model="title"
        :placeholder="generatedTitle"
        :disabled="props.busy"
      />
    </label>

    <div :class="['mb-1.5 text-xs font-medium text-neutral-600 dark:text-neutral-300']">
      {{ t('stage.chat.sessions.participants') }}
    </div>
    <div :class="['grid gap-1']">
      <button
        v-for="user in activeUsers"
        :key="user.id"
        type="button"
        :disabled="user.id === props.activeUserId || props.busy"
        :aria-pressed="isSelected(user.id)"
        :class="[
          'min-h-11 w-full flex items-center gap-3 rounded-md px-3 py-2 text-left outline-none',
          'transition-colors focus-visible:ring-2 focus-visible:ring-primary-400/50',
          isSelected(user.id)
            ? 'bg-primary-500/10 text-neutral-900 dark:text-neutral-100'
            : 'bg-white/65 text-neutral-600 hover:bg-neutral-100 dark:bg-neutral-900/50 dark:text-neutral-300 dark:hover:bg-neutral-800',
          user.id === props.activeUserId ? 'cursor-default' : '',
        ]"
        @click="toggleUser(user.id)"
      >
        <div
          :class="[
            'h-5 w-5 shrink-0 flex items-center justify-center rounded border',
            isSelected(user.id)
              ? 'border-primary-500 bg-primary-500 text-white'
              : 'border-neutral-300 bg-white dark:border-neutral-600 dark:bg-neutral-900',
          ]"
        >
          <div v-if="isSelected(user.id)" class="i-solar:check-read-linear h-3.5 w-3.5" />
        </div>
        <div :class="['min-w-0 flex-1']">
          <div :class="['truncate text-sm font-medium']">
            {{ user.displayName }}
          </div>
          <div :class="['truncate text-[11px] text-neutral-500 dark:text-neutral-400']">
            {{ user.preferredAddress }}
          </div>
        </div>
        <span v-if="user.id === props.activeUserId" :class="['text-[11px] text-neutral-400']">
          {{ t('stage.chat.sessions.current-user') }}
        </span>
      </button>
    </div>

    <p v-if="props.error" :class="['mt-3 text-xs text-red-600 dark:text-red-300']">
      {{ props.error }}
    </p>

    <div :class="['mt-4 flex justify-end gap-2']">
      <Button
        :label="t('stage.chat.sessions.cancel')"
        variant="ghost"
        size="sm"
        shape="rounded"
        :disabled="props.busy"
        @click="emit('cancel')"
      />
      <Button
        :label="t(isEditing ? 'stage.chat.sessions.save-group' : 'stage.chat.sessions.create-group')"
        :icon="isEditing ? 'i-solar:diskette-bold-duotone' : 'i-solar:users-group-rounded-bold-duotone'"
        size="sm"
        shape="rounded"
        :loading="props.busy"
        :disabled="!canSubmit"
        @click="submit"
      />
    </div>
  </section>
</template>
