import { useElectronEventaInvoke } from '@proj-airi/electron-vueuse'
import { useLlmToolsStore } from '@proj-airi/stage-ui/stores/llm-tools'
import { useLlmToolsetPromptsStore } from '@proj-airi/stage-ui/stores/llm-toolset-prompts'
import { useMcpStore } from '@proj-airi/stage-ui/stores/mcp'
import { createMcpRuntimeTools } from '@proj-airi/stage-ui/tools/mcp'
import { defineStore } from 'pinia'

import { electronMcpCallTool, electronMcpGetComputerUseChatTurn, electronMcpListTools } from '../../shared/eventa'
import { getActiveComputerUseTurn } from './computer-use-turn'

const LUMI_COMPUTER_USE_TOOL_NAMES = new Set([
  'desktop_observe_windows',
  'desktop_list_processes',
  'desktop_screenshot',
  'desktop_get_state',
  'desktop_focus_app',
  'desktop_open_app',
  'desktop_click_target',
  'desktop_click',
  'desktop_type_text',
  'desktop_press_keys',
  'desktop_scroll',
  'desktop_wait',
  'accessibility_snapshot',
  'accessibility_find_element',
])

function isLumiComputerUseTool(descriptor: { serverName: string, toolName: string }) {
  return descriptor.serverName !== 'computer_use' || LUMI_COMPUTER_USE_TOOL_NAMES.has(descriptor.toolName)
}

/**
 * Registers Electron-backed MCP tools into the shared LLM tools store.
 *
 * Use when:
 * - The Tamagotchi renderer needs live MCP tools during chat streaming
 *
 * Expects:
 * - Electron Eventa handlers for MCP listing and invocation are available
 *
 * Returns:
 * - Store actions for refreshing and disposing MCP runtime tools
 */
