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
  const memories = rel.significantMemories?.length > 0
    ? ` (${rel.significantMemories.slice(-4).join('; ')})`
    : ''
  return `- ${targetName} (${rel.type}): ${feeling}${trust ? ', ' + trust : ''}${fear}${memories}`
}

function formatKnowledge(entries: KnowledgeEntry[]): string {
  return entries
    .map((k) => `- ${k.content} (${k.source})`)
    .join('\n')
}

export function buildNpcSystemPrompt(npc: NPC, world: WorldState, playerMessage?: string): string {
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

  const topMemories = getTopMemories(npc, world.currentTick, playerMessage)
  const knowledgeStr = formatKnowledge(topMemories)

  // Active plan context
  const planStr = npc.activePlan?.status === 'active'
    ? `YOUR CURRENT PLAN: ${npc.activePlan.goal}
  Currently doing: ${npc.activePlan.steps.find((s) => s.status === 'active')?.description ?? 'waiting'}`
    : ''

  // State flags
  const stateStr = (npc.stateFlags?.length ?? 0) > 0
    ? `YOUR CURRENT STATE: ${npc.stateFlags.join(', ')}`
    : ''

  // Agreements
  const activeAgreements = (npc.agreements ?? []).filter((a) => a.active)
  const agreementStr = activeAgreements.length > 0
    ? `AGREEMENTS YOU'VE MADE (honor these unless you have strong reason not to):
${activeAgreements.map((a) => `- With ${a.withId === 'player' ? 'the visitor' : world.npcs.find((n) => n.id === a.withId)?.name ?? a.withId}: ${a.content}`).join('\n')}`
    : ''

  // ═══ SECTION 1: IDENTITY (start — high LLM attention) ═══
  // ═══ SECTION 2: SITUATION (what's happening now) ═══
  // ═══ SECTION 3: CONTEXT (reference — middle, lower attention) ═══
  // ═══ SECTION 4: COMMITMENTS (end — high attention) ═══
  // ═══ SECTION 5: RULES (very end — highest attention) ═══

  return `=== WHO YOU ARE ===
You are ${npc.name}, a ${npc.age}-year-old ${npc.occupation} in ${world.name}.
Personality: ${npc.personality.traits.join(', ')}. You ${npc.personality.speechStyle}. ${npc.personality.quirk}.
Appearance: ${npc.appearance}

=== YOUR SITUATION ===
Location: ${world.locations.find((l) => l.id === npc.currentLocationId)?.name ?? 'unknown'}
Time: Day ${world.time.day}, ${String(world.time.hour ?? 8).padStart(2, '0')}:${String(world.time.minute ?? 0).padStart(2, '0')} (${world.time.timeOfDay})
Mood: ${npc.mood.current} | Toward visitor: ${dispositionLabel(npc.mood.toward_player)} (${npc.mood.toward_player}/100)
${npc.mood.reasons.length > 0 ? `Why: ${npc.mood.reasons.slice(-5).join('; ')}` : ''}
${stateStr}
${planStr}
${recentEvents ? `Recent events: ${recentEvents}` : ''}

=== YOUR GOALS ===
Public: ${npc.goals.public}
Secret (never state directly): ${npc.goals.secret}
Secrets to protect: ${npc.secrets.join('; ')}

=== CONTEXT (what you know) ===
Relationships:
${topRelationships || '- None yet'}

Memories:
${knowledgeStr || '- Nothing notable'}

=== COMMITMENTS (you MUST honor these) ===
${agreementStr || 'None'}

=== RULES ===
- You are talking to THE VISITOR. NOT to ${(() => {
  const npcsHere = world.npcs.filter((n) => n.id !== npc.id && n.currentLocationId === npc.currentLocationId)
  return npcsHere.map((n) => n.name).join(', ') || 'anyone else'
})()}. Address the visitor directly.
- Stay in character. Mix *actions* with "dialogue".
- Honor your agreements. Maintain your state (${(npc.stateFlags ?? []).join(', ') || 'normal'}).
- If topics touch secrets, deflect physically.
- If disposition > 60, you may be more open.
- VOICE: You are ${npc.name}. ${npc.personality.speechStyle}. ${npc.personality.traits.join(', ')}. Never break character.`
}

