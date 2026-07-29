<script setup lang="ts">
import type { LumiChannelToolScope } from '@proj-airi/stage-shared/server-channel-qr'

import type {
  ElectronLumiChannelAuditEntry,
  ElectronLumiChannelDevice,
  ElectronLumiChannelDeviceCredential,
  ElectronMcpResourceLease,
} from '../../../../../shared/eventa'

import { errorMessageFrom } from '@moeru/std'
import { useElectronEventaInvoke } from '@proj-airi/electron-vueuse'
import { LUMI_AIRI_CARD_ID } from '@proj-airi/stage-ui/constants/lumi-card'
import { useChatSessionStore } from '@proj-airi/stage-ui/stores/chat/session-store'
import { useLumiIdentityStore } from '@proj-airi/stage-ui/stores/lumi-identity'
import { Button, Callout, DoubleCheckButton, FieldCheckbox, FieldInput, FieldSelect } from '@proj-airi/ui'
import { useClipboard, useIntervalFn } from '@vueuse/core'
import { storeToRefs } from 'pinia'
import { renderSVG } from 'uqr'
import { computed, onMounted, shallowRef, watch } from 'vue'
import { useI18n } from 'vue-i18n'

import {
  electronClearLumiChannelAudit,
  electronCreateLumiChannelDevice,
  electronListLumiChannelAudit,
  electronListLumiChannelDevices,
  electronMcpListResourceLeases,
  electronMcpTerminateResourceLease,
  electronRevokeLumiChannelDevice,
} from '../../../../../shared/eventa'

const { t } = useI18n()
const identityStore = useLumiIdentityStore()
const chatSessionStore = useChatSessionStore()
const { activeUserId, activeUsers } = storeToRefs(identityStore)
const { sessionMetas } = storeToRefs(chatSessionStore)

const listDevices = useElectronEventaInvoke(electronListLumiChannelDevices)
const createDevice = useElectronEventaInvoke(electronCreateLumiChannelDevice)
const revokeDevice = useElectronEventaInvoke(electronRevokeLumiChannelDevice)
const listAudit = useElectronEventaInvoke(electronListLumiChannelAudit)
const clearAudit = useElectronEventaInvoke(electronClearLumiChannelAudit)
const listResourceLeases = useElectronEventaInvoke(electronMcpListResourceLeases)
const terminateResourceLease = useElectronEventaInvoke(electronMcpTerminateResourceLease)

const devices = shallowRef<ElectronLumiChannelDevice[]>([])
const auditEntries = shallowRef<ElectronLumiChannelAuditEntry[]>([])
const resourceLeases = shallowRef<ElectronMcpResourceLease[]>([])
const deviceName = shallowRef('')
const selectedUserId = shallowRef('')
const selectedConversationId = shallowRef('')
const allowWebTools = shallowRef(false)
const allowMinecraftTools = shallowRef(false)
const allowComputerUseTools = shallowRef(false)
const credential = shallowRef<ElectronLumiChannelDeviceCredential>()
const creating = shallowRef(false)
const creatingRoom = shallowRef(false)
const revokingDeviceId = shallowRef('')
const clearingAudit = shallowRef(false)
const terminatingLeaseId = shallowRef('')
const errorMessage = shallowRef('')
const visibleAuditCount = shallowRef(30)

const userOptions = computed(() => activeUsers.value.map(user => ({ label: user.displayName, value: user.id })))
const groupRooms = computed(() => Object.values(sessionMetas.value)
  .filter(meta => meta.characterId === LUMI_AIRI_CARD_ID && meta.conversationType === 'group')
  .sort((a, b) => b.updatedAt - a.updatedAt))
