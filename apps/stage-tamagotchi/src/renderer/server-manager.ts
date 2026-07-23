import { MotionPlugin } from '@vueuse/motion'
import { createApp } from 'vue'

import ServerManagerApp from './server-manager/ServerManagerApp.vue'

import '@unocss/reset/tailwind.css'
import './styles/main.css'
import 'uno.css'

createApp(ServerManagerApp).use(MotionPlugin).mount('#app')
