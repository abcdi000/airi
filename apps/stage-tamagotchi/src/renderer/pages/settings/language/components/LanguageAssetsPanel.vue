<script setup lang="ts">
import type {
  JargonKnowledge,
  LearnedExpression,
  LearnedExpressionStatus,
  LearnedSocialBehavior,
} from '@proj-airi/stage-ui/stores/lumi-social-language'

import { useLumiSocialLanguageStore } from '@proj-airi/stage-ui/stores/lumi-social-language'
import { Button, DoubleCheckButton, Input, SelectTab } from '@proj-airi/ui'
import { storeToRefs } from 'pinia'
import { computed, reactive, shallowRef } from 'vue'

type AssetTab = 'expressions' | 'jargon' | 'behaviors' | 'feedback'

const store = useLumiSocialLanguageStore()
const { snapshot } = storeToRefs(store)
const activeTab = shallowRef<AssetTab>('expressions')
const search = shallowRef('')
const statusFilter = shallowRef<'all' | LearnedExpressionStatus>('all')
const editingExpressionId = shallowRef('')
const expressionDraft = reactive({
  phrase: '',
  situation: '',
  pragmaticFunction: '',
  emotionalMeaning: '',
  tone: '',
  patternType: 'exact_phrase',
  status: 'observed' as LearnedExpressionStatus,
})
const editingJargonId = shallowRef('')
const jargonDraft = reactive({ term: '', meaning: '', context: '', functions: '', tone: '' })
const editingBehaviorId = shallowRef('')
const behaviorDraft = reactive({ situation: '', action: '', expectedEffect: '' })

const tabs = [
  { label: '表达', value: 'expressions', icon: 'i-solar:chat-round-dots-bold-duotone' },
  { label: '黑话', value: 'jargon', icon: 'i-solar:hashtag-square-bold-duotone' },
  { label: '行为', value: 'behaviors', icon: 'i-solar:users-group-rounded-bold-duotone' },
  { label: '反馈', value: 'feedback', icon: 'i-solar:history-bold-duotone' },
]
const statuses: Array<{ label: string, value: 'all' | LearnedExpressionStatus }> = [
  { label: '全部状态', value: 'all' },
  { label: '待积累', value: 'observed' },
  { label: '已理解', value: 'understood' },
  { label: '试用', value: 'trial' },
  { label: '已采用', value: 'adopted' },
  { label: '已内化', value: 'habit' },
  { label: '衰退中', value: 'declining' },
  { label: '已遗忘', value: 'forgotten' },
]
const statusLabels = Object.fromEntries(statuses.filter(item => item.value !== 'all').map(item => [item.value, item.label]))

const filteredExpressions = computed(() => {
  const query = search.value.trim().toLocaleLowerCase()
  return snapshot.value.expressions
    .filter(item => statusFilter.value === 'all' || item.status === statusFilter.value)
    .filter(item => !query || [item.phrase, item.situation, item.pragmaticFunction, item.tone]
      .some(value => value?.toLocaleLowerCase().includes(query)))
    .sort((left, right) => right.lastSeenAt - left.lastSeenAt)
})
const feedbackDecisions = computed(() => snapshot.value.decisions
  .filter(item => item.laterFeedback)
  .slice()
  .reverse())

function startExpressionEdit(expression: LearnedExpression) {
  editingExpressionId.value = expression.id
  Object.assign(expressionDraft, {
    phrase: expression.phrase ?? '',
    situation: expression.situation,
    pragmaticFunction: expression.pragmaticFunction,
    emotionalMeaning: expression.emotionalMeaning ?? '',
    tone: expression.tone ?? '',
    patternType: expression.patternType,
    status: expression.status,
  })
}

async function saveExpression() {
  if (!editingExpressionId.value)
    return
  await store.updateExpression(editingExpressionId.value, {
    phrase: expressionDraft.phrase.trim() || undefined,
    situation: expressionDraft.situation.trim(),
    pragmaticFunction: expressionDraft.pragmaticFunction.trim(),
    emotionalMeaning: expressionDraft.emotionalMeaning.trim() || undefined,
    tone: expressionDraft.tone.trim() || undefined,
    patternType: expressionDraft.patternType,
    status: expressionDraft.status,
  })
  editingExpressionId.value = ''
}

function startJargonEdit(jargon: JargonKnowledge) {
  editingJargonId.value = jargon.id
  Object.assign(jargonDraft, {
    term: jargon.term,
    meaning: jargon.meanings[0]?.meaning ?? '',
    context: jargon.meanings[0]?.context ?? '',
    functions: jargon.pragmaticFunctions.join('，'),
    tone: jargon.emotionalTone ?? '',
  })
}

