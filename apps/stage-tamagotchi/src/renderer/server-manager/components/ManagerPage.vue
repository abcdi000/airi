<script setup lang="ts">
defineProps<{ title: string, description: string, icon: string }>()
</script>

<template>
  <section v-motion :initial="{ opacity: 0, y: 12 }" :enter="{ opacity: 1, y: 0, transition: { duration: 260 } }" :class="['flex flex-col gap-7']">
    <header :class="['flex min-h-16 items-start justify-between gap-6 border-b border-neutral-200 pb-5 dark:border-neutral-800']">
      <div :class="['flex min-w-0 items-start gap-4']">
        <span :class="[icon, 'mt-0.5 size-7 shrink-0 text-cyan-600']" />
        <div>
          <h1 :class="['text-2xl font-semibold']">
            {{ title }}
          </h1>
          <p :class="['mt-1 max-w-2xl text-sm text-neutral-500']">
            {{ description }}
          </p>
        </div>
      </div>
      <div :class="['shrink-0']">
        <slot name="actions" />
      </div>
    </header>
    <slot />
  </section>
</template>
