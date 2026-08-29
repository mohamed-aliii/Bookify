import { useCallback, useEffect, useRef, useState } from 'react'
import { api, streamLearning } from '../api'
import Markdown from './Markdown'

interface SpeechRecognitionEvent extends Event {
  results: SpeechRecognitionResultList
  resultIndex: number
}

interface SpeechRecognition extends EventTarget {
  continuous: boolean
  interimResults: boolean
  lang: string
  onresult: ((event: SpeechRecognitionEvent) => void) | null
  onerror: ((event: Event & { error: string }) => void) | null
  onend: (() => void) | null
  start(): void
  stop(): void
  abort(): void
}

declare global {
  interface Window {
    SpeechRecognition: new () => SpeechRecognition
    webkitSpeechRecognition: new () => SpeechRecognition
  }
}

const LANGUAGES = [
  { code: 'en-US', label: 'English', flag: '🇺🇸', tts: 'en' },
  { code: 'ar-SA', label: 'عربي', flag: '🇸🇦', tts: 'ar' },
  { code: 'en-GB', label: 'English (UK)', flag: '🇬🇧', tts: 'en-GB' },
  { code: 'ar-EG', label: 'عربي (مصر)', flag: '🇪🇬', tts: 'ar-EG' },
]

function isArabic(text: string): boolean { return /[\u0600-\u06FF]/.test(text) }

const MIN_CHUNK = 200
const PARA_BREAK = /\n\n/
const SENTENCE_END = /[.!?…]\s+/

class TTSQueue {
  private buf = ''
  private q: { text: string; lang: string }[] = []
  private busy = false
  private dead = false
  private speak: (t: string, l: string) => Promise<void>
  private onPending: (n: number) => void

  constructor(speak: (t: string, l: string) => Promise<void>, onPending: (n: number) => void) {
    this.speak = speak
    this.onPending = onPending
  }

  push(chunk: string) {
    if (this.dead) return
    this.buf += chunk
    this.extract()
  }

  flush() {
    if (this.dead) return
    const rem = this.buf.trim()
    if (rem) {
      this.q.push({ text: rem, lang: isArabic(rem) ? 'ar' : 'en' })
      this.onPending(this.q.length)
      this.drain()
    }
    this.buf = ''
  }

  kill() { this.dead = true; this.buf = ''; this.q = []; this.onPending(0) }

  private extract() {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      // Prefer paragraph break
      const paraIdx = this.buf.search(PARA_BREAK)
      if (paraIdx > 0) {
        this.enqueue(this.buf.slice(0, paraIdx))
        this.buf = this.buf.slice(paraIdx + 2)
        continue
      }
      // If buffer is big enough, find last sentence boundary
      if (this.buf.length >= MIN_CHUNK) {
        const lastMatch = [...this.buf.matchAll(SENTENCE_END)]
        if (lastMatch.length > 0) {
          const last = lastMatch[lastMatch.length - 1]
          this.enqueue(this.buf.slice(0, last.index! + last[0].length))
          this.buf = this.buf.slice(last.index! + last[0].length)
          continue
        }
      }
      break
    }
  }

  private enqueue(text: string) {
    const trimmed = text.trim()
    if (!trimmed) return
    this.q.push({ text: trimmed, lang: isArabic(trimmed) ? 'ar' : 'en' })
    this.onPending(this.q.length)
    this.drain()
  }

  private async drain() {
    if (this.busy || this.q.length === 0) return
    this.busy = true
    while (this.q.length > 0 && !this.dead) {
      const item = this.q.shift()!
      this.onPending(this.q.length)
      await this.speak(item.text, item.lang).catch(() => {})
    }
    this.busy = false
  }
}

interface ChatMsg { role: 'tutor' | 'student'; content: string }

