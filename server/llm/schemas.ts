import type { FunctionSchema } from './client.js'

export const NPC_RESPONSE_SCHEMA: FunctionSchema = {
  name: 'npc_response',
  description: 'Generate the NPC response to the visitor including dialogue, thoughts, and state changes',
  parameters: {
    type: 'object',
    required: ['dialogue', 'internal_thought', 'new_knowledge', 'wants_to_end_conversation'],
    properties: {
      dialogue: {
        type: 'string',
        description: 'What the NPC says and does. Mix *actions* with "speech". 1-5 sentences.',
      },
      internal_thought: {
        type: 'string',
        description: 'What the NPC thinks but does not say. 1 sentence.',
      },
      mood_change: {
        type: ['object', 'null'],
        description: 'How the NPC mood changed, or null if unchanged',
        properties: {
          current: { type: 'string', description: 'Current mood after this exchange' },
          toward_player_delta: { type: 'integer', minimum: -5, maximum: 5, description: 'Change in disposition toward visitor' },
          reason: { type: 'string', description: 'Why the mood changed' },
        },
        required: ['current', 'toward_player_delta', 'reason'],
      },
      new_knowledge: {
        type: 'array',
        minItems: 1,
        description: 'What the NPC learned from this exchange. MUST have at least 1 entry. 2-3 sentences with specifics.',
        items: {
          type: 'object',
          required: ['content', 'source', 'importance'],
          properties: {
            content: { type: 'string', description: 'Detailed description of what was learned' },
            source: { type: 'string', description: 'Who provided this information' },
            importance: { type: 'number', minimum: 0.1, maximum: 1.0, description: '0.2=trivial, 0.5=useful, 0.8=secret, 1.0=critical' },
          },
        },
      },
      state_changes: {
        type: ['array', 'null'],
        description: 'Physical/behavioral state changes. Format: "add:tag" or "remove:tag". Track clothing, posture, condition changes.',
        items: { type: 'string' },
      },
      new_agreement: {
        type: ['string', 'null'],
        description: 'What was agreed to, or null. Be specific about the commitment.',
      },
      action_after: {
        type: ['string', 'null'],
        description: 'What the NPC plans to do after this conversation, or null.',
      },
      wants_to_end_conversation: {
        type: 'boolean',
        description: 'Whether the NPC wants to leave the conversation',
      },
    },
  },
}

export const NPC_REACTION_SCHEMA: FunctionSchema = {
  name: 'npc_reaction',
  description: 'Generate NPC reaction to a player action or group activity',
  parameters: {
    type: 'object',
    required: ['reaction', 'internal_thought', 'new_knowledge'],
    properties: {
      reaction: {
        type: 'string',
        description: 'The NPC reaction with *actions* and "dialogue". 1-3 sentences.',
      },
      internal_thought: {
        type: 'string',
        description: 'Private thought. 1 sentence.',
      },
      mood_change: {
        type: ['object', 'null'],
        properties: {
          current: { type: 'string' },
          toward_player_delta: { type: 'integer', minimum: -5, maximum: 5 },
          reason: { type: 'string' },
        },
        required: ['current', 'toward_player_delta', 'reason'],
      },
      new_knowledge: {
        type: 'array',
        minItems: 1,
        items: {
          type: 'object',
          required: ['content', 'source', 'importance'],
          properties: {
            content: { type: 'string' },
            source: { type: 'string' },
            importance: { type: 'number', minimum: 0.1, maximum: 1.0 },
          },
        },
      },
      state_changes: { type: ['array', 'null'], items: { type: 'string' } },
      new_agreement: { type: ['string', 'null'] },
    },
  },
}

export const PLAN_SCHEMA: FunctionSchema = {
  name: 'create_plan',
  description: 'Create a multi-step plan for the NPC to pursue their goal',
  parameters: {
    type: 'object',
    required: ['goal', 'motivation', 'steps'],
    properties: {
      goal: { type: 'string', description: 'What the NPC is trying to achieve' },
      motivation: { type: 'string', description: 'Why, in 1 sentence' },
      steps: {
        type: 'array',
        minItems: 2,
        maxItems: 6,
        items: {
          type: 'object',
          required: ['action', 'target', 'description'],
          properties: {
            action: { type: 'string', description: 'Action type: travel, search, recruit, confront, charm, steal, etc.' },
            target: { type: 'string', description: 'Location ID, NPC name, or item' },
            description: { type: 'string', description: 'Concrete description of what to do' },
          },
        },
      },
    },
  },
}

export const REFLECTION_SCHEMA: FunctionSchema = {
  name: 'reflect',
  description: 'NPC self-assessment and decision-making',
  parameters: {
    type: 'object',
    required: ['reflection', 'should_replan', 'approach_player'],
    properties: {
      reflection: { type: 'string', description: '2-3 sentence self-assessment' },
      should_replan: { type: 'boolean', description: 'Whether to abandon current plan and form a new one' },
      approach_player: { type: 'boolean', description: 'Whether to approach the visitor to talk' },
      approach_reason: { type: ['string', 'null'], description: 'Why approach the visitor' },
      new_belief: { type: ['string', 'null'], description: 'A new conclusion or belief formed' },
    },
  },
}

export const GROUP_CONVERSATION_SCHEMA: FunctionSchema = {
  name: 'group_conversation',
  description: 'Generate multi-party NPC conversation with dialogue and per-participant takeaways',
  parameters: {
    type: 'object',
    required: ['dialogue', 'summary', 'concluded', 'takeaways'],
    properties: {
      dialogue: {
        type: 'array',
        items: {
          type: 'object',
          required: ['speaker', 'says'],
          properties: { speaker: { type: 'string' }, says: { type: 'string' } },
        },
      },
      summary: { type: 'string' },
      concluded: { type: 'boolean' },
      outcome: {
        type: ['object', 'null'],
        properties: {
          agreement_reached: { type: ['string', 'null'] },
          item_transferred: {
            type: ['object', 'null'],
            properties: { from: { type: 'string' }, to: { type: 'string' }, item: { type: 'string' } },
          },
          conflict: { type: ['string', 'null'] },
        },
      },
      takeaways: {
        type: 'object',
        additionalProperties: {
          type: 'object',
          required: ['knowledge', 'internal_reaction'],
          properties: {
            knowledge: { type: 'string' },
            mood_shift: { type: ['string', 'null'] },
            relationship_deltas: { type: 'object', additionalProperties: { type: 'number' } },
            internal_reaction: { type: 'string' },
          },
        },
      },
    },
  },
}
