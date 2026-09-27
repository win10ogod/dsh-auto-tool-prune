import NativePruner from '@deepseek-ai/dsh-compaction-tool-result-pruner'

export const PROTECTED_TOOLS = ['skill', 'read', 'read_file', 'readFile']

/** Detection only: structured payloads are never parsed and reserialized. */
export function isStructuredText(text) {
  const trimmed = text.trim()
  if (!trimmed) return false
  try { JSON.parse(trimmed); return true } catch {}
  // Preserve JSON-looking or already incomplete JSON, including log prefixes,
  // JSON Lines, mixed text blocks, fenced code, and file/skill markup wrappers.
  return /^[\[{]/u.test(trimmed) || /\{\s*["}]|\[\s*(?:["{\[\]\d-]|true\b|false\b|null\b)/u.test(text) ||
    /```|~~~/u.test(text) || /<\/?[A-Za-z][\w:-]*(?:\s[^<>]*)?\s*\/?\s*>/u.test(text)
}

/** Keep structural data and instruction/file readers outside head/tail pruning. */
export default class SafeToolResultPruner extends NativePruner {
  constructor(ctx, config = {}) {
    const { protectedTools = PROTECTED_TOOLS, ...limits } = config
    super(ctx, limits)
    if (!Array.isArray(protectedTools) || protectedTools.some(name => typeof name !== 'string' || !name.trim())) {
      throw new Error('protectedTools must be an array of nonempty tool names')
    }
    this.protectedTools = new Set(protectedTools)
    this.protectedContent = new WeakSet()
  }

  pruneSession(session) {
    const previous = this.protectedContent
    const protectedContent = new WeakSet()
    const messages = session.deriveMessages()
    const calls = new Map()
    for (const message of messages) if (message.role === 'assistant') {
      for (const block of message.content) if (block.type === 'tool-call') calls.set(block.id, block.name)
    }
    for (const message of messages) if (message.role === 'tool') {
      const name = calls.get(message.toolCallId)
      if (!name || this.protectedTools.has(name) || this.protectedTools.has(name.split('__').at(-1))) {
        protectedContent.add(message.content)
      }
    }
    this.protectedContent = protectedContent
    try { return super.pruneSession(session) }
    finally { this.protectedContent = previous }
  }

  pruneContent(blocks) {
    if (this.protectedContent.has(blocks)) return null
    if (this.measureContent(blocks) <= this.config.thresholdChars) return null
    const texts = blocks.filter(block => block.type === 'text').map(block => block.text)
    if (texts.some(isStructuredText) || isStructuredText(texts.join(''))) return null
    return super.pruneContent(blocks)
  }
}
