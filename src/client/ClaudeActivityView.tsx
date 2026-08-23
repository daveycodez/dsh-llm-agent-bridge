import { memo, useState } from 'react'
import {
  DisclosureRow,
  IconCodeOutline16,
  StateDot,
  type StateDotState,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ClaudeActivityData } from './claude-activity.ts'
import css from './ClaudeActivityView.module.css'

type ClaudeActivityViewProps = PropsRuntime<'conversation.chat.node', 'relay-claude-activity'>

function dotState(status: ClaudeActivityData['status']): StateDotState {
  if (status === 'running') return 'ongoing'
  if (status === 'error') return 'error'
  return 'done'
}

export const ClaudeActivityView = memo(function ClaudeActivityView({ node }: ClaudeActivityViewProps) {
  const activity = node.data as ClaudeActivityData
  const [open, setOpen] = useState(false)
  const expandable = activity.input !== undefined || activity.output !== undefined || activity.provenance !== undefined
  return (
    <div className={css.activity} data-claude-activity={activity.type}>
      <DisclosureRow
        icon={<IconCodeOutline16 />}
        title={activity.title}
        open={open}
        expandable={expandable}
        onToggle={() => { setOpen(value => !value) }}
        expandOnRowClick
        collapsedContent={(
          <span className={css.summary}>
            <span>{activity.summary}</span>
            <StateDot state={dotState(activity.status)} size={8} />
          </span>
        )}
      >
        <div className={css.detail}>
          {activity.provenance !== undefined ? (
            <div
              className={css.provenance}
              title={`Claude Code · Session ${activity.provenance.claudeSessionId} · Turn ${activity.provenance.turnId}`}
            >
              Claude Code · Session {shortId(activity.provenance.claudeSessionId)} · Turn {shortId(activity.provenance.turnId)}
            </div>
          ) : null}
          {activity.input !== undefined ? <pre>{activity.input}</pre> : null}
          {activity.output !== undefined ? <pre>{activity.output}</pre> : null}
        </div>
      </DisclosureRow>
    </div>
  )
})

function shortId(value: string): string {
  return value.length > 15 ? `${value.slice(0, 8)}...${value.slice(-4)}` : value
}
