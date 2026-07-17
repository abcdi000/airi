/**
 * Minimal AIRI external plugin.
 *
 * Import this folder from:
 * Settings -> Plugins -> Add Plugin
 */

export async function init() {
  console.info('[minimal-tool-plugin] initialized')
}

export async function setupModules({ apis }) {
  if (!apis.tools?.register) {
    console.warn('[minimal-tool-plugin] tool API is not available in this host')
    return
  }

  await apis.tools.register({
    tool: {
      id: 'minimal_echo',
      title: 'Minimal Echo',
      description: 'Echoes a short text value back to the conversation.',
      activation: {
        keywords: ['echo', 'repeat'],
        patterns: []
      },
      parameters: {
        type: 'object',
        properties: {
          text: {
            type: 'string',
            description: 'Text to echo.'
          }
        },
        required: ['text'],
        additionalProperties: false
      }
    },
    execute: async (input) => {
      return {
        text: String(input?.text ?? '')
      }
    }
  })

  await apis.tools.registerToolsetPrompt?.({
    id: 'minimal-tool-plugin-guidance',
    prompt: {
      id: 'minimal-tool-plugin-guidance',
      title: 'Minimal Tool Plugin',
      content: 'Use `minimal_echo` only when the user explicitly asks AIRI to echo or repeat text.'
    }
  })
}