export default function TeachBack({ bookId, sectionId }: { bookId: number; sectionId: number }) {
  const [started, setStarted] = useState(false)
  const [messages, setMessages] = useState<ChatMsg[]>([])
  const [input, setInput] = useState('')
  const [streaming, setStreaming] = useState(false)
  const [speaking, setSpeaking] = useState(false)
  const [lang, setLang] = useState('en-US')
  const [ttsEnabled, setTtsEnabled] = useState(true)
  const [micActive, setMicActive] = useState(false)
  const [micInterim, setMicInterim] = useState('')
  const [micError, setMicError] = useState<string | null>(null)
  const [ttsPending, setTtsPending] = useState(0)
  const [ttsQuality, setTtsQuality] = useState<'fast' | 'high'>('fast')

  const recogRef = useRef<SpeechRecognition | null>(null)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const chatRef = useRef<HTMLDivElement>(null)
  const queueRef = useRef<TTSQueue | null>(null)

  const scrollDown = useCallback(() => { chatRef.current?.scrollTo({ top: chatRef.current.scrollHeight, behavior: 'smooth' }) }, [])
  useEffect(() => { scrollDown() }, [messages, scrollDown])

  // ── TTS helpers ────────────────────────────────────────────────

  const speakOnce = useCallback(async (text: string, voiceLang: string) => {
    const res = await api.tts(text, voiceLang, ttsQuality)
    if (!res.ok) return
    const blob = await res.blob()
    const url = URL.createObjectURL(blob)
    return new Promise<void>((resolve) => {
      const a = new Audio(url)
      audioRef.current = a
      a.onended = () => { URL.revokeObjectURL(url); setSpeaking(false); resolve() }
      a.onerror = () => { URL.revokeObjectURL(url); setSpeaking(false); resolve() }
      setSpeaking(true)
      a.play().catch(() => { setSpeaking(false); resolve() })
    })
  }, [ttsQuality])

  const makeQueue = useCallback(() => {
    queueRef.current?.kill()
    const q = new TTSQueue(speakOnce, setTtsPending)
    queueRef.current = q
    return q
  }, [speakOnce])

  const stopAll = useCallback(() => {
    queueRef.current?.kill()
    audioRef.current?.pause()
    audioRef.current = null
    setSpeaking(false)
    setTtsPending(0)
  }, [])

  useEffect(() => () => { queueRef.current?.kill(); audioRef.current?.pause(); try { recogRef.current?.abort() } catch {} }, [])

  // ── Mic ────────────────────────────────────────────────────────

  const toggleMic = useCallback(() => {
    if (micActive && recogRef.current) {
      try { recogRef.current.stop() } catch {}
      setMicActive(false); setMicInterim(''); return
    }
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition
    if (!SR) { setMicError('Speech recognition not supported. Use Chrome or Edge.'); return }
    try { recogRef.current?.abort() } catch {}
    const r = new SR()
    r.continuous = true; r.interimResults = true; r.lang = lang
    r.onresult = (ev: SpeechRecognitionEvent) => {
      let interim = ''
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        if (ev.results[i].isFinal) {
          const t = ev.results[i][0].transcript
          setInput(p => (p && !p.endsWith(' ') ? p + ' ' : p) + t)
        } else interim += ev.results[i][0].transcript
      }
      setMicInterim(interim)
    }
    r.onerror = (e: Event & { error: string }) => {
      const err = (e as { error: string }).error
      if (err === 'not-allowed') setMicError('Microphone blocked. Allow mic in browser settings.')
      else if (err === 'no-speech') setMicError('No speech detected.')
      else if (err !== 'aborted') setMicError(`Speech error: ${err}`)
      setMicActive(false); setMicInterim('')
    }
    r.onend = () => { setMicActive(false); setMicInterim('') }
    recogRef.current = r; setMicError(null)
    try { r.start(); setMicActive(true) }
    catch (e) { setMicError(`Could not start: ${e instanceof Error ? e.message : String(e)}`) }
  }, [lang, micActive])

  // ── Chat ───────────────────────────────────────────────────────

  const startSession = useCallback(() => {
    setStarted(true)
    const greet: ChatMsg = { role: 'tutor', content: "Let's explore this section. I'll ask you deep questions to test your understanding. Ready?" }
    setMessages([greet]); setInput('')
    if (ttsEnabled) { const q = makeQueue(); q.push(greet.content); q.flush() }
  }, [ttsEnabled, makeQueue])

  const sendMessage = useCallback(async (text?: string) => {
    const msg = (text ?? input).trim()
    if (!msg || streaming) return
    if (recogRef.current) { try { recogRef.current.stop() } catch {} setMicActive(false); setMicInterim('') }

    const next = [...messages, { role: 'student' as const, content: msg }]
    setMessages(next); setInput(''); setStreaming(true)
    abortRef.current?.abort(); abortRef.current = new AbortController()

    const conv = next.map(m => ({ role: m.role === 'tutor' ? 'assistant' : 'user', content: m.content }))
    let resp = ''
    setMessages(p => [...p, { role: 'tutor', content: '' }])

    const q = ttsEnabled ? makeQueue() : null

    try {
      await streamLearning(`/api/books/${bookId}/teachback/chat`, { section_id: sectionId, conversation: conv }, {
        onToken: t => {
          resp += t
          setMessages(p => { const u = [...p]; u[u.length - 1] = { role: 'tutor', content: resp }; return u })
          q?.push(t)
        },
      }, abortRef.current.signal)
      q?.flush()
    } catch {}
    finally { setStreaming(false) }
  }, [input, streaming, messages, bookId, sectionId, ttsEnabled, makeQueue])

  return (
    <div className="flex h-full flex-col">
      <div ref={chatRef} className="min-h-0 flex-1 overflow-y-auto px-1 pb-4">
        {!started ? (
          <div className="flex flex-col items-center justify-center py-16 text-center">
            <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-br from-indigo-500 to-fuchsia-500 text-white shadow-lg">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
            </div>
            <h3 className="text-lg font-semibold text-slate-100">Teach Back</h3>
            <p className="mt-2 max-w-sm text-sm text-slate-400">I'll ask you deep questions about this section. Answer by typing or speaking. I'll analyze your understanding and find gaps.</p>
            <div className="mt-4 flex items-center gap-3 text-xs text-slate-500">
              <span>🔊 TTS: {ttsEnabled ? 'On' : 'Off'}</span>
              <button onClick={() => setTtsEnabled(v => !v)} className="btn-ghost btn-sm">Toggle</button>
              {ttsEnabled && lang.startsWith('ar') && (
                <button onClick={() => setTtsQuality(v => v === 'fast' ? 'high' : 'fast')}
                  className={`btn-ghost btn-sm ${ttsQuality === 'high' ? 'border-amber-500/50 bg-amber-500/10 text-amber-300' : ''}`}>
                  {ttsQuality === 'high' ? '⚡ High Quality' : '🏃 Fast'}
                </button>
              )}
            </div>
            <button onClick={startSession} className="mt-6 btn-primary">Start Session</button>
          </div>
        ) : (
          <div className="space-y-4">
            {messages.map((m, i) => (
              <div key={i} className={`flex ${m.role === 'student' ? 'justify-end' : 'justify-start'}`}>
                <div className={`max-w-[85%] rounded-2xl px-4 py-3 text-sm leading-relaxed ${m.role === 'student' ? 'bg-indigo-600/15 border border-indigo-500/10' : 'bg-white/[0.03] border border-white/[0.04] text-slate-200'}`}>
                  {m.role === 'tutor' ? (
                    <>
                      <Markdown text={m.content} />
                      {i === messages.length - 1 && streaming && <span className="ml-1 inline-block h-4 w-1.5 animate-pulse bg-indigo-400" />}
                      {i === messages.length - 1 && speaking && (
                        <button onClick={stopAll} className="ml-2 inline-block text-[11px] text-slate-500 hover:text-slate-300">🔇 stop</button>
                      )}
                    </>
                  ) : <p dir={isArabic(m.content) ? 'rtl' : 'ltr'}>{m.content}</p>}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {started && (
        <div className="shrink-0 border-t border-white/[0.06] p-3">
          <div className="mb-2 flex items-center gap-2">
            <select value={lang} onChange={e => setLang(e.target.value)} className="input">
              {LANGUAGES.map(l => <option key={l.code} value={l.code}>{l.flag} {l.label}</option>)}
            </select>

            <button type="button" onClick={toggleMic}
              className={`flex h-8 w-8 items-center justify-center rounded-full border transition ${micActive ? 'border-red-500/60 bg-red-500/20 text-red-400 animate-pulse' : 'border-white/[0.08] bg-white/[0.03] text-slate-400 hover:border-white/[0.12] hover:text-slate-300'}`}
              title={micActive ? 'Stop recording' : 'Start voice input'}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
                <path d="M19 10v2a7 7 0 0 1-14 0v-2" /><line x1="12" y1="19" x2="12" y2="22" />
              </svg>
            </button>

            {speaking && <button onClick={stopAll} className="flex h-8 w-8 items-center justify-center rounded-full border border-amber-500/40 bg-amber-500/15 text-amber-400 transition hover:bg-amber-500/25" title="Stop speaking">🔇</button>}
            {ttsPending > 0 && <span className="text-[10px] text-slate-600">{ttsPending} queued</span>}
            {micActive && micInterim && <span className="max-w-[40%] truncate text-[11px] italic text-indigo-400/60">{micInterim}</span>}
          </div>

          {micError && (
            <div className="mb-2 flex items-center gap-2 rounded-lg border border-amber-500/20 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-300">
              <span>🎤</span><span className="flex-1">{micError}</span>
              <button onClick={() => setMicError(null)} className="text-amber-400 hover:text-amber-300">✕</button>
            </div>
          )}

          <div className="flex gap-2">
            <input value={input} onChange={e => setInput(e.target.value)} onKeyDown={e => e.key === 'Enter' && !e.shiftKey && sendMessage()}
              dir={isArabic(input) ? 'rtl' : 'ltr'}
              placeholder={micActive ? '🎤 Listening...' : 'Type your answer or press 🎤 to speak...'}
              className="flex-1 input" />
            <button onClick={() => sendMessage()} disabled={!input.trim() || streaming}
              className="btn-primary disabled:opacity-50">
              {streaming ? '...' : 'Send'}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