export const useTamagotchiMcpToolsStore = defineStore('tamagotchi-mcp-tools', () => {
  const llmToolsStore = useLlmToolsStore()
  const llmToolsetPromptsStore = useLlmToolsetPromptsStore()
  const mcpStore = useMcpStore()
  const listMcpTools = useElectronEventaInvoke(electronMcpListTools)
  const callMcpTool = useElectronEventaInvoke(electronMcpCallTool)
  const getComputerUseChatTurn = useElectronEventaInvoke(electronMcpGetComputerUseChatTurn)

  function registerMcpToolGuidance(tools: Awaited<ReturnType<typeof createMcpRuntimeTools>>) {
    const toolNames = tools.map(tool => tool.function.name)
    const hasBrowserTools = toolNames.some(name => /^mcp_.*browser_/.test(name))
    const hasMinecraftTools = toolNames.some(name => /^mcp_.*minecraft/i.test(name))
    const hasComputerUseTools = toolNames.some(name => /^mcp_computer_use_/i.test(name))
    const prompts = []

    if (hasBrowserTools) {
      prompts.push({
        id: 'mcp-browser-guidance',
        title: 'MCP Browser Guidance',
        content: [
          'Playwright MCP is snapshot-first. Use browser_snapshot/accessibility output as the evidence for page contents and element refs; screenshots are secondary.',
          'Before clicking, typing, selecting, hovering, dragging, or filling forms, call browser_snapshot first and use the exact element/ref from that snapshot. Never invent refs.',
          'Navigation, tab changes, clicks, typing, key presses, waits, form fills, dialogs, uploads, evaluate, resize, or back/forward only change browser state; they do not prove what is visible.',
          'After any browser state change, read the returned followUpSnapshot or call browser_snapshot again before making claims about page content.',
          'Do not repeat the same browser state-changing call with the same arguments to check whether it worked; use the followUpSnapshot/browser_snapshot evidence instead.',
          'For multi-step browser tasks, keep working until the user goal is completed, a required permission/confirmation is needed, or the snapshot/tool result shows a real blocker. Do not stop after only opening/searching/navigating.',
          'If a search engine blocks automation, try a direct site or another search path when useful. Do not say the whole network is blocked unless a tool result or snapshot explicitly shows that.',
          'Only report that you were blocked when the actual tool result or browser snapshot shows a block, captcha, permission error, timeout, or inaccessible page.',
          'Use information from successful snapshots/pages as evidence. Do not invent page contents from the URL or from the fact that the browser opened.',
        ].join('\n'),
      })
    }

    if (hasMinecraftTools) {
      prompts.push({
        id: 'mcp-minecraft-guidance',
        title: 'MCP Minecraft Guidance',
        content: [
          'Minecraft MCP represents a persistent external game world, not a one-shot information tool.',
          'Prefer high-level reflex tools for embodied actions: use follow-entity for moving targets, combat-engage or guard-area for fighting, flee-from-entity for danger, collect-blocks/collect-drops for gathering, eat-food/configure-auto-eat for survival, equip-best-armor/equip-best-tool-for-block for equipment, and cancel-action/get-action-status for control.',
          'Sustained Minecraft reflex tools such as follow-entity, combat-engage, flee-from-entity, and guard-area start background actions by default. After they report that a background action started, use get-action-status/observe-world for progress instead of repeating the same action.',
          'Minecraft tool-call completion is not the same as Minecraft-world success. Always inspect the tool text and structuredContent fields status/minecraftActionStatus, verified, needsDecision, blockedBy, and allowedNextActions before deciding the next step.',
          'Treat verified=false, status=failed, status=blocked, or status=waiting_for_decision as an unfinished game goal. Do not continue as if the block was placed, item was crafted, or target was reached.',
          'When digging, dig-block and equip-best-tool-for-block perform only simple equipment reflexes: they may equip an inventory pickaxe/axe/shovel automatically, but if the needed tool is missing they return missing_required_tool/waiting_for_decision. Plan the missing material collection and crafting yourself, then retry the original dig.',
          'For placement, use place-block as the general tool for any block. place-workbench is only a convenience wrapper for crafting_table, not a separate special rule. place-block may adjust a ground/support coordinate upward and may automatically clear ordinary low-value obstructions; if clearing needs a missing pickaxe, it returns missing_required_tool/waiting_for_decision.',
          'Safety detection is a realtime MCP reflex. If a hostile mob is visible nearby, the MCP server may interrupt the current physical action and immediately start a safety combat reflex without waiting for Lumi. While safety_combat_reflex_started is active, wait/poll get-action-status instead of issuing another physical command.',
          'When get-action-status reports safety_reflex_complete, safety_reflex_failed, safety_reflex_timeout, or safety_reflex_low_health, treat the reflex as finished and then decide whether to resume the interrupted goal, recover, flee, eat, craft equipment, or re-plan.',
          'If get-action-status reports bot_dead/dead_waiting_for_decision, the body died and the previous plan is no longer valid. Wait for respawn if needed, observe the new position/world, then decide whether to recover dropped items, abandon the old task, or create a safer plan.',
          'Before fighting, combat-engage and guard-area try to equip the best available melee weapon. If no weapon is available, treat that as a tactical blocker: flee, craft/equip a weapon, or explicitly choose emergency unarmed combat only when appropriate.',
          'Do not use fly-to as normal gameplay movement. Flight is cheat-gated by the MCP server and is blocked unless the user explicitly starts the server with cheat flight enabled.',
          'For placement/crafting, prefer place-block with blockName and craft-item. These tools verify world/inventory state. If a placement returns waiting_for_decision, the tool call has ended with a decision request; read the code/message/allowedNextActions and choose the next step instead of repeating blindly.',
          'Do not micromanage moving entities by repeatedly calling find-entity and move-to-position. Moving mobs, players, and dropped items should be handled by dynamic tracking/reflex tools inside the MCP server.',
          'Minecraft actions are serialized by the MCP server. If a tool says another action is busy, inspect get-action-status and only use cancel-action or replaceCurrent=true when interrupting the current action is intentional.',
          'Use observe-world, list-entities, get-server-status, and viewer tools for situational awareness before choosing the next high-level action.',
          'For Minecraft goals, continue with small, verifiable tool calls until the user goal is reached, a real blocker appears, or permission is needed.',
          'Preserve world continuity across calls. Do not assume inventory, position, or world state resets between tool invocations.',
          'This MCP does not replace AIRI built-in Minecraft integration; use it only as an additional MCP tool source when available.',
        ].join('\n'),
      })
    }

    if (hasComputerUseTools) {
      prompts.push({
        id: 'mcp-computer-use-guidance',
        title: 'MCP Computer Use Guidance',
        content: [
          'Computer Use controls the local desktop through short, observable actions. Before each meaningful desktop action, give the user one brief, factual intent sentence, then call the tool. Say what you are about to do, not hidden reasoning.',
          'Start with desktop_observe_windows once. If the requested app is listed, use desktop_focus_app directly. If it has no visible window, call desktop_list_processes with the app filter: focus it when a matching process exists, and use desktop_open_app only when no process exists or focusing the background process cannot restore a window. Never ask the user whether an app is running when these tools can verify it.',
          'For text in another Windows app, make one desktop_type_text call with targetApp and, when appropriate, pressEnter. It atomically focuses and verifies that app before input. Do not split this into a loose focus call followed by typing.',
          'A successful type/Enter result means the message was submitted to the verified target, but delivery is unverified until a fresh UI observation confirms a visible postcondition such as the composer clearing or an outgoing message appearing. Never treat missing visual confirmation alone as evidence that the message was not sent.',
          'Do not ask the user to click Allow, grant permission, or interact with a confirmation banner unless the MCP result explicitly reports status="approval_required". A completed click result was not blocked by approval; diagnose the target, coordinates, foreground window, or changed UI state instead.',
          'When the foreground surface is ToDesk, AnyDesk, Remote Desktop, or another remote-session client, do not focus a similarly named local window or use local accessibility data to target the remote pixels. The local window tree and remote screenshot can have different coordinates; use screen-only interaction for that surface and never claim remote delivery without visual confirmation.',
          'Use accessibility evidence only after the intended app is focused. Keep each tool call small, verify the resulting UI state before the next action, and do not repeat observation calls unless the UI changed or a tool result requires it.',
          'The ordinary chat tool-call UI shows the actual tool state. Do not claim an action succeeded until the corresponding tool result confirms it.',
        ].join('\n'),
      })
    }

    if (!prompts.length) {
      llmToolsetPromptsStore.clearToolsetPrompts('mcp')
      return
    }

    llmToolsetPromptsStore.registerToolsetPrompts('mcp', prompts)
  }

  async function refresh() {
    const tools = await llmToolsStore.registerTools('mcp', createMcpRuntimeTools({
      listTools: async () => (await listMcpTools()).filter(isLumiComputerUseTool),
      callTool: async (payload) => {
        if (!payload.name.startsWith('computer_use::'))
          return callMcpTool(payload)

        const turn = getActiveComputerUseTurn() ?? await getComputerUseChatTurn()
        return callMcpTool({
          ...payload,
          debug: {
            ...(payload.debug ?? {}),
            computerUseTurnId: turn?.turnId,
            computerUseSourceId: turn?.sourceId,
          },
        })
      },
    }))
    registerMcpToolGuidance(tools)
    mcpStore.connected = tools.length > 0
    return tools
  }

  function dispose() {
    llmToolsStore.clearTools('mcp')
    llmToolsetPromptsStore.clearToolsetPrompts('mcp')
    mcpStore.connected = false
  }

  return {
    dispose,
    refresh,
  }
})
