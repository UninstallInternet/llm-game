import type { NPC, WorldState, ConversationTurn, KnowledgeEntry } from '../../shared/types.js'
import { NPC_DISPOSITION_THRESHOLDS } from '../../shared/constants.js'
import { getTopMemories } from '../game/state.js'

function dispositionLabel(value: number): string {
  if (value <= NPC_DISPOSITION_THRESHOLDS.hostile) return 'hostile'
  if (value <= NPC_DISPOSITION_THRESHOLDS.unfriendly) return 'unfriendly'
  if (value <= NPC_DISPOSITION_THRESHOLDS.neutral) return 'neutral'
  if (value <= NPC_DISPOSITION_THRESHOLDS.friendly) return 'friendly'
  return 'very trusting'
}

function formatRelationship(npc: NPC, targetName: string, rel: NPC['relationships'][0]): string {
  const feeling = rel.affection > 20 ? 'likes' : rel.affection < -20 ? 'dislikes' : 'neutral toward'
  const trust = rel.trust > 30 ? 'trusts' : rel.trust < -30 ? 'distrusts' : ''
  const fear = rel.fear > 40 ? ', fears' : ''
  const memories = rel.significantMemories.length > 0
    ? ` (${rel.significantMemories.slice(-2).join('; ')})`
    : ''
  return `- ${targetName} (${rel.type}): ${feeling}${trust ? ', ' + trust : ''}${fear}${memories}`
}

function formatKnowledge(entries: KnowledgeEntry[]): string {
  return entries
    .map((k) => `- ${k.content} (${k.source})`)
    .join('\n')
}

