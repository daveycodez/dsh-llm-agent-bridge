import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { ClaudeActivityView } from './ClaudeActivityView.tsx'
import { claudeActivityDefinition } from './claude-activity.ts'

export const inject = ['slots', 'theme', 'locale', 'remote', 'sessions', 'connection', 'conversationEvents']

export async function apply(ctx: ClientContext): Promise<() => Promise<void>> {
  ctx.conversationEvents.register(claudeActivityDefinition)
  ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({
    name: 'conversation.chat.node', key: 'claude-agent-sdk-activity',
  }, ClaudeActivityView))
  return async () => {}
}