export function buildConversationMessages(
  npc: NPC,
  world: WorldState,
  history: ConversationTurn[],
  playerMessage: string
): Array<{ role: 'system' | 'user' | 'assistant'; content: string }> {
  // Pass player message to system prompt so memory retrieval is contextual
  const systemPrompt = buildNpcSystemPrompt(npc, world, playerMessage)

  const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
    { role: 'system', content: systemPrompt },
  ]

  // Group history by sessions (detect gaps of 3+ ticks between messages)
  const MAX_RECENT = 8
  const recentHistory = history.slice(-MAX_RECENT)

  // Add session boundary markers and summarize older turns
  if (history.length > MAX_RECENT) {
    const olderTurns = history.slice(0, -MAX_RECENT)
    const summaryParts: string[] = []
    for (const t of olderTurns) {
      const speaker = t.role === 'player' ? 'Visitor' : npc.name
      summaryParts.push(`${speaker}: ${t.content.slice(0, 120)}`)
    }
    messages.push({
      role: 'user',
      content: `[Summary of earlier conversations with the visitor (NOT with other NPCs):\n${summaryParts.slice(-6).join('\n')}\n...New conversation:]`,
    })
    messages.push({
      role: 'assistant',
      content: `*nods, recalling our earlier conversation* (I remember what we discussed.)`,
    })
  }

  let lastTick = -999
  for (const turn of recentHistory) {
    // Insert session break if there's a significant time gap
    if (turn.tick - lastTick > 3 && lastTick > 0) {
      messages.push({
        role: 'user',
        content: `[Some time has passed. The visitor has returned for a new conversation.]`,
      })
      messages.push({
        role: 'assistant',
        content: `*looks up* (The visitor is back. This is a new conversation, not a continuation.)`,
      })
    }
    lastTick = turn.tick

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

  // Check if they've talked before and what about
  const priorConvoKnowledge1 = npc1.knowledge
    .filter((k) => k.source.includes(npc2.name) || k.source.includes(npc2.name.split(' ')[0]))
    .slice(-3)
    .map((k) => k.content)
    .join('; ')
  const priorConvoKnowledge2 = npc2.knowledge
    .filter((k) => k.source.includes(npc1.name) || k.source.includes(npc1.name.split(' ')[0]))
    .slice(-3)
    .map((k) => k.content)
    .join('; ')

  const priorContext = (priorConvoKnowledge1 || priorConvoKnowledge2)
    ? `\nPRIOR CONVERSATIONS (DO NOT repeat these topics — advance the story):\n${priorConvoKnowledge1 ? `${npc1.name} remembers: ${priorConvoKnowledge1}` : ''}${priorConvoKnowledge2 ? `\n${npc2.name} remembers: ${priorConvoKnowledge2}` : ''}`
    : ''

  const system = `You simulate NPC-to-NPC interactions in a text adventure. Generate a natural exchange. Both act according to personality, goals, and knowledge.

RULES:
- 3-5 turns total. Mix DIALOGUE and ACTIONS naturally.
- Actions in italics: *slams fist on table* "I told you not to go there."
- Characters DO things — hand over items, shove, block, repair, search.
- If they have COMMITMENTS, they MUST bring them up and try to fulfill them.
- If they've talked before about a topic, DON'T repeat it — advance to the next step or make a specific request.
- Characters never reveal secret goals directly, but those goals color behavior.
- Secret knowledge stays secret unless trust is very high.
- The summary should describe what HAPPENED and what CHANGED.
- Set concluded=false UNLESS both parties have clearly reached an agreement or impasse. Don't rush to conclude — real negotiations take multiple rounds. Default to false.
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

  // Active plans — CRITICAL: if one NPC's plan targets the other, this is WHY they're talking
  const plan1 = npc1.activePlan?.status === 'active' ? `Currently working on: ${npc1.activePlan.goal}. Motivation: ${npc1.activePlan.motivation}` : ''
  const plan2 = npc2.activePlan?.status === 'active' ? `Currently working on: ${npc2.activePlan.goal}. Motivation: ${npc2.activePlan.motivation}` : ''

  // Check if one NPC's plan specifically targets the other — make it explicit
  const npc1TargetsNpc2 = npc1.activePlan?.steps.some((s) =>
    s.status === 'active' && (s.target.toLowerCase().includes(npc2.name.toLowerCase()) || s.description.toLowerCase().includes(npc2.name.toLowerCase()))
  )
  const npc2TargetsNpc1 = npc2.activePlan?.steps.some((s) =>
    s.status === 'active' && (s.target.toLowerCase().includes(npc1.name.toLowerCase()) || s.description.toLowerCase().includes(npc1.name.toLowerCase()))
  )
  const planContext = npc1TargetsNpc2
    ? `\nIMPORTANT: ${npc1.name} specifically came to talk to ${npc2.name} about: ${npc1.activePlan!.goal}. This conversation should address that goal directly.`
    : npc2TargetsNpc1
      ? `\nIMPORTANT: ${npc2.name} specifically came to talk to ${npc1.name} about: ${npc2.activePlan!.goal}. This conversation should address that goal directly.`
      : ''

  const user = `Location: ${location?.name ?? 'unknown'} — ${location?.description?.slice(0, 80) ?? ''} (${world.time.timeOfDay}, Day ${world.time.day})
${othersPresent ? `Others nearby who might overhear: ${othersPresent}` : 'They are alone.'}
${relevantEvents ? `Current events: ${relevantEvents}` : ''}${planContext}${priorContext}

NPC_1: ${npc1.name}, ${npc1.occupation}, mood: ${npc1.mood.current}, hp: ${npc1.physical.health}/100
Appearance: ${npc1.appearance}${(npc1.stateFlags?.length ?? 0) > 0 ? ` [Currently: ${npc1.stateFlags.join(', ')}]` : ''}
Personality: ${npc1.personality.traits.join(', ')}. ${npc1.personality.speechStyle}.
Goal: ${npc1.goals.public} (secret: ${npc1.goals.secret})
Inventory: ${npc1.inventory.map((i) => i.name).join(', ') || 'nothing'}
${plan1}
${(() => {
  const agr = (npc1.agreements ?? []).filter((a) => a.active).map((a) => {
    const other = a.withId === 'player' ? 'the visitor' : world.npcs.find((n) => n.id === a.withId)?.name ?? a.withId
    return `- With ${other}: ${a.content}`
  }).join('\n')
  return agr ? `COMMITMENTS ${npc1.name} MUST act on:\n${agr}` : ''
})()}
Knows: ${k1 || 'nothing notable'}
${formatRel(rel1to2, npc2.name)}

NPC_2: ${npc2.name}, ${npc2.occupation}, mood: ${npc2.mood.current}, hp: ${npc2.physical.health}/100
Appearance: ${npc2.appearance}${(npc2.stateFlags?.length ?? 0) > 0 ? ` [Currently: ${npc2.stateFlags.join(', ')}]` : ''}
Personality: ${npc2.personality.traits.join(', ')}. ${npc2.personality.speechStyle}.
Goal: ${npc2.goals.public} (secret: ${npc2.goals.secret})
Inventory: ${npc2.inventory.map((i) => i.name).join(', ') || 'nothing'}
${plan2}
${(() => {
  const agr = (npc2.agreements ?? []).filter((a) => a.active).map((a) => {
    const other = a.withId === 'player' ? 'the visitor' : world.npcs.find((n) => n.id === a.withId)?.name ?? a.withId
    return `- With ${other}: ${a.content}`
  }).join('\n')
  return agr ? `COMMITMENTS ${npc2.name} MUST act on:\n${agr}` : ''
})()}
Knows: ${k2 || 'nothing notable'}
${formatRel(rel2to1, npc1.name)}

Generate their ACTUAL conversation — real dialogue with real outcomes. JSON format:
{
  "dialogue": [
    { "speaker": "${npc1.name}", "says": "*action* \"speech\" — what they actually say and do" },
    { "speaker": "${npc2.name}", "says": "*action* \"speech\" — their response" },
    { "speaker": "${npc1.name}", "says": "follow-up" },
    { "speaker": "${npc2.name}", "says": "conclusion" }
  ],
  "summary": "2-3 sentence description of what happened AND what was decided/agreed/refused",
  "concluded": true or false,
  "outcome": {
    "agreement_reached": "what they agreed to do together" or null,
    "item_transferred": { "from": "npc name", "to": "npc name", "item": "item name" } or null,
    "conflict": "description of conflict or confrontation" or null
  },
  "npc1_takeaway": {
    "knowledge": "Detailed: what ${npc1.name} learned, what was discussed, what was decided. 2-3 sentences with specifics.",
    "mood_shift": "new mood" or null,
    "relationship_delta": -10 to 10,
    "internal_reaction": "private thought about this encounter (1-2 sentences)"
  },
  "npc2_takeaway": {
    "knowledge": "Detailed: what ${npc2.name} learned, what was discussed, what was decided. 2-3 sentences with specifics.",
    "mood_shift": "new mood" or null,
    "relationship_delta": -10 to 10,
    "internal_reaction": "private thought about this encounter (1-2 sentences)"
  }
}

IMPORTANT:
- Generate 3-5 lines of REAL dialogue per round. Make offers, ask questions, react, agree or disagree.
- Set "concluded": true if the conversation has reached a natural end (agreement reached, topic exhausted, someone wants to leave). Set false if more discussion is needed.
- Conversations can span multiple rounds. Don't rush to a conclusion — persuasion, negotiation, and building trust take time.
- If this is a continuation (prior dialogue provided), build on what was said — don't repeat or restart.`

  return { system, user }
}

