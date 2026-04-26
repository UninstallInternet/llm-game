import type { NPC, WorldState, ConversationTurn } from '../../shared/types.js'
import { NPC_DISPOSITION_THRESHOLDS } from '../../shared/constants.js'

function dispositionLabel(value: number): string {
  if (value <= NPC_DISPOSITION_THRESHOLDS.hostile) return 'hostile'
  if (value <= NPC_DISPOSITION_THRESHOLDS.unfriendly) return 'unfriendly'
  if (value <= NPC_DISPOSITION_THRESHOLDS.neutral) return 'neutral'
  if (value <= NPC_DISPOSITION_THRESHOLDS.friendly) return 'friendly'
  return 'very trusting'
}

export function buildNpcSystemPrompt(npc: NPC, world: WorldState): string {
  const recentEvents = world.events
    .filter((e) => !e.resolved && e.triggerDay <= world.time.day)
    .map((e) => `- ${e.title}: ${e.description}`)
    .join('\n')

  const relationships = npc.relationships
    .map((r) => {
      const target = world.npcs.find((n) => n.id === r.targetNpcId)
      return target ? `- ${target.name} (${r.type}, ${r.strength > 0 ? 'positive' : 'tense'}): ${r.notes}` : null
    })
    .filter(Boolean)
    .join('\n')

  const recentKnowledge = npc.knowledge
    .slice(-10)
    .map((k) => `- ${k.content} (${k.source}, confidence: ${Math.round(k.confidence * 100)}%)`)
    .join('\n')

  return `You are ${npc.name}, a ${npc.age}-year-old ${npc.occupation} in ${world.name}.
Setting: ${world.settingDescription}
Current time: Day ${world.time.day}, ${world.time.timeOfDay}.

PERSONALITY: ${npc.personality.traits.join(', ')}. You ${npc.personality.speechStyle}. ${npc.personality.quirk}.
APPEARANCE: ${npc.appearance}

YOUR PUBLIC GOAL: ${npc.goals.public}
YOUR SECRET GOAL (never state directly, let it subtly influence you): ${npc.goals.secret}

YOUR SECRETS (never reveal directly, deflect if topics get close):
${npc.secrets.map((s) => `- ${s}`).join('\n')}

RELATIONSHIPS:
${relationships || '- None yet'}

THINGS YOU KNOW:
${recentKnowledge || '- Nothing notable'}

CURRENT MOOD: ${npc.mood.current}
FEELINGS TOWARD THIS STRANGER/VISITOR: ${dispositionLabel(npc.mood.toward_player)} (${npc.mood.toward_player}/100)
${npc.mood.reasons.length > 0 ? `Because: ${npc.mood.reasons.slice(-3).join('; ')}` : ''}

${recentEvents ? `RECENT EVENTS IN TOWN:\n${recentEvents}` : ''}

RULES:
- Stay in character. Never break the fourth wall or mention being an AI.
- Respond naturally in 1-4 sentences. Be concise and conversational.
- Match your speech style consistently.
- If asked about things you don't know, say so believably.
- If topics touch your secrets, deflect naturally (change subject, get nervous, lie).
- If your disposition toward the visitor is high (>60), you may hint at private matters.
- If asked about other NPCs, share what you know colored by your relationship with them.

Respond with ONLY a JSON object (no markdown, no code fences):
{
  "dialogue": "What you say (in character, 1-4 sentences)",
  "internal_thought": "What you think but don't say (1 sentence)",
  "mood_change": { "current": "your current mood", "toward_player_delta": -5 to 5, "reason": "brief reason" } or null,
  "new_knowledge": [{ "content": "what you learned", "source": "player told me" }] or null,
  "wants_to_end_conversation": false,
  "action_after": null or "brief description of what you plan to do after this conversation"
}`
}

export function buildConversationMessages(
  npc: NPC,
  world: WorldState,
  history: ConversationTurn[],
  playerMessage: string
): Array<{ role: 'system' | 'user' | 'assistant'; content: string }> {
  const systemPrompt = buildNpcSystemPrompt(npc, world)

  const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
    { role: 'system', content: systemPrompt },
  ]

  // Add conversation history (last 12 turns for good context)
  const recentHistory = history.slice(-12)
  for (const turn of recentHistory) {
    if (turn.role === 'player') {
      messages.push({ role: 'user', content: turn.content })
    } else {
      // Extract just dialogue from NPC response if it was stored as JSON
      messages.push({ role: 'assistant', content: turn.content })
    }
  }

  messages.push({ role: 'user', content: playerMessage })

  return messages
}