async function saveJargon() {
  const jargon = snapshot.value.jargon.find(item => item.id === editingJargonId.value)
  if (!jargon)
    return
  await store.updateJargon(jargon.id, {
    term: jargonDraft.term.trim(),
    meanings: [{
      meaning: jargonDraft.meaning.trim(),
      context: jargonDraft.context.trim(),
      confidence: jargon.meanings[0]?.confidence ?? 0.8,
      evidenceMessageIds: jargon.meanings[0]?.evidenceMessageIds ?? [],
    }],
    pragmaticFunctions: splitLabels(jargonDraft.functions),
    emotionalTone: jargonDraft.tone.trim() || undefined,
  })
  editingJargonId.value = ''
}

function startBehaviorEdit(behavior: LearnedSocialBehavior) {
  editingBehaviorId.value = behavior.id
  Object.assign(behaviorDraft, {
    situation: behavior.situation,
    action: behavior.action,
    expectedEffect: behavior.expectedEffect ?? '',
  })
}

async function saveBehavior() {
  if (!editingBehaviorId.value)
    return
  await store.updateBehavior(editingBehaviorId.value, {
    situation: behaviorDraft.situation.trim(),
    action: behaviorDraft.action.trim(),
    expectedEffect: behaviorDraft.expectedEffect.trim() || undefined,
  })
  editingBehaviorId.value = ''
}

function splitLabels(value: string) {
  return [...new Set(value.split(/[,，、]/).map(item => item.trim()).filter(Boolean))]
}

function formatTime(timestamp: number) {
  return new Date(timestamp).toLocaleString()
}

function feedbackLabels(feedback: NonNullable<(typeof feedbackDecisions.value)[number]['laterFeedback']>) {
  return [
    feedback.explicitPraise && '明确赞扬',
    feedback.explicitRejection && '明确拒绝',
    feedback.phraseEcho && '复述表达',
    feedback.playfulContinuation && '继续玩梗',
    feedback.normalContinuation && '正常延续',
    feedback.misunderstanding && '造成误解',
    feedback.aiStyleComplaint && 'AI 腔投诉',
    feedback.correctedMeaning && `纠正：${feedback.correctedMeaning}`,
  ].filter((item): item is string => Boolean(item))
}
</script>

