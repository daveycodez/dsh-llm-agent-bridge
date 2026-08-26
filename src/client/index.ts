/**
 * Browser half: registers the plan-usage ring in the composer's right tool row.
 *
 * The ring sits in `conversation.input.right`, immediately left of the model
 * selector, and renders only while a Claude row is selected — so it never
 * claims to describe a turn it has no data for.
 *
 * Its numbers come from this plugin's own `/agent-bridge` channel, which reads
 * them through the Claude Agent SDK. Nothing here knows about credentials, and
 * no other plugin needs to be installed for the ring to work.
 */

import { createUsageStore } from './usage.js'
import { UsageMeter, type ModelGate } from './UsageMeter.js'

/** `slots` carries the registration seat; `connection` the RPC caller and session API. */
export const inject = ['slots', 'connection']

/** The connection handle surface this plugin uses. */
interface ConnectionHandle {
  readonly rpc: { call(channel: string, endpoint: string, payload: unknown): Promise<unknown> }
  readonly api: {
    readonly sessions: {
      models(input: { sessionId: string }): Promise<{
        result: {
          ok: boolean
          value?: { current: { provider: string, model: string } | null }
        }
      }>
    }
  }
}

/** The provider id this plugin registers its adapter under. */
const PROVIDER = 'claude'

/**
 * Resolve whether the session's current model is one of ours, and which.
 * Rejects on failure so the caller keeps its last known state rather than
 * treating an RPC hiccup as "not a Claude model" and hiding the ring.
 */
function createModelChecker(connection: ConnectionHandle, sessionId: string): () => Promise<ModelGate> {
  return async () => {
    const { result } = await connection.api.sessions.models({ sessionId })
    if (!result.ok) throw new Error('sessions.models failed')
    const current = result.value?.current ?? null
    if (current === null || current.provider !== PROVIDER) return { visible: false, model: null }
    return { visible: true, model: current.model }
  }
}

/**
 * Register the composer ring.
 * @param ctx - client root context.
 */
export function apply(ctx: {
  get(name: string): unknown
  effect(callback: () => () => void, label?: string): () => void
  slots: {
    inject(key: string, callback: () => () => void): () => void
    register(options: unknown, component: unknown): () => void
  }
}): void {
  // The client-runtime Context merge types `connection` as the host handle; in
  // the browser shell the same key holds the full client ConnectionHandle.
  const connection = ctx.get('connection') as ConnectionHandle

  // One store for every session: the slot renders per session, and a fetcher
  // per component would multiply the request rate against a reading that costs
  // a Claude Code control session on the host.
  const store = createUsageStore(connection.rpc)

  ctx.slots.inject('conversation.input.right', () => ctx.slots.register({
    name: 'conversation.input.right',
    id: 'agent-bridge-usage',
    order: 20,
    inject: (sessionId: string) => ({
      checkModel: createModelChecker(connection, sessionId),
      store,
    }),
  }, UsageMeter))
}
