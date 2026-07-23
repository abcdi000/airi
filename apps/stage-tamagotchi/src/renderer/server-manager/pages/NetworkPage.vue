<script setup lang="ts">
import { Button, FieldCheckbox, FieldInput, Textarea } from '@proj-airi/ui'

import ManagerPage from '../components/ManagerPage.vue'

import { useServerManager } from '../useServerManager'

const manager = useServerManager()
function save() {
  return manager.applyConfig({ publicBaseURL: manager.configDraft.publicBaseURL, hostname: manager.configDraft.hostname, port: Number(manager.configDraft.port), trustedOrigins: manager.configDraft.trustedOriginsText.split(/\r?\n/).map(item => item.trim()).filter(Boolean), tlsEnabled: manager.configDraft.tlsEnabled, tls: manager.configDraft.tlsEnabled ? { certPath: manager.configDraft.tlsCertPath, keyPath: manager.configDraft.tlsKeyPath, ...(manager.configDraft.tlsPassphrase ? { passphrase: manager.configDraft.tlsPassphrase } : {}) } : undefined }, '网络与安全配置已保存并应用')
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
    </div>
  </ManagerPage>
</template>
