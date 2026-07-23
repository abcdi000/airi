import { useElectronEventaContext, useElectronEventaInvoke } from '@proj-airi/electron-vueuse'
import { projectLumiOnlineGeneration, projectLumiOnlineSnapshot } from '@proj-airi/stage-ui/libs/lumi-online-chat-projection'
import { useChatSessionStore } from '@proj-airi/stage-ui/stores/chat/session-store'
import { useChatStreamStore } from '@proj-airi/stage-ui/stores/chat/stream-store'
import { useLumiOnlineStore } from '@proj-airi/stage-ui/stores/lumi-online'

import {
  electronLumiOnlineClaimInvitation,
  electronLumiOnlineConnectStored,
  electronLumiOnlineGenerationPushed,
  electronLumiOnlineAccessRevoked,
  electronLumiOnlineGetState,
  electronLumiOnlineListConversations,
  electronLumiOnlineListDevices,
  electronLumiOnlineLogin,
  electronLumiOnlineLogout,
  electronLumiOnlineMessagesPushed,
  electronLumiOnlinePresencePushed,
  electronLumiOnlineReplayConversation,
  electronLumiOnlineRevokeDevice,
  electronLumiOnlineSendMessage,
  electronLumiOnlineStateChanged,
  electronLumiOnlineTranscribeVoice,
} from '../../shared/eventa'

/**
 * Connects the shared Lumi online store to Electron main-process transport.
 *
 * Use when:
 * - Initializing any desktop renderer window that can show Lumi chat or account state
 *
 * Expects:
 * - Electron main owns the encrypted bearer token and validates every request
 * - Server snapshots contain only conversations authorized for the authenticated account
 *
 * Returns:
 * - A disposer that removes all Eventa subscriptions owned by this renderer
 */
export function initializeLumiOnlineDesktopBridge() {
  const context = useElectronEventaContext()
  const online = useLumiOnlineStore()
  const sessions = useChatSessionStore()
  const stream = useChatStreamStore()
  const getState = useElectronEventaInvoke(electronLumiOnlineGetState)
  const login = useElectronEventaInvoke(electronLumiOnlineLogin)
  const claimInvitation = useElectronEventaInvoke(electronLumiOnlineClaimInvitation)
  const connectStored = useElectronEventaInvoke(electronLumiOnlineConnectStored)
  const logout = useElectronEventaInvoke(electronLumiOnlineLogout)
  const listConversations = useElectronEventaInvoke(electronLumiOnlineListConversations)
  const replayConversation = useElectronEventaInvoke(electronLumiOnlineReplayConversation)
  const sendMessage = useElectronEventaInvoke(electronLumiOnlineSendMessage)
  const listDevices = useElectronEventaInvoke(electronLumiOnlineListDevices)
  const revokeDevice = useElectronEventaInvoke(electronLumiOnlineRevokeDevice)
  const transcribeVoice = useElectronEventaInvoke(electronLumiOnlineTranscribeVoice)

  online.setBridge({
    getState: () => getState(),
    login: input => login(input),
    claimInvitation: input => claimInvitation(input),
    connectStored: input => connectStored(input),
    logout: () => logout(),
    listConversations: () => listConversations(),
    replayConversation: input => replayConversation(input),
    sendMessage: input => sendMessage(input),
    listDevices: () => listDevices(),
    revokeDevice: input => revokeDevice(input),
    transcribeVoice: input => transcribeVoice(input),
    onState: handler => context.value.on(electronLumiOnlineStateChanged, (event) => {
      if (event.body)
        handler(event.body)
    }),
    onMessages: handler => context.value.on(electronLumiOnlineMessagesPushed, (event) => {
      if (event.body)
        handler(event.body)
    }),
    onGeneration: handler => context.value.on(electronLumiOnlineGenerationPushed, (event) => {
      if (!event.body)
        return
      projectLumiOnlineGeneration(event.body, sessions.activeSessionId, stream)
      handler(event.body)
    }),
    onPresence: handler => context.value.on(electronLumiOnlinePresencePushed, (event) => {
      if (event.body)
        handler(event.body)
    }),
    onAccessRevoked: handler => context.value.on(electronLumiOnlineAccessRevoked, (event) => {
      if (event.body)
        handler(event.body)
    }),
    projectSnapshot: snapshot => projectLumiOnlineSnapshot(snapshot, sessions),
    clearProjection: () => sessions.clearOnlineProjection(),
  })

  return () => {
    stream.resetStream()
  }
}
