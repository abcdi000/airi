import type { AiriCard } from '../stores/modules/airi-card'

import { createDefaultLumiPersonaAnchor } from '../../../lumi-runtime/src'

const LUMI_AIRI_CARD_VERSION = '2.0.0'

/**
 * Creates the built-in Lumi card as a minimal identity record.
 *
 * Use when:
 * - Seeding or refreshing the built-in offline Lumi card.
 *
 * Expects:
 * - Planner, Replyer, tools, memory, and learning policies remain owned by the
 *   current Agent Runtime prompts.
 *
 * Returns:
 * - Basic identity fields plus empty legacy prompt fields required by the card
 *   storage contract.
 */
export function createLumiAiriCard(): Omit<AiriCard, 'extensions'> & { extensions?: Partial<AiriCard['extensions']> } {
  const anchor = createDefaultLumiPersonaAnchor()

  return {
    name: anchor.name,
    version: LUMI_AIRI_CARD_VERSION,
    description: anchor.identity,
    creator: 'Lumi',
    personality: anchor.coreTraits.join('\n'),
    scenario: '',
    greetings: [],
    greetingsGroupOnly: [],
    systemPrompt: '',
    postHistoryInstructions: '',
    messageExample: [],
    tags: ['lumi'],
    extensions: {
      airi: {
        modules: {} as AiriCard['extensions']['airi']['modules'],
        agents: {},
      },
    },
  }
}

export const LUMI_AIRI_CARD_ID = 'lumi'
