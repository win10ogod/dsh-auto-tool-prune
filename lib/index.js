import z from '@deepseek-ai/schemastery'
import { DEFAULTS } from '@deepseek-ai/dsh-compaction-tool-result-pruner'
import SafeToolResultPruner, { PROTECTED_TOOLS } from './pruner.js'

export const name = 'auto-tool-prune'
export const inject = ['agents', 'sessions', 'tokenMeter']
export const Config = z.object({
  enabled: z.boolean().default(true),
  thresholdChars: z.number().step(1).min(1).default(DEFAULTS.thresholdChars),
  headChars: z.number().step(1).min(0).default(DEFAULTS.headChars),
  tailChars: z.number().step(1).min(0).default(DEFAULTS.tailChars),
  protectedTools: z.array(z.string()).default(PROTECTED_TOOLS)
})

/** Prune oversized tool results at request boundaries using DSH's durable replacement protocol. */
export function apply(ctx, config = {}) {
  if (config.enabled === false) return
  const limits = Object.fromEntries(['thresholdChars', 'headChars', 'tailChars', 'protectedTools']
    .filter(key => config[key] !== undefined).map(key => [key, config[key]]))
  // Keep the existing compaction pruner and its configured scope intact.
  const pruner = new SafeToolResultPruner(ctx.isolate('toolResultPruner'), limits)
  const warnings = new WeakMap()

  ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
    const decision = await next()
    if (decision.kind !== 'enter' || signal.aborted) return decision
    try {
      pruner.pruneSession(agent.session)
      warnings.delete(agent.session)
    } catch (error) {
      // Pruning must not terminate otherwise valid work. Native replacements
      // already committed before a failure remain valid; unpruned data remains.
      const message = error instanceof Error ? error.message : String(error)
      if (warnings.get(agent.session) !== message) {
        warnings.set(agent.session, message)
        ctx.logger.warn(`auto-tool-prune: kept available history after pruning failed: ${message}`)
      }
    }
    return decision
  })
}
