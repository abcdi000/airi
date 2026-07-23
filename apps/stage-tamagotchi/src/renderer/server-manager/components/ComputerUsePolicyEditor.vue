<script setup lang="ts">
import { Textarea } from '@proj-airi/ui'
import { computed } from 'vue'

const model = defineModel<string>({ required: true })

const defaultDeniedApps = '1password,bitwarden,keepass,keychain,system settings,windows security,activity monitor,lumi,airi'

function listEnvironmentValue(key: string, fallback = '') {
  return computed({
    get: () => {
      const prefix = `${key}=`
      const line = model.value.split(/\r?\n/u).find(entry => entry.startsWith(prefix))
      const value = line?.slice(prefix.length) ?? fallback
      return value.split(',').map(item => item.trim()).filter(Boolean).join('\n')
    },
    set: (value: string) => {
      const serialized = value
        .split(/[\n,]/u)
        .map(item => item.trim())
        .filter(Boolean)
        .join(',')
      const prefix = `${key}=`
      const lines = model.value.split(/\r?\n/u).filter(Boolean)
      const index = lines.findIndex(line => line.startsWith(prefix))
      if (index >= 0)
        lines[index] = `${prefix}${serialized}`
      else
        lines.push(`${prefix}${serialized}`)
      model.value = lines.join('\n')
    },
  })
}

const deniedApps = listEnvironmentValue('COMPUTER_USE_DENY_APPS', defaultDeniedApps)
const deniedWindowTitles = listEnvironmentValue('COMPUTER_USE_DENY_WINDOW_TITLES')
</script>

<template>
  <section :class="['border-y border-neutral-200 py-4 dark:border-neutral-800']">
    <div :class="['mb-4 flex items-start gap-3']">
      <span :class="['i-solar:shield-warning-bold-duotone mt-0.5 size-5 text-amber-500']" />
      <div>
        <h3 :class="['text-sm font-semibold']">
          应用黑名单
        </h3>
        <p :class="['mt-1 text-xs leading-5 text-neutral-500']">
          除下列项目外，服务器上的 Lumi 可以操作任意桌面应用。匹配不区分大小写，并按名称包含关系阻止。
        </p>
      </div>
    </div>
    <div :class="['grid grid-cols-2 gap-4']">
      <Textarea
        v-model="deniedApps"
        label="禁止操作的应用（每行一个）"
        placeholder="1password&#10;windows security&#10;lumi"
      />
      <Textarea
        v-model="deniedWindowTitles"
        label="禁止操作的窗口标题（每行一个）"
        placeholder="付款确认&#10;私人文档"
      />
    </div>
    <p :class="['mt-3 text-xs text-neutral-500']">
      清空应用列表会允许所有应用；保存配置并重启 Server 后生效。
    </p>
  </section>
</template>
