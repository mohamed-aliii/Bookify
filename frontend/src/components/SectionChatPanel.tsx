import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react'
import Markdown from './Markdown'
import { api, streamLearning } from '../api'
import usePaneWidth from '../hooks/usePaneWidth'
import type { ChatMessage, ReadAction, SectionChatRequest } from '../types'

const ACTION_LABELS: Record<string, string> = {
  simplify: 'Simplify',
  explain: 'Explain',
  examples: 'Examples',
  code: 'Code',
  create_flashcard: 'Flashcard',
  create_note: 'Note',
  ask: 'Ask',
  translate: 'Translate',
}

const BACKEND_ACTION: Record<string, string> = {
  create_flashcard: 'flashcard',
  create_note: 'note',
}

export interface SectionChatHandle {
  sendAction: (text: string, action: ReadAction, page: number | null) => void
}

interface Props {
  visible: boolean
  bookId: number
  sectionId: number | null
  sectionTitle: string
  onOpenNotebook?: (cellId: number, sectionId: number) => void
}

export default forwardRef<SectionChatHandle, Props>(function SectionChatPanel(
  { visible, bookId, sectionId, sectionTitle, onOpenNotebook },
  ref,
) {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [loading, setLoading] = useState(false)
  const [streaming, setStreaming] = useState(false)
  const [streamContent, setStreamContent] = useState('')
  const [streamAction, setStreamAction] = useState('')
  const [savedKind, setSavedKind] = useState<'note' | 'flashcard' | null>(null)
  const [codeAdded, setCodeAdded] = useState(false)
  const [input, setInput] = useState('')
  const abortRef = useRef<AbortController | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const loadKey = `${bookId}:${sectionId}`
  const { width: chatWidth, startResize: startChatResize } = usePaneWidth(
    `bookify:layout:${bookId}:chat`,
    400,
    280,
    620,
  )

  useEffect(() => {
    if (!visible || !sectionId) { setMessages([]); return }
    setLoading(true)
    api.getSectionChat(bookId, sectionId).then((data) => {
      setMessages(data.messages)
    }).catch(() => {}).finally(() => setLoading(false))
  }, [visible, bookId, sectionId, loadKey])

  useEffect(() => {
    if (!scrollRef.current) return
    scrollRef.current.scrollTop = scrollRef.current.scrollHeight
  }, [messages, streamContent])

  const send = useCallback((text: string, action: string, page: number | null, question?: string) => {
    if (streaming || !sectionId) return

    const userLabel = action === 'ask' && question
      ? question
      : `[${ACTION_LABELS[action] ?? action}] ${text.slice(0, 200)}${text.length > 200 ? '…' : ''}`

    const userMsg: ChatMessage = {
      id: Date.now(),
      role: 'user',
      content: userLabel,
      action,
    }
    setMessages((prev) => [...prev, userMsg])
    setStreamContent('')
    setStreamAction(action)
    setSavedKind(null)
    setCodeAdded(false)
    setStreaming(true)

    const backendAction = BACKEND_ACTION[action] ?? action
    const body: SectionChatRequest = { text, action: backendAction, page }
    if (question) body.question = question

    const controller = new AbortController()
    abortRef.current = controller

    void streamLearning(
      `/api/books/${bookId}/sections/${sectionId}/chat`,
      body as unknown as Record<string, unknown>,
      {
        onToken: (token) => setStreamContent((prev) => prev + token),
        onReasoning: () => {},
        onStatus: () => {},
        onEvent: (type, event) => {
          if (type === 'saved_note') setSavedKind('note')
          else if (type === 'saved_flashcard') setSavedKind('flashcard')
          else if (type === 'notebook_created' && event.cell_id != null) {
            setCodeAdded(true)
            onOpenNotebook?.(event.cell_id, sectionId)
          }
        },      },
      controller.signal,
    ).catch((e) => {
      if (e instanceof DOMException && e.name === 'AbortError') return
      setMessages((prev) => [...prev, {
        id: Date.now() + 1,
        role: 'assistant',
        content: `Error: ${e instanceof Error ? e.message : String(e)}`,
      }])
    }).finally(() => {
      setStreamContent('')
      setStreamAction('')
      setStreaming(false)
      abortRef.current = null
      if (sectionId) {
        api.getSectionChat(bookId, sectionId).then((data) => setMessages(data.messages)).catch(() => {})
      }
    })
  }, [bookId, sectionId, streaming, onOpenNotebook])

  const handleSend = useCallback(() => {
    const q = input.trim()
    if (!q) return
    setInput('')
    send(q, 'ask', null, q)
  }, [input, send])

  useImperativeHandle(ref, () => ({
    sendAction: (text: string, action: ReadAction, page: number | null) => {
      send(text, action, page)
    },
  }), [send])

  if (!visible) return null

  return (
    <div style={{ width: chatWidth }} className="relative flex h-full shrink-0 flex-col border-l border-white/[0.06] bg-surface-1 animate-slide-in-right">
      <div onPointerDown={(e) => startChatResize(e, -1)} className="absolute left-0 top-0 h-full w-1.5 cursor-col-resize touch-none select-none hover:bg-indigo-500/40" />
      {/* Header */}
      <div className="flex items-center gap-2 border-b border-white/[0.06] px-4 py-3">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-4 w-4 text-indigo-400">
          <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <span className="text-sm font-medium text-slate-200 truncate">{sectionTitle || 'Section Chat'}</span>
        {streaming && <span className="thinking-shimmer text-xs text-slate-500 ml-auto">thinking…</span>}
      </div>

      {/* Messages */}
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-4 py-4 space-y-4">
        {loading && (
          <div className="flex items-center gap-2 py-8 text-slate-500">
            <div className="h-4 w-4 animate-spin rounded-full border-2 border-slate-600 border-t-indigo-400" />
            <span className="text-xs">Loading chat…</span>
          </div>
        )}

        {!loading && messages.length === 0 && !streaming && (
          <div className="flex flex-col items-center gap-3 py-12 text-center">
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-indigo-500/10 text-indigo-400">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-6 w-6">
                <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </div>
            <p className="text-xs text-slate-500">Select text in the PDF to start a conversation about this section.</p>
          </div>
        )}

        {messages.map((m) => (
          <div key={m.id} className={`flex flex-col ${m.role === 'user' ? 'items-end' : 'items-start'}`}>
            {m.action && m.role === 'user' && (
              <span className="mb-1 inline-block rounded-full bg-indigo-500/15 px-2 py-0.5 text-2xs font-medium text-indigo-300">
                {ACTION_LABELS[m.action] ?? m.action}
              </span>
            )}
            <div className={`max-w-[90%] rounded-2xl px-3 py-2 text-sm leading-relaxed ${
              m.role === 'user'
                ? 'bg-indigo-600/80 text-white'
                : 'bg-white/[0.04] text-slate-300'
            }`}>
              {m.role === 'assistant' ? <Markdown text={m.content} /> : <span className="whitespace-pre-wrap">{m.content}</span>}
            </div>
          </div>
        ))}

        {streaming && streamContent && (
          <div className="flex flex-col items-start">
            {streamAction && (
              <span className="mb-1 inline-block rounded-full bg-indigo-500/15 px-2 py-0.5 text-2xs font-medium text-indigo-300">
                {ACTION_LABELS[streamAction] ?? streamAction}
              </span>
            )}
            <div className="max-w-[90%] rounded-2xl bg-white/[0.04] px-3 py-2 text-sm leading-relaxed text-slate-300">
              <Markdown text={streamContent} />
            </div>
            {savedKind && (
              <span className="mt-1 inline-flex items-center gap-1 rounded-full bg-emerald-500/15 px-2 py-0.5 text-2xs font-medium text-emerald-400">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="h-3 w-3"><path d="M20 6L9 17l-5-5" strokeLinecap="round" strokeLinejoin="round" /></svg>
                {savedKind === 'flashcard' ? 'Flashcard saved' : 'Note saved'}
              </span>
            )}
          </div>
        )}

        {streaming && !streamContent && (
          <div className="flex flex-col items-start gap-1.5 py-2">
            {streamAction === 'code' && codeAdded && (
              <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/15 px-2 py-0.5 text-2xs font-medium text-emerald-400">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="h-3 w-3"><path d="M20 6L9 17l-5-5" strokeLinecap="round" strokeLinejoin="round" /></svg>
                Code added to notebook
              </span>
            )}
            <div className="flex items-center gap-2">
              {[0, 1, 2].map((i) => (
                <span key={i} className="dot-bounce h-1.5 w-1.5 rounded-full bg-slate-400" style={{ animationDelay: `${i * 0.15}s` }} />
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Input */}
      <div className="shrink-0 border-t border-white/[0.06] px-4 py-3">
        <div className="flex items-end gap-2 rounded-xl border border-slate-700/60 bg-surface-2 py-2 pl-3 pr-2 focus-within:border-indigo-500/40">
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend() } }}
            placeholder={sectionId ? 'Ask anything…' : 'Navigate to a section first…'}
            className="flex-1 bg-transparent text-xs text-slate-200 outline-none placeholder:text-slate-600"
            disabled={streaming || !sectionId}
          />
          <button
            onClick={handleSend}
            disabled={streaming || !input.trim() || !sectionId}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-indigo-600 text-white transition-all hover:bg-indigo-500 disabled:bg-slate-700 disabled:text-slate-500"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="h-3.5 w-3.5"><path d="M12 19V5M5 12l7-7 7 7" strokeLinecap="round" strokeLinejoin="round" /></svg>
          </button>
        </div>
      </div>
    </div>
  )
})
