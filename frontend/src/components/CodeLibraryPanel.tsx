import { useCallback, useEffect, useState } from 'react'
import { api } from '../api'
import type { CodeBlock, Section } from '../types'

function Spinner({ label }: { label?: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-14">
      <div className="h-7 w-7 animate-spin rounded-full border-2 border-slate-600 border-t-indigo-400" />
      {label && <p className="text-xs text-slate-500">{label}</p>}
    </div>
  )
}

export default function CodeLibraryPanel({
  bookId,
  sections,
  onSendToNotebook,
}: {
  bookId: number
  sections: Section[]
  onSendToNotebook: (sectionId: number) => void
}) {
  const [blocks, setBlocks] = useState<CodeBlock[]>([])
  const [loaded, setLoaded] = useState(false)
  const [extracting, setExtracting] = useState(false)
  const [sendingId, setSendingId] = useState<number | null>(null)
  const [copiedId, setCopiedId] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [info, setInfo] = useState<string | null>(null)

  const loadBlocks = useCallback(async () => {
    setLoaded(false)
    setError(null)
    try {
      setBlocks(await api.listCodeBlocks(bookId))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoaded(true)
    }
  }, [bookId])

  useEffect(() => {
    void loadBlocks()
  }, [loadBlocks])

  const extract = async () => {
    if (extracting) return
    setExtracting(true)
    setError(null)
    setInfo(null)
    try {
      const res = await api.extractCodeBlocks(bookId, true)
      if (res.message) setInfo(res.message)
      else setInfo(`Extraction complete: ${res.created ?? 0} code snippet(s) created.`)
      await loadBlocks()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setExtracting(false)
    }
  }

  const copyCode = async (block: CodeBlock) => {
    try {
      await navigator.clipboard.writeText(block.code)
      setCopiedId(block.id)
      setTimeout(() => setCopiedId((cur) => (cur === block.id ? null : cur)), 1500)
    } catch {
      setError('Copy not available in this browser.')
    }
  }

  const sendToNotebook = async (block: CodeBlock) => {
    if (sendingId !== null) return
    setSendingId(block.id)
    setError(null)
    try {
      const notebook = await api.getSectionNotebook(bookId, block.section_id)
      await api.addNotebookCell(notebook.id, block.code, 'code')
      onSendToNotebook(block.section_id)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSendingId(null)
    }
  }

  const grouped = sections
    .map((s) => ({ section: s, items: blocks.filter((b) => b.section_id === s.id) }))
    .filter((g) => g.items.length > 0)
  const stray = blocks.filter((b) => !sections.some((s) => s.id === b.section_id))

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto max-w-3xl px-5 py-6">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold text-slate-200">Code Library</h2>
            <p className="mt-0.5 text-xs text-slate-500">Reusable snippets extracted from this book, organized by section.</p>
          </div>
          <button onClick={() => void extract()} disabled={extracting} className="btn-primary">
            {extracting ? 'Extracting…' : 'Extract code'}
          </button>
        </div>

        {error && (
          <div className="mt-4 rounded-xl border border-red-500/20 bg-red-500/10 px-4 py-2.5 text-sm text-red-300">{error}</div>
        )}
        {info && (
          <div className="mt-4 rounded-xl border border-indigo-500/20 bg-indigo-500/10 px-4 py-2.5 text-sm text-indigo-300">{info}</div>
        )}

        {!loaded && <Spinner label="Loading code snippets…" />}

        {loaded && blocks.length === 0 && (
          <div className="mt-6 card-surface p-10 text-center">
            <p className="text-sm font-medium text-slate-300">No code snippets yet.</p>
            <p className="mt-1 text-xs text-slate-500">
              Click “Extract code” to scan the book's sections and pull out reusable examples.
            </p>
          </div>
        )}

        {loaded && blocks.length > 0 && (
          <div className="mt-6 space-y-8">
            {grouped.map(({ section, items }) => (
              <div key={section.id}>
                <div className="mb-2 text-[11px] font-medium uppercase tracking-wide text-slate-500">{section.title}</div>
                <ul className="space-y-3">
                  {items.map((block) => (
                    <li key={block.id} className="card overflow-hidden">
                      <div className="flex items-center gap-2 px-4 py-2.5">
                        <span className="rounded bg-indigo-500/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-indigo-300">{block.language}</span>
                        <p className="flex-1 text-xs leading-relaxed text-slate-300">{block.description}</p>
                        <button
                          onClick={() => void copyCode(block)}
                          className="rounded-md border border-white/[0.06] px-2 py-1 text-[11px] text-slate-400 transition hover:border-indigo-500/40 hover:text-slate-200"
                        >
                          {copiedId === block.id ? 'Copied' : 'Copy'}
                        </button>
                        <button
                          onClick={() => void sendToNotebook(block)}
                          disabled={sendingId !== null}
                          className="rounded-md border border-white/[0.06] px-2 py-1 text-[11px] text-indigo-300 transition hover:border-indigo-500/40"
                        >
                          {sendingId === block.id ? 'Sending…' : 'Open in notebook'}
                        </button>
                      </div>
                      <pre className="max-h-72 overflow-auto bg-black/40 px-4 py-3 text-xs leading-relaxed text-emerald-200/90">{block.code}</pre>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
            {stray.length > 0 && (
              <div>
                <div className="mb-2 text-[11px] font-medium uppercase tracking-wide text-slate-500">Section removed</div>
                <ul className="space-y-3">
                  {stray.map((block) => (
                    <li key={block.id} className="card overflow-hidden">
                      <div className="flex items-center gap-2 px-4 py-2.5">
                        <span className="rounded bg-indigo-500/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-indigo-300">{block.language}</span>
                        <p className="flex-1 text-xs leading-relaxed text-slate-300">{block.description}</p>
                      </div>
                      <pre className="max-h-72 overflow-auto bg-black/40 px-4 py-3 text-xs leading-relaxed text-emerald-200/90">{block.code}</pre>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
