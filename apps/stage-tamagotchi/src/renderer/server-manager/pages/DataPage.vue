<script setup lang="ts">
import { Button, Callout } from '@proj-airi/ui'

import ManagerPage from '../components/ManagerPage.vue'

import { useServerManager } from '../useServerManager'

const manager = useServerManager()
</script>

<template>
  <ManagerPage title="备份与迁移" description="先验证迁移包，再事务导入；服务器完整备份与离线客户端归档保持分离。" icon="i-solar:archive-bold-duotone">
    <div :class="['grid grid-cols-2 gap-8']">
      <section>
        <div :class="['mb-4 flex items-center gap-3']">
          <span :class="['i-solar:import-bold-duotone size-6 text-cyan-600']" /><div>
            <h2 :class="['font-semibold']">
              旧 Lumi 数据迁移
            </h2><p :class="['text-xs text-neutral-500']">
              原始数据不会在验证阶段被修改。
            </p>
          </div>
        </div><div :class="['flex gap-2']">
          <Button label="选择迁移包" icon="i-solar:file-download-bold-duotone" @click="manager.stageMigration" /><Button variant="secondary" label="确认导入" icon="i-solar:check-circle-bold-duotone" :disabled="!manager.migration.value?.migrationId || !manager.running.value" @click="manager.commitMigration" />
        </div><Callout v-if="manager.migration.value?.report" theme="primary" label="迁移检查报告" :class="['mt-4']">
          <pre :class="['max-h-52 overflow-auto text-xs']">{{ JSON.stringify(manager.migration.value.report, null, 2) }}</pre>
        </Callout>
      </section><section :class="['border-l border-neutral-200 pl-8 dark:border-neutral-800']">
        <div :class="['mb-4 flex items-center gap-3']">
          <span :class="['i-solar:archive-bold-duotone size-6 text-violet-600']" /><div>
            <h2 :class="['font-semibold']">
              服务器灾难恢复
            </h2><p :class="['text-xs text-neutral-500']">
              完整备份不包含活动登录令牌。
            </p>
          </div>
        </div><div :class="['flex gap-2']">
          <Button label="创建完整备份" icon="i-solar:diskette-bold-duotone" :disabled="!manager.running.value" @click="manager.createBackup" /><Button variant="secondary" label="从备份恢复" icon="i-solar:history-bold-duotone" :disabled="manager.running.value" @click="manager.restoreBackup" />
        </div><p :class="['mt-4 text-xs text-neutral-500']">
          灾难恢复要求 Server 停止，并会先自动保存当前数据库。
        </p>
      </section>
    </div>
  </ManagerPage>
</template>
