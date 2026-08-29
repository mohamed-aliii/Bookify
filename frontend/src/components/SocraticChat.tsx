import { useCallback, useRef, useState } from 'react'
import { streamLearning } from '../api'
import Markdown from './Markdown'

interface Message {
  role: 'tutor' | 'student'
  content: string
}

export default function SocraticChat({
  bookId,
  sectionId,
}: {
  bookId: number
  sectionId: number
}) {
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [streaming, setStreaming] = useState(false)
  const [revealLevel, setRevealLevel] = useState(0)
  const [started, setStarted] = useState(false)
  const abortRef = useRef<AbortController | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  const startSession = useCallback(() => {
    setStarted(true)
    setRevealLevel(0)
    setMessages([])
    const firstMsg = "Let's explore this section together. I'll ask you questions to help you understand the material deeply. Ready?"
    setMessages([{ role: 'tutor', content: firstMsg }])

    abortRef.current?.abort()
    abortRef.current = new AbortController()

    const tutorHistory = messages.map((m) => ({
      role: m.role === 'tutor' ? 'assistant' : 'user',
      content: m.content,
    }))

    let tutorResponse = ''
    streamLearning(
      `/api/books/${bookId}/socratic`,
      { section_id: sectionId, message: firstMsg, history: tutorHistory, reveal_level: revealLevel },
      {
        onToken: (t) => {
          tutorResponse += t
          setMessages((prev) => {
            const updated = [...prev]
            const last = updated[updated.length - 1]
            if (last && last.role === 'tutor') {
              updated[updated.length - 1] = { ...last, content: tutorResponse }
            } else {
              updated.push({ role: 'tutor', content: tutorResponse })
            }
            return updated
          })
        },
        onStatus: () => {},
      },
      abortRef.current.signal,
    ).finally(() => setStreaming(false))

    setStreaming(true)
  }, [bookId, sectionId, messages, revealLevel])

  const sendMessage = useCallback(() => {
    if (!input.trim() || streaming) return

    const studentMsg = input.trim()
    setInput('')
    setMessages((prev) => [...prev, { role: 'student', content: studentMsg }])

    if (studentMsg.toLowerCase() === "i don't know" || studentMsg.toLowerCase() === 'idk') {
      setRevealLevel((l) => Math.min(l + 1, 2))
    }

    abortRef.current?.abort()
    abortRef.current = new AbortController()

    const history = [...messages, { role: 'student' as const, content: studentMsg }].map((m) => ({
      role: m.role === 'tutor' ? 'assistant' : 'user',
      content: m.content,
    }))

    let tutorResponse = ''
    setMessages((prev) => [...prev, { role: 'tutor', content: '' }])
    setStreaming(true)

    streamLearning(
      `/api/books/${bookId}/socratic`,
      { section_id: sectionId, message: studentMsg, history, reveal_level: revealLevel },
      {
        onToken: (t) => {
          tutorResponse += t
          setMessages((prev) => {
            const updated = [...prev]
            updated[updated.length - 1] = { role: 'tutor', content: tutorResponse }
            return updated
          })
        },
      },
      abortRef.current.signal,
    ).finally(() => setStreaming(false))
  }, [input, streaming, bookId, sectionId, messages, revealLevel])

  return (
    <div className="flex h-full flex-col">
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-1 pb-4">
        {!started ? (
          <div className="flex flex-col items-center justify-center py-16 text-center">
            <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-br from-indigo-500 to-fuchsia-500 text-white shadow-lg">
              <svg xmlns="http://www.w3.org/2000/svg" className="h-7 w-7" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 2a5 5 0 0 1 4.5 2.8A4 4 0 0 1 20 8.5a4.5 4.5 0 0 1-1 8.9A3.5 3.5 0 0 1 15 20H9a3.5 3.5 0 0 1-4-2.6A4.5 4.5 0 0 1 4 8.5a4 4 0 0 1 3.5-3.7A5 5 0 0 1 12 2z"/><path d="M12 2v20"/></svg>
            </div>
            <h3 className="text-lg font-semibold text-slate-100">Socratic Tutoring</h3>
            <p className="mt-2 max-w-sm text-sm text-slate-400">
              Instead of giving you answers, I'll ask questions to guide your thinking. You'll understand the material much more deeply.
            </p>
            <button
              onClick={startSession}
              className="mt-6 btn-primary"
            >
              Start Session
            </button>
          </div>
        ) : (
          <div className="space-y-4">
            {messages.map((m, i) => (
              <div key={i} className={`flex ${m.role === 'student' ? 'justify-end' : 'justify-start'}`}>
                <div
                  className={`max-w-[85%] rounded-2xl px-4 py-3 text-sm leading-relaxed ${
                    m.role === 'student'
                      ? 'bg-indigo-600/15 border border-indigo-500/10'
                      : 'bg-white/[0.03] border border-white/[0.04] text-slate-200'
                  }`}
                >
                  {m.role === 'tutor' ? (
                    <Markdown text={m.content} />
                  ) : (
                    <p>{m.content}</p>
                  )}
                  {m.role === 'tutor' && i === messages.length - 1 && streaming && (
                    <span className="ml-1 inline-block h-4 w-1.5 animate-pulse bg-indigo-400" />
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {started && (
        <div className="shrink-0 border-t border-white/[0.06] p-3">
          <div className="mb-2 flex items-center gap-2 text-[11px] text-slate-600">
            <span>Strict: ●○○</span>
            <span>·</span>
            <span>Hint: ●●○</span>
            <span>·</span>
            <span>Reveal: ●●●</span>
            <span className="ml-auto">
              Level: {'●'.repeat(revealLevel + 1)}{'○'.repeat(2 - revealLevel)}
            </span>
          </div>
          <div className="flex gap-2">
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && !e.shiftKey && sendMessage()}
              placeholder="Type your answer..."
              className="flex-1 input"
            />
            <button
              onClick={sendMessage}
              disabled={!input.trim() || streaming}
              className="btn-primary"
            >
              Send
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
