import type { ChatConversationViewNode, ConversationNodeDefinition } from '@deepseek-ai/dsh-client-runtime/client'

export type ClaudeActivityStatus = 'running' | 'completed' | 'error'

export interface ClaudeActivityData {
  readonly type: string
  readonly status: ClaudeActivityStatus
  readonly title: string
  readonly summary?: string
  readonly input?: string
  readonly output?: string
  readonly provenance?: {
    readonly claudeSessionId: string
    readonly turnId: string
  }
}

export interface ClaudeActivityEventData {
  readonly version: 1
  readonly claudeSessionId: string
  readonly turnId: string
  readonly itemId: string
  readonly phase: 'started' | 'completed'
  readonly activity: ClaudeActivityData
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    'claude-agent-sdk/activity': ClaudeActivityEventData
  }
}

declare module '@deepseek-ai/dsh-client-ui-conversation/client' {
  interface ChatNodeDataMap {
    'claude-agent-sdk-activity': ClaudeActivityData
  }
}

export const claudeActivityDefinition: ConversationNodeDefinition<ClaudeActivityData> = {
  kind: 'claude-agent-sdk-activity',
  target: 'chat',
  match: event => event.type === 'claude-agent-sdk/activity'
    ? { id: event.data.itemId, role: event.data.phase === 'started' ? 'start' : 'update' }
    : null,
  start: (_context, match) => {
    if (match.event.type !== 'claude-agent-sdk/activity') {
      throw new Error('Claude activity start requires claude-agent-sdk/activity')
    }
    return {
      ...match.event.data.activity,
      provenance: {
        claudeSessionId: match.event.data.claudeSessionId,
        turnId: match.event.data.turnId,
      },
    }
  },
  update: (context, match) => match.event.type === 'claude-agent-sdk/activity'
    ? {
        ...match.event.data.activity,
        provenance: {
          claudeSessionId: match.event.data.claudeSessionId,
          turnId: match.event.data.turnId,
        },
      }
    : context.state,
  buildViewNode: (context): ChatConversationViewNode | null => {
    if (context.start === undefined || context.state === undefined) return null
    return {
      key: context.key,
      kind: 'claude-agent-sdk-activity',
      id: context.id,
      target: 'chat',
      anchorSeq: context.start.event.seq,
      location: context.start.location,
      visibility: 'visible',
      data: context.state,
    }
  },
}