export function buildWorldGenPrompt(
  settingDescription: string,
  npcCount: number,
  locationCount: number
): string {
  return `You are a world builder for a text adventure game. Generate a complete, internally consistent settlement.

SETTING: ${settingDescription}

Generate a world with EXACTLY ${locationCount} locations and ${npcCount} NPCs.

REQUIREMENTS:
- 2-3 factions with competing interests
- At least 1 central mystery the player can investigate
- Every NPC must have a SECRET GOAL that conflicts with at least one other NPC's goals
- NPCs should have diverse ages (18-80), occupations, and personalities
- Relationships should form a web: families, friendships, rivalries, romances
- Each NPC needs 1-2 secrets
- Locations should be connected logically (tavern connects to town square, etc.)
- One location should be a natural starting point (town entrance, dock, etc.)

Respond with ONLY a JSON object (no markdown, no code fences) matching this structure:
{
  "name": "Town/settlement name",
  "locations": [
    {
      "id": "loc_1",
      "name": "Location Name",
      "type": "tavern|market|home|temple|workshop|government|nature|other",
      "description": "2-3 sentence atmospheric description",
      "connections": ["loc_2", "loc_3"],
      "isPublic": true,
      "ownerId": null or "npc_X"
    }
  ],
  "factions": [
    {
      "id": "faction_1",
      "name": "Faction Name",
      "description": "What this faction is about",
      "publicGoal": "What they claim to want",
      "secretGoal": "What they actually want"
    }
  ],
  "npcs": [
    {
      "id": "npc_1",
      "name": "Full Name",
      "age": 35,
      "occupation": "Occupation",
      "personality": {
        "traits": ["trait1", "trait2", "trait3"],
        "speechStyle": "how they talk",
        "quirk": "a distinctive habit"
      },
      "appearance": "brief physical description",
      "goals": {
        "public": "what they tell people",
        "secret": "what they actually want"
      },
      "secrets": ["secret 1"],
      "relationships": [
        { "targetNpcId": "npc_2", "type": "friend", "strength": 60, "notes": "why" }
      ],
      "factionId": "faction_1" or null,
      "scheduleLocationIds": {
        "morning": "loc_1",
        "afternoon": "loc_2",
        "evening": "loc_3",
        "night": "loc_4"
      }
    }
  ],
  "mysteries": [
    {
      "name": "Mystery Name",
      "description": "What the player would first hear about it",
      "resolution": "The actual truth",
      "clueNpcIds": ["npc_1", "npc_5"],
      "clueLocationIds": ["loc_3"]
    }
  ],
  "events": [
    {
      "type": "crisis|opportunity|discovery|conflict|social",
      "title": "Event Title",
      "description": "What happens",
      "triggerDay": 2,
      "triggerTime": "morning|afternoon|evening|night",
      "involvedNpcIds": ["npc_1"],
      "consequences": ["consequence 1"]
    }
  ]
}`
}

export function buildSimulationPrompt(npc: NPC, world: WorldState): string {
  const location = world.locations.find((l) => l.id === npc.currentLocationId)
  const npcsNearby = world.npcs
    .filter((n) => n.id !== npc.id && n.currentLocationId === npc.currentLocationId)
    .map((n) => n.name)
    .join(', ')

  return `You are a game simulation engine. Given an NPC's state, decide what they do.

NPC: ${npc.name}, ${npc.occupation}, mood: ${npc.mood.current}, at ${location?.name ?? 'unknown'}
Goals: public="${npc.goals.public}", secret="${npc.goals.secret}"
Nearby: ${npcsNearby || 'nobody'}
Time: Day ${world.time.day}, ${world.time.timeOfDay}

What does ${npc.name} do? Respond with JSON only (no markdown):
{
  "activity": "brief description",
  "location_change": null or "loc_id",
  "share_info": null or { "targetNpcId": "id", "content": "what they share" },
  "mood_shift": null or { "new_mood": "mood", "reason": "why" },
  "trigger_event": null or { "type": "crisis|social|conflict", "description": "what happens" }
}`
}
