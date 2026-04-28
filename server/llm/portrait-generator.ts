import OpenAI from 'openai'
import * as fs from 'fs'
import * as path from 'path'
import type { NPC } from '../../shared/types.js'
import { TAG_EFFECTS } from '../../shared/constants.js'

const apiKey = process.env.OPENAI_API_KEY
const ENABLE_PORTRAITS = process.env.ENABLE_PORTRAITS === 'true'
const PORTRAITS_DIR = path.join(process.cwd(), 'public', 'portraits')

// Locked style prompt — extremely specific to prevent DALL-E from adding extra junk
const STYLE_PREFIX = `A single pixel art person standing facing the viewer. Plain solid black background, nothing else in the image. Full body visible from feet to top of head, centered in frame. NO character sheet, NO multiple views, NO side views, NO UI elements, NO text, NO labels, NO attributes, NO frames, NO borders. Just one person standing alone.`

// Tags that trigger visual regeneration
const VISUAL_TAGS = new Set([
  'injured', 'bleeding', 'armed', 'disguised', 'nude', 'wet',
  'tied_up', 'restrained', 'sleeping', 'drunk', 'armored',
])

let openai: OpenAI | null = null
function getClient(): OpenAI {
  if (!openai) openai = new OpenAI({ apiKey, timeout: 120000 })
  return openai
}

function ensurePortraitsDir(): void {
  if (!fs.existsSync(PORTRAITS_DIR)) {
    fs.mkdirSync(PORTRAITS_DIR, { recursive: true })
  }
}

function buildCharacterDescription(npc: NPC): string {
  const parts: string[] = []

  // Core appearance
  parts.push(`${npc.occupation}`)
  parts.push(npc.appearance)

  // Inventory-visible items (weapons, tools)
  const visibleItems = (npc.inventory ?? []).filter((i) =>
    (i.tags ?? []).some((t) => ['weapon', 'tool', 'armor', 'clothing'].includes(t))
  )
  if (visibleItems.length > 0) {
    parts.push(`Carrying: ${visibleItems.map((i) => i.name).join(', ')}`)
  }

  // State flags that affect appearance
  const visualFlags = (npc.stateFlags ?? []).filter((f) => VISUAL_TAGS.has(f))
  if (visualFlags.length > 0) {
    const descriptions = visualFlags.map((f) => {
      const effect = TAG_EFFECTS[f]
      if (f === 'injured' || f === 'bleeding') return 'visible wounds and blood stains on clothing'
      if (f === 'armed') return 'visibly carrying a weapon'
      if (f === 'disguised') return 'wearing a disguise, face partially covered'
      if (f === 'nude') return 'undressed'
      if (f === 'wet') return 'soaking wet, dripping'
      if (f === 'tied_up' || f === 'restrained') return 'hands bound with rope'
      if (f === 'sleeping') return 'eyes closed, slumped posture'
      if (f === 'drunk') return 'swaying slightly, flushed face, holding a drink'
      return effect?.description ?? f
    })
    parts.push(`Current state: ${descriptions.join(', ')}`)
  }

  // Health-based appearance
  if (npc.physical.health < 30) {
    parts.push('Looks severely weakened and pale')
  } else if (npc.physical.health < 60) {
    parts.push('Looks roughed up and tired')
  }

  if ((npc.physical.injuries ?? []).length > 0) {
    parts.push(`Injuries visible: ${npc.physical.injuries.join(', ')}`)
  }

  return parts.join('. ')
}

export async function generatePortrait(
  npc: NPC,
  settingDescription: string
): Promise<string | null> {
  if (!ENABLE_PORTRAITS || !apiKey) return null

  try {
    const characterDesc = buildCharacterDescription(npc)
    const prompt = `${STYLE_PREFIX} Pixel art style, limited color palette.\n\nThe person is: ${characterDesc}.\n\nI repeat: ONLY ONE person, full body head to toe, plain black background, absolutely nothing else in the image. No reference sheet. No multiple angles. No RPG UI. No text.`

    const response = await getClient().images.generate({
      model: 'dall-e-3',
      prompt,
      size: '1024x1024',
      quality: 'standard',
      n: 1,
    })

    const imageUrl = response.data?.[0]?.url
    if (!imageUrl) return null

    // Download to local file (DALL-E URLs expire)
    ensurePortraitsDir()
    // Use versioned filenames for regeneration (bust cache)
    const version = Date.now()
    const fileName = `${npc.id}_v${version}.png`
    const filePath = path.join(PORTRAITS_DIR, fileName)

    const imageResponse = await fetch(imageUrl)
    const buffer = Buffer.from(await imageResponse.arrayBuffer())
    fs.writeFileSync(filePath, buffer)

    // Clean up old versions
    const oldFiles = fs.readdirSync(PORTRAITS_DIR).filter((f) => f.startsWith(`${npc.id}_`) && f !== fileName)
    for (const old of oldFiles) {
      try { fs.unlinkSync(path.join(PORTRAITS_DIR, old)) } catch {}
    }

    const localUrl = `/portraits/${fileName}`
    console.log(`[Portrait] Generated for ${npc.name}: ${localUrl}`)
    return localUrl
  } catch (error) {
    console.error(`[Portrait] Failed for ${npc.name}:`, error)
    return null
  }
}

export async function generatePortraitBatch(
  npcs: NPC[],
  settingDescription: string
): Promise<Map<string, string>> {
  if (!ENABLE_PORTRAITS || !apiKey) return new Map()

  const results = new Map<string, string>()

  // Generate in batches of 3 to avoid rate limiting
  const batchSize = 3
  for (let i = 0; i < npcs.length; i += batchSize) {
    const batch = npcs.slice(i, i + batchSize)
    const promises = batch.map(async (npc) => {
      const url = await generatePortrait(npc, settingDescription)
      if (url) results.set(npc.id, url)
    })
    await Promise.all(promises)
  }

  return results
}

// Check if NPC's visual state has changed enough to warrant regeneration
export function shouldRegeneratePortrait(oldFlags: string[], newFlags: string[]): boolean {
  const oldVisual = new Set(oldFlags.filter((f) => VISUAL_TAGS.has(f)))
  const newVisual = new Set(newFlags.filter((f) => VISUAL_TAGS.has(f)))
  if (oldVisual.size !== newVisual.size) return true
  for (const f of newVisual) {
    if (!oldVisual.has(f)) return true
  }
  return false
}

// Debounced regeneration tracker
const lastRegenTick: Record<string, number> = {}
const REGEN_COOLDOWN = 10 // minimum ticks between regenerations

export async function maybeRegeneratePortrait(
  npc: NPC,
  currentTick: number,
  settingDescription: string
): Promise<string | null> {
  if (!ENABLE_PORTRAITS) return null
  const lastTick = lastRegenTick[npc.id] ?? 0
  if (currentTick - lastTick < REGEN_COOLDOWN) return null

  lastRegenTick[npc.id] = currentTick
  const url = await generatePortrait(npc, settingDescription)
  return url
}