<template>
  <section :class="['flex flex-col gap-5']">
    <div :class="['overflow-x-auto pb-1']">
      <SelectTab v-model="activeTab" :options="tabs" size="sm" tab-space="compact" />
    </div>

    <Transition name="language-panel" mode="out-in">
      <div v-if="activeTab === 'expressions'" key="expressions" :class="['flex flex-col gap-4']">
        <div :class="['grid gap-3 md:grid-cols-[1fr_180px]']">
          <Input v-model="search" placeholder="搜索说法、场景、语气" />
          <select v-model="statusFilter" :class="['h-9 rounded-lg border border-neutral-200 bg-white px-3 text-sm outline-none dark:border-neutral-800 dark:bg-neutral-900']">
            <option v-for="status in statuses" :key="status.value" :value="status.value">
              {{ status.label }}
            </option>
          </select>
        </div>
        <div :class="['text-xs text-neutral-500']">
          当前显示 {{ filteredExpressions.length }} / {{ snapshot.expressions.length }}。手动改为“已内化”会立即允许它按语境参与选择。
        </div>
        <div :class="['border-l-3 border-sky-500 bg-sky-500/8 px-4 py-3 text-sm text-sky-700 dark:text-sky-300']">
          自动成为“已内化习惯”需要至少成功使用 3 次、总使用 3 次、内化度达到 55%、熟悉度达到 50%。收到反馈不等于相关表达已经实际入选并成功使用。
        </div>

        <div v-if="!filteredExpressions.length" :class="['border-y border-neutral-200 py-12 text-center text-sm text-neutral-500 dark:border-neutral-800']">
          没有符合条件的表达
        </div>
        <article
          v-for="expression in filteredExpressions"
          :key="expression.id"
          v-motion
          :initial="{ opacity: 0, y: 5 }"
          :enter="{ opacity: 1, y: 0 }"
          :class="['border-b border-neutral-200 py-4 dark:border-neutral-800']"
        >
          <template v-if="editingExpressionId === expression.id">
            <div :class="['grid gap-3 md:grid-cols-2']">
              <Input v-model="expressionDraft.phrase" placeholder="具体说法（可选）" />
              <Input v-model="expressionDraft.situation" placeholder="适用场景" />
              <Input v-model="expressionDraft.pragmaticFunction" placeholder="表达作用" />
              <Input v-model="expressionDraft.tone" placeholder="语气" />
              <Input v-model="expressionDraft.emotionalMeaning" placeholder="情绪含义" />
              <select v-model="expressionDraft.status" :class="['h-9 rounded-lg border border-neutral-200 bg-white px-3 text-sm dark:border-neutral-800 dark:bg-neutral-900']">
                <option v-for="status in statuses.slice(1)" :key="status.value" :value="status.value">
                  {{ status.label }}
                </option>
              </select>
            </div>
            <div :class="['mt-3 flex gap-2']">
              <Button size="sm" icon="i-solar:diskette-bold-duotone" @click="saveExpression">
                保存
              </Button>
              <Button size="sm" variant="secondary" @click="editingExpressionId = ''">
                取消
              </Button>
            </div>
          </template>
          <template v-else>
            <div :class="['flex items-start justify-between gap-4']">
              <div :class="['min-w-0']">
                <div :class="['flex flex-wrap items-center gap-2']">
                  <strong :class="['break-words text-base']">{{ expression.phrase || expression.pragmaticFunction }}</strong>
                  <span :class="['rounded px-2 py-0.5 text-xs', expression.status === 'habit' ? 'bg-emerald-500/12 text-emerald-600' : 'bg-neutral-500/10 text-neutral-500']">
                    {{ statusLabels[expression.status] }}
                  </span>
                </div>
                <p :class="['mt-1 text-sm text-neutral-600 dark:text-neutral-300']">
                  {{ expression.situation }} · {{ expression.pragmaticFunction }}
                </p>
                <p :class="['mt-2 text-xs text-neutral-500']">
                  观察 {{ expression.observationCount }} 次 · 使用 {{ expression.useCount }} 次 · 成功 {{ expression.successfulUseCount }} · 尴尬 {{ expression.awkwardUseCount }} · 拒绝 {{ expression.explicitRejectionCount }}
                </p>
                <p :class="['mt-1 text-xs text-neutral-500']">
                  熟悉度 {{ Math.round(expression.familiarity * 100) }}% · 内化度 {{ Math.round(expression.ownership * 100) }}% · 置信度 {{ Math.round(expression.confidence * 100) }}%
                </p>
              </div>
              <div :class="['flex shrink-0 items-center gap-2']">
                <Button size="sm" variant="secondary" shape="square" icon="i-solar:pen-bold-duotone" title="编辑表达" @click="startExpressionEdit(expression)" />
                <DoubleCheckButton size="sm" variant="danger" @confirm="store.deleteExpression(expression.id)">
                  删除
                  <template #confirm>
                    确认删除
                  </template>
                  <template #cancel>
                    取消
                  </template>
                </DoubleCheckButton>
              </div>
            </div>
          </template>
        </article>
      </div>

      <div v-else-if="activeTab === 'jargon'" key="jargon" :class="['flex flex-col']">
        <div v-if="!snapshot.jargon.length" :class="['py-12 text-center text-sm text-neutral-500']">
          还没有黑话知识
        </div>
        <article v-for="jargon in snapshot.jargon" :key="jargon.id" :class="['border-b border-neutral-200 py-4 dark:border-neutral-800']">
          <template v-if="editingJargonId === jargon.id">
            <div :class="['grid gap-3 md:grid-cols-2']">
              <Input v-model="jargonDraft.term" placeholder="词语" />
              <Input v-model="jargonDraft.meaning" placeholder="语境含义" />
              <Input v-model="jargonDraft.context" placeholder="适用语境" />
              <Input v-model="jargonDraft.functions" placeholder="表达作用，逗号分隔" />
              <Input v-model="jargonDraft.tone" placeholder="情绪语气" />
            </div>
            <div :class="['mt-3 flex gap-2']">
              <Button size="sm" @click="saveJargon">
                保存
              </Button>
              <Button size="sm" variant="secondary" @click="editingJargonId = ''">
                取消
              </Button>
            </div>
          </template>
          <div v-else :class="['flex items-start justify-between gap-4']">
            <div>
              <strong>{{ jargon.term }}</strong>
              <p v-for="meaning in jargon.meanings" :key="`${meaning.meaning}-${meaning.context}`" :class="['mt-1 text-sm text-neutral-600 dark:text-neutral-300']">
                {{ meaning.meaning }} <span :class="['text-neutral-500']">· {{ meaning.context }}</span>
              </p>
              <p :class="['mt-2 text-xs text-neutral-500']">
                {{ jargon.pragmaticFunctions.join('、') || '尚未归纳表达作用' }}
              </p>
            </div>
            <div :class="['flex gap-2']">
              <Button size="sm" variant="secondary" shape="square" icon="i-solar:pen-bold-duotone" title="编辑黑话" @click="startJargonEdit(jargon)" />
              <DoubleCheckButton size="sm" variant="danger" @confirm="store.deleteJargon(jargon.id)">
                删除<template #confirm>
                  确认删除
                </template><template #cancel>
                  取消
                </template>
              </DoubleCheckButton>
            </div>
          </div>
        </article>
      </div>

      <div v-else-if="activeTab === 'behaviors'" key="behaviors" :class="['flex flex-col']">
        <div v-if="!snapshot.behaviors.length" :class="['py-12 text-center text-sm text-neutral-500']">
          还没有互动行为
        </div>
        <article v-for="behavior in snapshot.behaviors" :key="behavior.id" :class="['border-b border-neutral-200 py-4 dark:border-neutral-800']">
          <template v-if="editingBehaviorId === behavior.id">
            <div :class="['grid gap-3']">
              <Input v-model="behaviorDraft.situation" placeholder="出现什么情况时" />
              <Input v-model="behaviorDraft.action" placeholder="Lumi 应该怎么做" />
              <Input v-model="behaviorDraft.expectedEffect" placeholder="预期效果" />
            </div>
            <div :class="['mt-3 flex gap-2']">
              <Button size="sm" @click="saveBehavior">
                保存
              </Button>
              <Button size="sm" variant="secondary" @click="editingBehaviorId = ''">
                取消
              </Button>
            </div>
          </template>
          <div v-else :class="['flex items-start justify-between gap-4']">
            <div>
              <strong>{{ behavior.situation }}</strong>
              <p :class="['mt-1 text-sm']">
                {{ behavior.action }}
              </p>
              <p :class="['mt-2 text-xs text-neutral-500']">
                置信度 {{ Math.round(behavior.confidence * 100) }}% · 成功 {{ behavior.successCount }} · 失败 {{ behavior.failureCount }}
              </p>
            </div>
            <div :class="['flex gap-2']">
              <Button size="sm" variant="secondary" shape="square" icon="i-solar:pen-bold-duotone" title="编辑行为" @click="startBehaviorEdit(behavior)" />
              <DoubleCheckButton size="sm" variant="danger" @confirm="store.deleteBehavior(behavior.id)">
                删除<template #confirm>
                  确认删除
                </template><template #cancel>
                  取消
                </template>
              </DoubleCheckButton>
            </div>
          </div>
        </article>
      </div>

      <div v-else key="feedback" :class="['flex flex-col']">
        <div v-if="!feedbackDecisions.length" :class="['py-12 text-center text-sm text-neutral-500']">
          还没有可审计反馈
        </div>
        <article v-for="decision in feedbackDecisions" :key="decision.id" :class="['border-b border-neutral-200 py-4 dark:border-neutral-800']">
          <div :class="['flex flex-wrap items-center justify-between gap-2']">
            <strong>{{ decision.actuallySentReply.messages.map(item => item.text).join(' / ') || '静默决策' }}</strong>
            <div :class="['flex items-center gap-2']">
              <time :class="['text-xs text-neutral-500']">{{ formatTime(decision.timestamp) }}</time>
              <DoubleCheckButton size="sm" variant="danger" @confirm="store.deleteDecision(decision.id)">
                删除
                <template #confirm>
                  确认删除
                </template>
                <template #cancel>
                  取消
                </template>
              </DoubleCheckButton>
            </div>
          </div>
          <div :class="['mt-2 flex flex-wrap gap-2']">
            <span v-for="label in feedbackLabels(decision.laterFeedback!)" :key="label" :class="['rounded bg-primary-500/10 px-2 py-1 text-xs text-primary-600 dark:text-primary-300']">{{ label }}</span>
          </div>
          <p :class="['mt-2 break-all text-xs text-neutral-500']">
            影响表达：{{ decision.selectedExpressions.join('、') || '无' }} · 影响行为：{{ decision.selectedBehaviors.join('、') || '无' }}
          </p>
        </article>
      </div>
    </Transition>
  </section>
</template>

<style scoped>
.language-panel-enter-active,
.language-panel-leave-active {
  transition: opacity 160ms ease, transform 160ms ease;
}

.language-panel-enter-from,
.language-panel-leave-to {
  opacity: 0;
  transform: translateY(5px);
}
</style>
