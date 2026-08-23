import type { IApiClient } from '@deepseek-ai/dsh-api-remotes/client'
import type { ClientContext, SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { ClaudeActivityView } from './ClaudeActivityView.tsx'
import { claudeActivityDefinition } from './claude-activity.ts'

interface ConnectionFace { api: { sessions: Pick<IApiClient['sessions'], 'models' | 'selectModel'> } }
interface ModelGroup { readonly id: string; readonly models: readonly { readonly id: string; readonly reasoning?: { readonly defaultEffort?: string } }[] }

export const inject = ['slots', 'theme', 'locale', 'remote', 'sessions', 'connection', 'conversationEvents']

export async function apply(ctx: ClientContext): Promise<() => Promise<void>> {
  ctx.conversationEvents.register(claudeActivityDefinition)
  ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({
    name: 'conversation.chat.node', key: 'relay-claude-activity',
  }, ClaudeActivityView))
  const unsubscribe = installModelSelection(ctx)
  return async () => { unsubscribe() }
}

function installModelSelection(ctx: ClientContext): () => void {
  const connection = ctx.get('connection' as never) as unknown as ConnectionFace
  const selecting = new Set<string>()
  const sync = (): void => {
    const list = ctx.sessions.list.getSnapshot()
    const id = list.current
    if (id === undefined || list.byId[id]?.blank !== true || selecting.has(id)) return
    const preset = list.byId[id]?.agentPreset
    if (preset === 'relay-codex') return
    selecting.add(id)
    void connection.api.sessions.models({ sessionId: id }).then(async (response: Awaited<ReturnType<ConnectionFace['api']['sessions']['models']>>) => {
      const { result } = response
      if (!result.ok) return
      const target = preset === 'relay-claude'
        ? (result.value.groups as readonly ModelGroup[]).find(group => group.id === 'relay-claude')
        : result.value.current.provider === 'relay-claude'
          ? (result.value.groups as readonly ModelGroup[]).find(group => group.id !== 'relay-claude' && group.id !== 'relay-codex')
          : undefined
      const model = target?.models[0]
      if (target && model) await connection.api.sessions.selectModel({ sessionId: id as SessionId, provider: target.id, model: model.id, ...(model.reasoning?.defaultEffort ? { reasoningEffort: model.reasoning.defaultEffort } : {}) })
    }).catch(() => {}).finally(() => { selecting.delete(id) })
  }
  const off = ctx.sessions.list.subscribe(sync); sync(); return off
}
