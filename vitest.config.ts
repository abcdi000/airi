import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    projects: [
      'apps/server',
      'apps/lumi-server',
      'apps/ui-server-auth',
      'apps/stage-tamagotchi',
      'packages/audio-pipelines-transcribe',
      'packages/cap-vite',
      'packages/core-agent',
      'packages/electron-screen-capture',
      'packages/lumi-agent-runtime',
      'packages/lumi-server-runtime',
      'packages/vishot-runner-browser',
      'packages/plugin-sdk',
      'packages/plugin-sdk-tamagotchi',
      'packages/server-runtime',
      'packages/server-sdk',
      'packages/stage-shared',
    ],
  },
})
