<script setup lang="ts">
import type { ElectronLumiAstrBotGatewayConfig, ElectronLumiAstrBotStudyGroup } from '../../../../../../shared/eventa'

import { Button, FieldCheckbox, FieldInput, FieldSelect } from '@proj-airi/ui'

const props = defineProps<{
  mode: ElectronLumiAstrBotGatewayConfig['learningMode']
  groups: ElectronLumiAstrBotStudyGroup[]
  batchSize: number
  historyLimit: number
  concurrentGroups: number
  disabled?: boolean
}>()

const emit = defineEmits<{
  'update:mode': [value: ElectronLumiAstrBotGatewayConfig['learningMode']]
  'update:groups': [value: ElectronLumiAstrBotStudyGroup[]]
  'update:batchSize': [value: number]
  'update:historyLimit': [value: number]
  'update:concurrentGroups': [value: number]
}>()

function addGroup() {
  emit('update:groups', [
    ...props.groups,
    {
      id: crypto.randomUUID(),
      platformInstanceId: 'default',
      groupId: '',
      displayName: '学习群',
      enabled: true,
      priority: 'high',
    },
  ])
}

function updateGroup(target: ElectronLumiAstrBotStudyGroup, patch: Partial<ElectronLumiAstrBotStudyGroup>) {
  emit('update:groups', props.groups.map(group => group === target ? { ...group, ...patch } : group))
}

function removeGroup(target: ElectronLumiAstrBotStudyGroup) {
  emit('update:groups', props.groups.filter(group => group !== target))
}
</script>

<template>
  <section :class="['flex flex-col gap-5 border-t border-neutral-200 pt-6 dark:border-neutral-800']">
    <header :class="['flex items-start justify-between gap-4']">
      <div>
        <h2 :class="['text-base font-semibold']">
          群聊学习
        </h2>
        <p :class="['mt-1 max-w-2xl text-sm text-neutral-500 dark:text-neutral-400']">
          学习模式下 Lumi 只观察下列群的文字和图片，不发送消息。语言进入学习批次，图片可进入表情包库；群聊不会写入聊天记录、人物印象或长期事实记忆。
        </p>
      </div>
      <Button
        variant="secondary"
        size="sm"
        icon="i-solar:add-circle-bold-duotone"
        label="添加群"
        :disabled="disabled"
        @click="addGroup"
      />
    </header>

    <div :class="['grid gap-4 md:grid-cols-2']">
      <FieldSelect
        :model-value="mode"
        label="运行模式"
        :options="[
          { label: '正常私聊', value: 'normal' },
          { label: '只读学习', value: 'observe_only' },
        ]"
        :disabled="disabled"
        @update:model-value="emit('update:mode', $event as ElectronLumiAstrBotGatewayConfig['learningMode'])"
      />
      <FieldInput
        :model-value="String(batchSize)"
        label="每批消息数"
        description="每个群分别累计；某个群攒满后即可归纳，不会等待其他群。"
        inputmode="numeric"
        :disabled="disabled"
        @update:model-value="emit('update:batchSize', Number($event))"
      />
      <FieldInput
        :model-value="String(concurrentGroups)"
        label="并行归纳群数"
        description="不同群可同时调用意识模型；同一群始终按消息顺序串行处理。"
        inputmode="numeric"
        :disabled="disabled"
        @update:model-value="emit('update:concurrentGroups', Number($event))"
      />
      <FieldInput
        :model-value="String(historyLimit)"
        label="监控台保留消息数"
        description="只限制“最近接收”和实时事件的可查看历史，不会删除尚未归纳的消息。"
        inputmode="numeric"
        :disabled="disabled"
        @update:model-value="emit('update:historyLimit', Number($event))"
      />
    </div>

    <div v-if="groups.length" :class="['flex flex-col gap-4']">
      <div
        v-for="group in groups"
        :key="group.id"
        :class="['grid gap-3 border-b border-neutral-200 pb-4 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_auto] dark:border-neutral-800']"
      >
        <FieldInput
          :model-value="group.displayName"
          label="显示名称"
          :disabled="disabled"
          @update:model-value="updateGroup(group, { displayName: String($event) })"
        />
        <FieldInput
          :model-value="group.groupId"
          label="群号 / 群 ID"
          :disabled="disabled"
          @update:model-value="updateGroup(group, { groupId: String($event) })"
        />
        <FieldInput
          :model-value="group.platformInstanceId"
          label="AstrBot 实例"
          :disabled="disabled"
          @update:model-value="updateGroup(group, { platformInstanceId: String($event) })"
        />
        <div :class="['flex items-end gap-2 pb-1']">
          <FieldCheckbox
            :model-value="group.enabled"
            label="启用"
            :disabled="disabled"
            @update:model-value="updateGroup(group, { enabled: Boolean($event) })"
          />
          <Button
            variant="secondary"
            icon="i-solar:trash-bin-trash-bold-duotone"
            title="删除群"
            :disabled="disabled"
            @click="removeGroup(group)"
          />
        </div>
      </div>
    </div>
    <p v-else :class="['text-sm text-neutral-500 dark:text-neutral-400']">
      尚未指定学习群。即使切换到只读学习，插件也不会接收任何群聊。
    </p>
  </section>
</template>