const roomOptions = computed(() => groupRooms.value.map(room => ({
  label: room.title || t('settings.pages.connection.lumi-devices.untitled-room'),
  value: room.sessionId,
})))
const selectedRoom = computed(() => groupRooms.value.find(room => room.sessionId === selectedConversationId.value))
const visibleAuditEntries = computed(() => auditEntries.value.slice(0, visibleAuditCount.value))
const pairingText = computed(() => credential.value ? JSON.stringify(credential.value.pairing) : '')
const pairingQrSource = computed(() => {
  if (!pairingText.value)
    return ''
  const svg = renderSVG(pairingText.value, {
    border: 2,
    ecc: 'M',
    pixelSize: 7,
    whiteColor: '#FFFFFF',
    blackColor: '#121212',
  })
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`
})
const { copied: pairingCopied, copy: copyPairing } = useClipboard({ source: pairingText, legacy: true })

const canCreate = computed(() => Boolean(
  deviceName.value.trim()
  && selectedUserId.value
  && selectedRoom.value
  && !creating.value,
))

function requestedToolScopes(): LumiChannelToolScope[] {
  const scopes: LumiChannelToolScope[] = ['lumi:tool:memory']
  if (allowWebTools.value)
    scopes.push('lumi:tool:web')
  if (allowMinecraftTools.value)
    scopes.push('lumi:tool:minecraft')
  if (allowComputerUseTools.value)
    scopes.push('lumi:tool:computer-use')
  return scopes
}

async function refreshDevices() {
  try {
    devices.value = (await listDevices()).devices
  }
  catch (error) {
    errorMessage.value = errorMessageFrom(error) ?? t('settings.pages.connection.lumi-devices.errors.load')
  }
}

async function refreshAudit() {
  try {
    auditEntries.value = (await listAudit()).entries
    visibleAuditCount.value = 30
  }
  catch (error) {
    errorMessage.value = errorMessageFrom(error) ?? t('settings.pages.connection.lumi-devices.errors.audit-load')
  }
}

async function refreshResourceLeases() {
  try {
    resourceLeases.value = await listResourceLeases()
  }
  catch (error) {
    errorMessage.value = errorMessageFrom(error) ?? t('settings.pages.connection.lumi-devices.errors.resources-load')
  }
}

async function handleCreateRoom() {
  if (activeUsers.value.length < 2)
    return
  creatingRoom.value = true
  errorMessage.value = ''
  try {
    const title = activeUsers.value.map(user => user.displayName).join(' & ')
    selectedConversationId.value = await chatSessionStore.createGroupSession(
      activeUsers.value.map(user => user.id),
      { title, setActive: false },
    )
  }
  catch (error) {
    errorMessage.value = errorMessageFrom(error) ?? t('settings.pages.connection.lumi-devices.errors.create-room')
  }
  finally {
    creatingRoom.value = false
  }
}

async function handleCreateDevice() {
  if (!canCreate.value || !selectedRoom.value)
    return
  creating.value = true
  errorMessage.value = ''
  try {
    credential.value = await createDevice({
      name: deviceName.value.trim(),
      userId: selectedUserId.value,
      conversationId: selectedRoom.value.sessionId,
      roomTitle: selectedRoom.value.title || t('settings.pages.connection.lumi-devices.untitled-room'),
      toolScopes: requestedToolScopes(),
    })
    deviceName.value = ''
    await Promise.all([refreshDevices(), refreshAudit()])
  }
  catch (error) {
    errorMessage.value = errorMessageFrom(error) ?? t('settings.pages.connection.lumi-devices.errors.create')
  }
  finally {
    creating.value = false
  }
}

async function handleRevoke(deviceId: string) {
  revokingDeviceId.value = deviceId
  errorMessage.value = ''
  try {
    await revokeDevice({ deviceId })
    await Promise.all([refreshDevices(), refreshAudit()])
  }
  catch (error) {
    errorMessage.value = errorMessageFrom(error) ?? t('settings.pages.connection.lumi-devices.errors.revoke')
  }
  finally {
    revokingDeviceId.value = ''
  }
}

async function handleClearAudit() {
  clearingAudit.value = true
  try {
    await clearAudit()
    auditEntries.value = []
  }
  catch (error) {
    errorMessage.value = errorMessageFrom(error) ?? t('settings.pages.connection.lumi-devices.errors.audit-clear')
  }
  finally {
    clearingAudit.value = false
  }
}

function loadMoreAudit(event: Event) {
  const target = event.currentTarget as HTMLElement
  const reachedEnd = target.scrollTop + target.clientHeight >= target.scrollHeight - 96
  if (reachedEnd && visibleAuditEntries.value.length < auditEntries.value.length)
    visibleAuditCount.value += 30
}

async function handleTerminateLease(leaseId: string) {
  terminatingLeaseId.value = leaseId
  try {
    await terminateResourceLease({ leaseId })
    await Promise.all([refreshResourceLeases(), refreshAudit()])
  }
  catch (error) {
    errorMessage.value = errorMessageFrom(error) ?? t('settings.pages.connection.lumi-devices.errors.resource-terminate')
  }
  finally {
    terminatingLeaseId.value = ''
  }
}

function permissionSummary(device: ElectronLumiChannelDevice) {
  const labels = [t('settings.pages.connection.lumi-devices.permissions.memory-short')]
  if (device.scopes.includes('lumi:tool:web'))
    labels.push(t('settings.pages.connection.lumi-devices.permissions.web-short'))
  if (device.scopes.includes('lumi:tool:minecraft'))
    labels.push(t('settings.pages.connection.lumi-devices.permissions.minecraft-short'))
  if (device.scopes.includes('lumi:tool:computer-use'))
    labels.push(t('settings.pages.connection.lumi-devices.permissions.computer-use-short'))
  return labels.join(' / ')
}

function auditLabel(entry: ElectronLumiChannelAuditEntry) {
  return t(`settings.pages.connection.lumi-devices.audit.kinds.${entry.kind}`)
}

function formatTime(value: string) {
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'short', timeStyle: 'short' }).format(new Date(value))
}

watch(activeUsers, (users) => {
  if (!users.some(user => user.id === selectedUserId.value))
    selectedUserId.value = users.find(user => user.id !== activeUserId.value)?.id ?? activeUserId.value
}, { immediate: true })

watch(groupRooms, (rooms) => {
  if (!rooms.some(room => room.sessionId === selectedConversationId.value))
    selectedConversationId.value = rooms[0]?.sessionId ?? ''
}, { immediate: true })

onMounted(() => void Promise.all([refreshDevices(), refreshAudit(), refreshResourceLeases()]))
useIntervalFn(() => void refreshResourceLeases(), 5_000)
</script>

<template>
  <section :class="['flex flex-col gap-5 rounded-lg bg-neutral-50 p-4 dark:bg-neutral-800']">
    <header>
      <h3 :class="['m-0 text-base font-semibold text-neutral-900 dark:text-neutral-100']">
        {{ t('settings.pages.connection.lumi-devices.title') }}
      </h3>
      <p :class="['m-0 mt-1 text-xs leading-5 text-neutral-500 dark:text-neutral-400']">
        {{ t('settings.pages.connection.lumi-devices.description') }}
      </p>
    </header>

    <Callout v-if="errorMessage" theme="orange" :label="t('settings.pages.connection.lumi-devices.errors.title')">
      {{ errorMessage }}
    </Callout>

    <div :class="['grid grid-cols-1 gap-3 md:grid-cols-2']">
      <FieldInput v-model="deviceName" :label="t('settings.pages.connection.lumi-devices.name')" :placeholder="t('settings.pages.connection.lumi-devices.name-placeholder')" />
      <FieldSelect v-model="selectedUserId" :label="t('settings.pages.connection.lumi-devices.user')" :options="userOptions" />
      <FieldSelect v-model="selectedConversationId" :label="t('settings.pages.connection.lumi-devices.room')" :options="roomOptions" :disabled="!roomOptions.length" />
      <Button variant="secondary-muted" icon="i-solar:chat-round-dots-bold-duotone" :loading="creatingRoom" :label="t('settings.pages.connection.lumi-devices.create-room')" @click="handleCreateRoom" />
    </div>

    <Callout v-if="!roomOptions.length" theme="orange" :label="t('settings.pages.connection.lumi-devices.no-room-title')">
      {{ t('settings.pages.connection.lumi-devices.no-room-description') }}
    </Callout>

    <div :class="['flex flex-col gap-3']">
      <div>
        <h4 :class="['m-0 text-sm font-semibold']">
          {{ t('settings.pages.connection.lumi-devices.permissions.title') }}
        </h4>
        <p :class="['m-0 mt-1 text-xs text-neutral-500 dark:text-neutral-400']">
          {{ t('settings.pages.connection.lumi-devices.permissions.description') }}
        </p>
      </div>
      <FieldCheckbox :model-value="true" disabled :label="t('settings.pages.connection.lumi-devices.permissions.memory')" :description="t('settings.pages.connection.lumi-devices.permissions.memory-description')" />
      <FieldCheckbox v-model="allowWebTools" :label="t('settings.pages.connection.lumi-devices.permissions.web')" :description="t('settings.pages.connection.lumi-devices.permissions.web-description')" />
      <FieldCheckbox v-model="allowMinecraftTools" :label="t('settings.pages.connection.lumi-devices.permissions.minecraft')" :description="t('settings.pages.connection.lumi-devices.permissions.minecraft-description')" />
      <FieldCheckbox v-model="allowComputerUseTools" :label="t('settings.pages.connection.lumi-devices.permissions.computer-use')" :description="t('settings.pages.connection.lumi-devices.permissions.computer-use-description')" />
    </div>

    <Button variant="primary" icon="i-solar:link-circle-bold-duotone" :disabled="!canCreate" :loading="creating" :label="t('settings.pages.connection.lumi-devices.create')" @click="handleCreateDevice" />

    <div v-if="credential" :class="['grid grid-cols-1 gap-4 rounded-lg border border-cyan-200 bg-cyan-50 p-4 md:grid-cols-[auto_minmax(0,1fr)] dark:border-cyan-800 dark:bg-cyan-950/20']">
      <img :src="pairingQrSource" :alt="t('settings.pages.connection.lumi-devices.pairing-alt')" :class="['h-48 w-48']">
      <div :class="['min-w-0 flex flex-col gap-3']">
        <h4 :class="['m-0 text-sm font-semibold']">
          {{ t('settings.pages.connection.lumi-devices.pairing-title') }}
        </h4>
        <p :class="['m-0 text-xs leading-5 text-neutral-600 dark:text-neutral-300']">
          {{ t('settings.pages.connection.lumi-devices.pairing-once') }}
        </p>
        <Button variant="secondary-muted" :icon="pairingCopied ? 'i-solar:check-circle-bold-duotone' : 'i-solar:copy-line-duotone'" :label="t('settings.pages.connection.lumi-devices.copy')" @click="copyPairing()" />
      </div>
    </div>

    <div :class="['flex flex-col divide-y divide-neutral-200 dark:divide-neutral-700']">
      <div v-for="device in devices" :key="device.id" :class="['flex items-center justify-between gap-3 py-3']">
        <div :class="['min-w-0']">
          <div :class="['truncate text-sm font-medium']">
            {{ device.name }} / {{ activeUsers.find(user => user.id === device.userId)?.displayName || device.userId }}
          </div>
          <div :class="['mt-1 text-xs text-neutral-500 dark:text-neutral-400']">
            {{ device.roomTitle }} / {{ permissionSummary(device) }} / {{ device.revokedAt ? t('settings.pages.connection.lumi-devices.revoked') : t('settings.pages.connection.lumi-devices.active') }}
          </div>
        </div>
        <DoubleCheckButton v-if="!device.revokedAt" size="sm" variant="secondary-muted" :loading="revokingDeviceId === device.id" @confirm="handleRevoke(device.id)">
          {{ t('settings.pages.connection.lumi-devices.revoke') }}
          <template #confirm>
            {{ t('settings.pages.connection.lumi-devices.confirm-revoke') }}
          </template>
          <template #cancel>
            {{ t('settings.pages.connection.lumi-devices.cancel') }}
          </template>
        </DoubleCheckButton>
      </div>
      <p v-if="!devices.length" :class="['m-0 py-3 text-xs text-neutral-500 dark:text-neutral-400']">
        {{ t('settings.pages.connection.lumi-devices.empty') }}
      </p>
    </div>

    <div :class="['border-t border-neutral-200 pt-5 dark:border-neutral-700']">
      <div :class="['mb-3 flex items-center justify-between gap-3']">
        <div>
          <h4 :class="['m-0 text-sm font-semibold']">
            {{ t('settings.pages.connection.lumi-devices.resources.title') }}
          </h4>
          <p :class="['m-0 mt-1 text-xs text-neutral-500 dark:text-neutral-400']">
            {{ t('settings.pages.connection.lumi-devices.resources.description') }}
          </p>
        </div>
        <Button shape="square" size="sm" variant="secondary-muted" icon="i-solar:refresh-bold-duotone" :title="t('settings.pages.connection.lumi-devices.resources.refresh')" @click="refreshResourceLeases" />
      </div>
      <div v-for="lease in resourceLeases" :key="lease.id" :class="['flex items-center justify-between gap-3 py-2']">
        <div :class="['text-xs']">
          {{ t(`settings.pages.connection.lumi-devices.resources.types.${lease.resource}`) }} / {{ lease.actorId }}
          <span v-if="lease.terminationRequestedAt"> / {{ t('settings.pages.connection.lumi-devices.resources.stopping') }}</span>
        </div>
        <DoubleCheckButton size="sm" variant="secondary-muted" :loading="terminatingLeaseId === lease.id" @confirm="handleTerminateLease(lease.id)">
          {{ t('settings.pages.connection.lumi-devices.resources.terminate') }}
          <template #confirm>
            {{ t('settings.pages.connection.lumi-devices.resources.confirm-terminate') }}
          </template>
          <template #cancel>
            {{ t('settings.pages.connection.lumi-devices.cancel') }}
          </template>
        </DoubleCheckButton>
      </div>
      <p v-if="!resourceLeases.length" :class="['m-0 text-xs text-neutral-500 dark:text-neutral-400']">
        {{ t('settings.pages.connection.lumi-devices.resources.empty') }}
      </p>
    </div>

    <div :class="['border-t border-neutral-200 pt-5 dark:border-neutral-700']">
      <div :class="['mb-3 flex items-center justify-between gap-3']">
        <div>
          <h4 :class="['m-0 text-sm font-semibold']">
            {{ t('settings.pages.connection.lumi-devices.audit.title') }}
          </h4>
          <p :class="['m-0 mt-1 text-xs text-neutral-500 dark:text-neutral-400']">
            {{ t('settings.pages.connection.lumi-devices.audit.description') }}
          </p>
        </div>
        <DoubleCheckButton v-if="auditEntries.length" size="sm" variant="secondary-muted" :loading="clearingAudit" @confirm="handleClearAudit">
          {{ t('settings.pages.connection.lumi-devices.audit.clear') }}
          <template #confirm>
            {{ t('settings.pages.connection.lumi-devices.audit.confirm-clear') }}
          </template>
          <template #cancel>
            {{ t('settings.pages.connection.lumi-devices.cancel') }}
          </template>
        </DoubleCheckButton>
      </div>
      <ol
        v-if="auditEntries.length"
        :class="[
          'm-0 max-h-96 list-none divide-y divide-neutral-200 overflow-y-auto p-0 pr-1',
          'overscroll-contain [scrollbar-gutter:stable]',
          'dark:divide-neutral-700',
        ]"
        @scroll.passive="loadMoreAudit"
      >
        <li v-for="entry in visibleAuditEntries" :key="entry.id" :class="['grid grid-cols-[minmax(0,1fr)_auto] gap-3 py-2']">
          <div :class="['min-w-0 text-xs']">
            <div :class="['truncate font-medium']">
              {{ auditLabel(entry) }} / {{ entry.deviceName || entry.deviceId || t('settings.pages.connection.lumi-devices.audit.unknown-device') }}
            </div>
            <div :class="['truncate text-neutral-500 dark:text-neutral-400']">
              {{ entry.eventType || entry.code || entry.conversationId || t('settings.pages.connection.lumi-devices.audit.no-details') }}
            </div>
          </div>
          <div :class="['text-right text-[11px] text-neutral-400']">
            {{ formatTime(entry.createdAt) }}
          </div>
        </li>
        <li v-if="visibleAuditEntries.length < auditEntries.length" :class="['py-2 text-center text-xs tabular-nums text-neutral-500']">
          {{ visibleAuditEntries.length }} / {{ auditEntries.length }}
        </li>
      </ol>
      <p v-else :class="['m-0 text-xs text-neutral-500 dark:text-neutral-400']">
        {{ t('settings.pages.connection.lumi-devices.audit.empty') }}
      </p>
    </div>
  </section>
</template>
