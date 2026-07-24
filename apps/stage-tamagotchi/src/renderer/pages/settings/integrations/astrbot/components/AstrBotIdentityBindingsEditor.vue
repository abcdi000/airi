<script setup lang="ts">
import type { ElectronLumiAstrBotIdentityBinding } from '../../../../../../shared/eventa'

import { Button, FieldInput } from '@proj-airi/ui'
import { computed } from 'vue'

const props = defineProps<{
  bindings: ElectronLumiAstrBotIdentityBinding[]
  disabled?: boolean
}>()

const emit = defineEmits<{
  'update:bindings': [bindings: ElectronLumiAstrBotIdentityBinding[]]
}>()

const people = [
  {
    id: 'lumi-user-00000000-0000-4000-8000-000000000001',
    name: 'Doggy',
    icon: 'i-solar:user-heart-bold-duotone',
  },
  {
    id: 'lumi-user-00000000-0000-4000-8000-000000000002',
    name: 'Moussy',
    icon: 'i-solar:heart-shine-bold-duotone',
  },
] as const

const grouped = computed(() => people.map(person => ({
  ...person,
  bindings: props.bindings.filter(binding => binding.personId === person.id),
})))

function updateBinding(target: ElectronLumiAstrBotIdentityBinding, patch: Partial<ElectronLumiAstrBotIdentityBinding>) {
  emit('update:bindings', props.bindings.map(binding => binding === target ? { ...binding, ...patch } : binding))
}

function addBinding(personId: string) {
  emit('update:bindings', [
    ...props.bindings,
    {
      personId,
      platformInstanceId: 'default',
      externalUserId: '',
    },
  ])
}

function removeBinding(target: ElectronLumiAstrBotIdentityBinding) {
  emit('update:bindings', props.bindings.filter(binding => binding !== target))
}
</script>

<template>
  <div :class="['flex flex-col gap-7']">
    <section
      v-for="person in grouped"
      :key="person.id"
      :class="['flex flex-col gap-3 border-b border-neutral-200 pb-6 last:border-b-0 dark:border-neutral-800']"
    >
      <header :class="['flex items-center justify-between gap-4']">
        <div :class="['flex items-center gap-3']">
          <span :class="[person.icon, 'size-6 text-cyan-600 dark:text-cyan-300']" />
          <div>
            <h3 :class="['font-semibold']">
              {{ person.name }}
            </h3>
            <p :class="['text-xs text-neutral-500 dark:text-neutral-400']">
              可绑定多个 QQ 账号
            </p>
          </div>
        </div>
        <Button
          variant="secondary"
          size="sm"
          icon="i-solar:add-circle-bold-duotone"
          label="添加 QQ"
          :disabled="disabled"
          @click="addBinding(person.id)"
        />
      </header>

      <div v-if="person.bindings.length" :class="['flex flex-col gap-3']">
        <div
          v-for="(binding, index) in person.bindings"
          :key="`${person.id}:${index}`"
          :class="['grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] items-end gap-3']"
        >
          <FieldInput
            :model-value="binding.externalUserId"
            label="QQ 号"
            placeholder="例如 1770249418"
            :disabled="disabled"
            @update:model-value="updateBinding(binding, { externalUserId: String($event) })"
          />
          <FieldInput
            :model-value="binding.platformInstanceId"
            label="AstrBot 平台实例"
            placeholder="default"
            :disabled="disabled"
            @update:model-value="updateBinding(binding, { platformInstanceId: String($event) })"
          />
          <Button
            variant="secondary"
            icon="i-solar:trash-bin-trash-bold-duotone"
            label="删除"
            :disabled="disabled"
            @click="removeBinding(binding)"
          />
        </div>
      </div>
      <p v-else :class="['py-2 text-sm text-neutral-500 dark:text-neutral-400']">
        暂无已确认账号，Lumi 不会回复该身份。
      </p>
    </section>
  </div>
</template>
