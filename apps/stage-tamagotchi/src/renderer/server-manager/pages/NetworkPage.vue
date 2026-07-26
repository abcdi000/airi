<script setup lang="ts">
import { Button, FieldCheckbox, FieldInput, Textarea } from '@proj-airi/ui'

import ManagerPage from '../components/ManagerPage.vue'

import { useServerManager } from '../useServerManager'

const manager = useServerManager()
function save() {
  return manager.saveNetwork()
}
</script>

<template>
  <ManagerPage title="网络与安全" description="管理普通客户端连接地址、可信来源与 HTTPS/WSS 证书。管理 API 始终仅监听本机。" icon="i-solar:shield-network-bold-duotone">
    <template #actions>
      <Button label="保存并应用" icon="i-solar:diskette-bold-duotone" :loading="manager.busy.value" @click="save" />
    </template>
    <div :class="['max-w-3xl space-y-5']">
      <FieldInput v-model="manager.configDraft.publicBaseURL" label="客户端公开地址" /><div :class="['grid grid-cols-[minmax(0,1fr)_180px] gap-4']">
        <FieldInput v-model="manager.configDraft.hostname" label="监听地址" /><FieldInput v-model="manager.configDraft.port" type="number" label="端口" />
      </div><Textarea v-model="manager.configDraft.trustedOriginsText" label="可信 Web Origin（每行一个）" /><div :class="['border-t border-neutral-200 pt-5 dark:border-neutral-800']">
        <FieldCheckbox v-model="manager.configDraft.tlsEnabled" label="由 Lumi Server 直接启用 TLS" />
      </div><template v-if="manager.configDraft.tlsEnabled">
        <div :class="['grid grid-cols-2 gap-4']">
          <FieldInput v-model="manager.configDraft.tlsCertPath" label="证书路径" /><FieldInput v-model="manager.configDraft.tlsKeyPath" label="私钥路径" />
        </div><FieldInput v-model="manager.configDraft.tlsPassphrase" type="password" label="私钥口令（可选）" />
      </template><p :class="['text-xs text-neutral-500']">
        非本机客户端必须使用 HTTPS/WSS。也可以由你自己的反向代理或隧道终止 TLS。
      </p>
      <section :class="['border-t border-neutral-200 pt-6 space-y-4 dark:border-neutral-800']">
        <div :class="['flex items-start justify-between gap-4']">
          <div>
            <h2 :class="['text-lg font-semibold']">
              AstrBot 接入
            </h2>
            <p :class="['mt-1 text-sm text-neutral-500']">
              允许 QQ、KOOK 等 AstrBot 平台把消息交给同一个 Lumi Server。
            </p>
          </div>
          <Button
            label="复制集成令牌"
            icon="i-solar:copy-bold-duotone"
            :disabled="!manager.state.value?.config.astrbot.tokenConfigured"
            @click="manager.copyAstrBotToken"
          />
        </div>
        <FieldCheckbox v-model="manager.configDraft.astrbotEnabled" label="启用 AstrBot 感知桥" />
        <Textarea
          v-model="manager.configDraft.astrbotBindingsText"
          label="身份绑定（每行一条）"
          placeholder="default | 你的 QQ 号 | Lumi 人物 ID"
        />
        <p :class="['text-xs text-neutral-500']">
          格式：平台实例 ID | 平台用户 ID | Lumi 人物 ID。AstrBot 日志中的方括号首项通常就是平台实例 ID，例如 default。
        </p>
        <div :class="['border-t border-neutral-200 pt-5 space-y-4 dark:border-neutral-800']">
          <h3 :class="['text-base font-semibold']">
            群聊学习与表情包
          </h3>
          <div :class="['grid gap-4 sm:grid-cols-2']">
            <FieldCheckbox
              v-model="manager.configDraft.astrbotPrivateReplyEnabled"
              label="允许 Lumi 回复私聊"
            />
            <FieldCheckbox
              v-model="manager.configDraft.astrbotGroupObservationEnabled"
              label="启用只读群聊观察"
            />
          </div>
          <Textarea
            v-model="manager.configDraft.astrbotStudyGroupsText"
            label="允许观察的群（每行一条）"
            placeholder="default | 群号 | 群名称 | high"
          />
          <FieldInput v-model="manager.configDraft.astrbotObservationBatchSize" type="number" label="语言归纳批次" />
          <FieldCheckbox v-model="manager.configDraft.astrbotStickerEnabled" label="启用 Lumi 表情包库" />
          <FieldCheckbox v-model="manager.configDraft.astrbotStickerCollect" label="从指定学习群收藏表情包" />
          <FieldInput v-model="manager.configDraft.astrbotStickerRelativePath" label="表情包库相对路径" />
          <div :class="['grid grid-cols-3 gap-4']">
            <FieldInput v-model="manager.configDraft.astrbotStickerMaximumItems" type="number" label="库存上限" />
            <FieldInput v-model="manager.configDraft.astrbotStickerSendProbability" type="number" label="发送概率（0-1）" />
            <FieldInput v-model="manager.configDraft.astrbotStickerCooldownMessages" type="number" label="发送冷却（消息数）" />
          </div>
          <p :class="['text-xs text-neutral-500']">
            只读学习时 Server 只接收指定群的文字和图片，严格不向群聊发送消息。表情文件位于 Server 数据目录下的相对路径中。
          </p>
        </div>
      </section>
    </div>
  </ManagerPage>
</template>
