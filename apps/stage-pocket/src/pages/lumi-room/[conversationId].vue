<script setup lang="ts">
import { computed } from 'vue'
import { useRoute } from 'vue-router'

import LumiRoomView from '../../components/lumi-room/LumiRoomView.vue'

const props = defineProps<{
  conversationId: string
}>()

const route = useRoute()
const title = computed(() => typeof route.query.title === 'string' ? route.query.title : undefined)
</script>

<template>
  <LumiRoomView :conversation-id="props.conversationId" :title="title" />
</template>

<route lang="yaml">
props: true
meta:
  layout: plain
</route>