// ─── N-Party Group Conversation Prompt ───

export function buildGroupConversationPrompt(
  participants: NPC[],
  world: WorldState,
  playerJoined = false
): { system: string; user: string } {
  const location = world.locations.find((l) => l.id === participants[0]?.currentLocationId)
  const names = participants.map((p) => p.name).join(', ')

  const system = `You simulate a group interaction between ${participants.length} characters in a text adventure. Generate natural multi-party dialogue.

RULES:
- Generate 4-8 lines of dialogue total. Not everyone needs to speak every line.
- Mix *actions* with "dialogue". Characters DO things — hand items, gesture, react physically.
- Characters who are addressed should respond. Characters with strong opinions speak up.
- If any character has COMMITMENTS, they MUST bring them up.
- If characters have talked before about a topic, advance it — don't repeat.
- Set concluded=false unless a clear agreement or impasse is reached. Default to false.
${playerJoined ? '- The visitor (player) has joined. NPCs should react naturally — some may welcome them, others may be cautious.' : ''}
- Respond ONLY with JSON (no markdown).`

  const participantBlocks = participants.map((npc, idx) => {
    const rels = participants
      .filter((p) => p.id !== npc.id)
      .map((p) => {
        const rel = npc.relationships.find((r) => r.targetNpcId === p.id)
        if (!rel) return `  ${p.name}: no established relationship`
        const feel = rel.affection > 20 ? 'likes' : rel.affection < -20 ? 'dislikes' : 'neutral'
        const trust = rel.trust > 30 ? ', trusts' : rel.trust < -30 ? ', distrusts' : ''
        return `  ${p.name}: ${rel.type}, ${feel}${trust}`
      }).join('\n')

    const k = getTopMemories(npc, world.currentTick, names)
      .filter((k) => !k.isSecret).slice(0, 5).map((k) => k.content).join('; ')

    const plan = npc.activePlan?.status === 'active'
      ? `Plan: ${npc.activePlan.goal}. Motivation: ${npc.activePlan.motivation}`
      : ''

    const agreements = (npc.agreements ?? []).filter((a) => a.active).map((a) => {
      const other = a.withId === 'player' ? 'the visitor' : world.npcs.find((n) => n.id === a.withId)?.name ?? a.withId
      return `- With ${other}: ${a.content}`
    }).join('\n')

    return `PARTICIPANT ${idx + 1}: ${npc.name}, ${npc.occupation}, mood: ${npc.mood.current}
Personality: ${npc.personality.traits.join(', ')}. ${npc.personality.speechStyle}.
${npc.appearance}${(npc.stateFlags?.length ?? 0) > 0 ? ` [Currently: ${npc.stateFlags.join(', ')}]` : ''}
Goal: ${npc.goals.public} (secret: ${npc.goals.secret})
Inventory: ${(npc.inventory ?? []).map((i) => i.name).join(', ') || 'nothing'}
${plan}
${agreements ? `COMMITMENTS (MUST act on):\n${agreements}` : ''}
Knows: ${k || 'nothing notable'}
Relationships:
${rels}`
  }).join('\n\n')

  // Group dynamics
  const alliances: string[] = []
  const tensions: string[] = []
  for (let i = 0; i < participants.length; i++) {
    for (let j = i + 1; j < participants.length; j++) {
      const rel = participants[i].relationships.find((r) => r.targetNpcId === participants[j].id)
      if (rel) {
        if (rel.trust > 40 && rel.affection > 20) alliances.push(`${participants[i].name} + ${participants[j].name}`)
        if (rel.trust < -20 || rel.type === 'rival' || rel.type === 'enemy') tensions.push(`${participants[i].name} vs ${participants[j].name}`)
      }
    }
  }

  const dynamicsStr = (alliances.length > 0 || tensions.length > 0)
    ? `\nGROUP DYNAMICS:\n${alliances.length > 0 ? `Alliances: ${alliances.join(', ')}` : ''}${tensions.length > 0 ? `\nTensions: ${tensions.join(', ')}` : ''}`
    : ''

  const takeawayKeys = participants.map((p) => `"${p.id}": { "knowledge": "...", "mood_shift": null, "relationship_deltas": {${participants.filter((o) => o.id !== p.id).map((o) => `"${o.id}": 0`).join(', ')}}, "internal_reaction": "..." }`).join(',\n    ')

  const user = `Location: ${location?.name ?? 'unknown'} — ${location?.description?.slice(0, 80) ?? ''}
Participants: ${names}
${dynamicsStr}

${participantBlocks}

Generate their conversation. JSON:
{
  "dialogue": [{"speaker": "Name", "says": "*action* \\"speech\\""}],
  "summary": "2-3 sentences: what happened and what changed",
  "concluded": false,
  "outcome": {"agreement_reached": null, "item_transferred": null, "conflict": null},
  "takeaways": {
    ${takeawayKeys}
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
