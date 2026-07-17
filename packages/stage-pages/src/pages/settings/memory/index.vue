<script setup lang="ts">
import LumiMemoryManager from '../modules/memory-long-term.vue'
</script>

<template>
  <LumiMemoryManager />
</template>

<route lang="yaml">
meta:
  layout: settings
  titleKey: settings.pages.memory.title
  subtitleKey: settings.title
  descriptionKey: settings.pages.memory.description
  icon: i-solar:leaf-bold-duotone
  settingsEntry: true
  order: 5
  stageTransition:
    name: slide
</route>