export function buildNpcSystemPrompt(npc: NPC, world: WorldState): string {
  const recentEvents = world.events
    .filter((e) => !e.resolved && e.triggerDay <= world.time.day)
    .slice(0, 3)
    .map((e) => `- ${e.title}: ${e.description}`)
    .join('\n')

  const topRelationships = npc.relationships
    .slice(0, 5)
    .map((r) => {
      const target = world.npcs.find((n) => n.id === r.targetNpcId)
      return target ? formatRelationship(npc, target.name, r) : null
    })
    .filter(Boolean)
    .join('\n')

  const topMemories = getTopMemories(npc, world.currentTick)
  const knowledgeStr = formatKnowledge(topMemories)

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
${topRelationships || '- None yet'}

THINGS YOU KNOW:
${knowledgeStr || '- Nothing notable'}

CURRENT MOOD: ${npc.mood.current}
FEELINGS TOWARD THIS STRANGER/VISITOR: ${dispositionLabel(npc.mood.toward_player)} (${npc.mood.toward_player}/100)
${npc.mood.reasons.length > 0 ? `Because: ${npc.mood.reasons.slice(-3).join('; ')}` : ''}

${recentEvents ? `RECENT EVENTS IN TOWN:\n${recentEvents}` : ''}

RULES:
- Stay in character. Never break the fourth wall or mention being an AI.
- Respond in 1-5 sentences. Mix DIALOGUE and ACTIONS naturally.
- Actions are written in italics style: *leans against the wall* "Yeah, I heard something." *glances nervously at the door*
- Show body language, gestures, facial expressions — not just words. What you DO reveals as much as what you SAY.
- If you're busy with something (working, searching, eating), incorporate it into your response.
- Match your speech style consistently.
- If asked about things you don't know, say so believably.
- If topics touch your secrets, deflect — show it physically (fidgeting, avoiding eye contact, changing posture) not just verbally.
- If your disposition toward the visitor is high (>60), you may hint at private matters.
- If asked about other NPCs, share what you know colored by your relationship with them.
- If you have an active plan, your responses should subtly reflect that you have somewhere to be or something on your mind.

Respond with ONLY a JSON object (no markdown, no code fences):
{
  "dialogue": "Mix speech and *actions*. Example: *sets down wrench* \"Section C?\" *studies your face* \"I wouldn't go there.\"",
  "internal_thought": "What you think but don't say (1 sentence)",
  "mood_change": { "current": "your mood now", "toward_player_delta": -5 to 5, "reason": "why" } or null,
  "new_knowledge": [{ "content": "SUMMARIZE what you learned from this exchange — what the visitor said, asked about, or revealed. Always include at least one entry.", "source": "player told me" }],
  "wants_to_end_conversation": false,
  "action_after": null or "what you plan to do after this conversation"
}

CRITICAL: new_knowledge must ALWAYS have at least one entry summarizing what the visitor said or asked about. This is how you remember the conversation later. Even if they said something mundane, note it: "The visitor asked about the weather" or "They introduced themselves as [name]" or "They were asking about [topic]". Never return null for new_knowledge.`
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

  const recentHistory = history.slice(-12)
  for (const turn of recentHistory) {
    if (turn.role === 'player') {
      messages.push({ role: 'user', content: turn.content })
    } else {
      messages.push({ role: 'assistant', content: turn.content })
    }
  }

  messages.push({ role: 'user', content: playerMessage })

  return messages
}

// ─── NPC-to-NPC Conversation Prompt ───

export function buildNpcConversationPrompt(
  npc1: NPC,
  npc2: NPC,
  world: WorldState
): { system: string; user: string } {
  const location = world.locations.find((l) => l.id === npc1.currentLocationId)
  const rel1to2 = npc1.relationships.find((r) => r.targetNpcId === npc2.id)
  const rel2to1 = npc2.relationships.find((r) => r.targetNpcId === npc1.id)

  const k1 = getTopMemories(npc1, world.currentTick)
    .filter((k) => !k.isSecret)
    .slice(0, 5)
    .map((k) => k.content)
    .join('; ')

  const k2 = getTopMemories(npc2, world.currentTick)
    .filter((k) => !k.isSecret)
    .slice(0, 5)
    .map((k) => k.content)
    .join('; ')

  const relevantEvents = world.events
    .filter((e) => !e.resolved && e.triggerDay <= world.time.day)
    .filter(
      (e) => e.involvedNpcIds.includes(npc1.id) || e.involvedNpcIds.includes(npc2.id)
    )
    .map((e) => e.title)
    .join(', ')

  const system = `You simulate NPC-to-NPC interactions in a text adventure. Generate a brief, natural exchange. Both act according to personality, goals, and knowledge. They may talk, argue, scheme, help each other, physically confront, trade items, or take actions — whatever makes sense.

RULES:
- 2-4 turns total. Mix DIALOGUE and ACTIONS naturally.
- Actions in italics style: *slams fist on table* "I told you not to go there." *lowers voice*
- Characters don't just talk — they DO things. A mechanic might be repairing something mid-conversation. A guard might block a doorway. Someone might hand over an item, or shove someone.
- Characters never reveal secret goals directly, but those goals color behavior.
- If one knows something the other doesn't, they may share it (or strategically withhold it).
- Secret knowledge stays secret unless trust is very high.
- The summary should describe what HAPPENED, not just what was said.
- Respond ONLY with JSON (no markdown, no fences).`

  const formatRel = (rel: typeof rel1to2, otherName: string) => {
    if (!rel) return `Has no established relationship with ${otherName}.`
    const feel = rel.affection > 20 ? 'likes' : rel.affection < -20 ? 'dislikes' : 'neutral toward'
    const trust = rel.trust > 30 ? ', trusts' : rel.trust < -30 ? ', distrusts' : ''
    return `Feels about ${otherName}: ${rel.type}, ${feel}${trust}. ${rel.significantMemories.slice(-1).join('')}`
  }

  // Others present at the location
  const othersPresent = world.npcs
    .filter((n) => n.id !== npc1.id && n.id !== npc2.id && n.currentLocationId === npc1.currentLocationId)
    .map((n) => n.name)
    .join(', ')

  // Active plans (briefly, to color conversation)
  const plan1 = npc1.activePlan?.status === 'active' ? `Currently working on: ${npc1.activePlan.goal}` : ''
  const plan2 = npc2.activePlan?.status === 'active' ? `Currently working on: ${npc2.activePlan.goal}` : ''

  const user = `Location: ${location?.name ?? 'unknown'} — ${location?.description?.slice(0, 80) ?? ''} (${world.time.timeOfDay}, Day ${world.time.day})
${othersPresent ? `Others nearby who might overhear: ${othersPresent}` : 'They are alone.'}
${relevantEvents ? `Current events: ${relevantEvents}` : ''}

NPC_1: ${npc1.name}, ${npc1.occupation}, mood: ${npc1.mood.current}, hp: ${npc1.physical.health}/100
Personality: ${npc1.personality.traits.join(', ')}. ${npc1.personality.speechStyle}.
Goal: ${npc1.goals.public} (secret: ${npc1.goals.secret})
Inventory: ${npc1.inventory.map((i) => i.name).join(', ') || 'nothing'}
${plan1}
Knows: ${k1 || 'nothing notable'}
${formatRel(rel1to2, npc2.name)}

NPC_2: ${npc2.name}, ${npc2.occupation}, mood: ${npc2.mood.current}, hp: ${npc2.physical.health}/100
Personality: ${npc2.personality.traits.join(', ')}. ${npc2.personality.speechStyle}.
Goal: ${npc2.goals.public} (secret: ${npc2.goals.secret})
Inventory: ${npc2.inventory.map((i) => i.name).join(', ') || 'nothing'}
${plan2}
Knows: ${k2 || 'nothing notable'}
${formatRel(rel2to1, npc1.name)}

Generate their conversation. JSON format:
{
  "summary": "1-2 sentence description of what happened (player-visible)",
  "npc1_takeaway": {
    "knowledge": "what ${npc1.name} learned or reinforced (1 sentence)",
    "mood_shift": "new mood" or null,
    "relationship_delta": -10 to 10,
    "internal_reaction": "private thought (1 sentence)"
  },
  "npc2_takeaway": {
    "knowledge": "what ${npc2.name} learned or reinforced (1 sentence)",
    "mood_shift": "new mood" or null,
    "relationship_delta": -10 to 10,
    "internal_reaction": "private thought (1 sentence)"
  }
}`

  return { system, user }
}

// ─── World Generation Prompt ───

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
- Each relationship must have: targetNpcId, type, trust (-100 to 100), affection (-100 to 100), respect (-100 to 100), fear (0 to 100), significantMemories (array of strings)

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
      "ownerId": null or "npc_X",
      "tags": ["indoor", "workshop"],
      "securityLevel": 0,
      "containers": [{"name": "tool chest", "expectedItemTypes": ["tools", "parts"], "searchDifficulty": 1}],
      "fixtures": ["workbench", "anvil"]
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
        { "targetNpcId": "npc_2", "type": "friend", "trust": 60, "affection": 50, "respect": 40, "fear": 0, "significantMemories": ["grew up together"] }
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
