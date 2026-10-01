import { useCallback, useEffect, useState } from 'react'
import {
  AlertCircle,
  FlaskConical,
  KeyRound,
  Loader2,
  MessageSquare,
  Send,
  ShieldQuestion,
  X,
} from 'lucide-react'
import type { AiStatus } from '../../shared/types'
import { bridge } from '../bridge'
import { Chip, EmptyState, PageHeader, Segmented } from '../components/ui'

/**
 * The experimental assistant (1.3.2).
 *
 * Two things this page refuses to do, because they are the whole reason the
 * feature is called experimental and stays behind a switch:
 *
 * * It never pretends the backend is unlimited. It is one signed-in web
 *   session, bound by that account's quota, and Google can break it at any
 *   time. The banner says exactly that, on every visit.
 * * It never quietly uploads anything. The question is the only thing sent,
 *   plus a short, capped summary of usage totals. File paths are never part of
 *   it, and the summary that is sent is described here before it is sent.
 */

const SUGGESTIONS = [
  'What did I spend today on?',
  'When am I most productive?',
  'How does this week compare to last?',
]

export default function AssistantPage() {
  const [status, setStatus] = useState<AiStatus | null | 'loading'>('loading')
  const [question, setQuestion] = useState('')
  const [model, setModel] = useState<string>('')
  const [answer, setAnswer] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [asking, setAsking] = useState(false)

  const refresh = useCallback(async () => {
    try {
      const s = await bridge.aiStatus()
      setStatus(s)
      if (s?.models.length && !model) setModel(s.models[0].id)
    } catch {
      setStatus(null)
    }
  }, [model])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const ask = useCallback(
    async (text: string) => {
      const q = text.trim()
      if (!q || asking) return
      setAsking(true)
      setError(null)
      setAnswer(null)
      try {
        const res = await bridge.aiAsk(q, model || null)
        if (res.ok && res.answer) setAnswer(res.answer)
        else setError(res.error ?? 'The assistant did not return an answer.')
      } catch (e) {
        setError(e instanceof Error ? e.message : 'The assistant could not be reached.')
      } finally {
        setAsking(false)
      }
    },
    [asking, model],
  )

  if (status === 'loading') {
    return (
      <div className="page">
        <PageHeader title="Assistant" subtitle="Ask about your own usage" />
      </div>
    )
  }

  // Not compiled into this build: the cargo feature is off, so there is
  // nothing to show and nothing to configure.
  if (!status?.compiledIn) {
    return (
      <div className="page">
        <PageHeader
          title="Assistant"
          subtitle="Ask about your own usage"
          action={
            <Chip icon={<FlaskConical size={12} />} tone="warn">
              Experimental
            </Chip>
          }
        />
        <div className="card">
          <EmptyState
            icon={<FlaskConical size={24} />}
            title="Not available in this build"
            desc="The assistant is compiled out unless 1Boost is built with the experimental-ai feature. Nothing about your usage leaves this machine in a build like this."
          />
        </div>
      </div>
    )
  }

  if (!status.enabled) {
    return (
      <div className="page">
        <PageHeader
          title="Assistant"
          subtitle="Ask about your own usage"
          action={
            <Chip icon={<FlaskConical size={12} />} tone="warn">
              Experimental
            </Chip>
          }
        />
        <div className="card">
          <EmptyState
            icon={<ShieldQuestion size={24} />}
            title="Turned off"
            desc="The experimental assistant is off. Enable it in Settings → Experimental AI to switch it on — you will be told there exactly what it sends before anything leaves this machine."
          />
        </div>
      </div>
    )
  }

  return (
    <div className="page assistant-page">
      <PageHeader
        title="Assistant"
        subtitle="Ask about your own usage"
        action={
          <Chip icon={<FlaskConical size={12} />} tone="warn">
            Experimental
          </Chip>
        }
      />

      {/* The disclosure, not fine print. Repeated here because this is the
          page where the data actually leaves the machine. */}
      <div className="setting-note ai-disclosure" role="note">
        <AlertCircle size={14} />
        <span className="grow">
          <b>Experimental.</b> Answers come from Gemini through your own Google web session, so they
          are limited by that account's quota and are not unlimited. Each question is sent as a
          temporary chat along with a short summary of your usage totals — never file names or paths.
          Google can change or withdraw this at any time, and so can we.
        </span>
      </div>

      {!status.configured ? (
        <div className="card" style={{ marginTop: 'var(--space-4)' }}>
          <EmptyState
            icon={<KeyRound size={24} />}
            title="No session connected"
            desc="Paste your own Gemini cookie in Settings → Experimental AI. 1Boost never reads your browser profile, and nothing you paste is ever stored in this repository."
            action={
              <button className="btn btn-secondary" onClick={() => void bridge.navigate('settings')}>
                Open Settings
              </button>
            }
          />
        </div>
      ) : (
        <>
          <div className="ai-model-row">
            <Segmented
              options={status.models.map((m) => ({ value: m.id, label: m.label }))}
              value={model || status.models[0]?.id || ''}
              onChange={setModel}
            />
            <span className="app-meta">Chats are sent as temporary and are not kept in your history.</span>
          </div>

          <div className="ai-ask">
            <textarea
              className="tool-textarea ai-question"
              value={question}
              placeholder="What would you like to know about your usage?"
              onChange={(e) => setQuestion(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) void ask(question)
              }}
              spellCheck={false}
            />
            <button
              className="btn btn-primary"
              onClick={() => void ask(question)}
              disabled={asking || !question.trim()}
            >
              {asking ? <Loader2 size={15} className="spin" /> : <Send size={15} />}
              {asking ? 'Asking…' : 'Ask'}
            </button>
          </div>

          {!question && !answer ? (
            <div className="chip-row" style={{ marginTop: 'var(--space-4)' }}>
              {SUGGESTIONS.map((s) => (
                <button key={s} className="chip" onClick={() => void ask(s)}>
                  <MessageSquare size={12} /> {s}
                </button>
              ))}
            </div>
          ) : null}

          {error ? (
            <div className="setting-note bad" role="alert" style={{ marginTop: 'var(--space-4)' }}>
              <AlertCircle size={14} />
              <span className="grow">{error}</span>
            </div>
          ) : null}

          {answer ? (
            <div className="card ai-answer" style={{ marginTop: 'var(--space-4)' }}>
              <div className="ai-answer-head">
                <div className="setting-title">Answer</div>
                <button
                  className="btn btn-ghost"
                  onClick={() => {
                    setAnswer(null)
                    setQuestion('')
                  }}
                >
                  <X size={13} /> Clear
                </button>
              </div>
              <div className="ai-answer-body">{answer}</div>
            </div>
          ) : null}
        </>
      )}
    </div>
  )
}
