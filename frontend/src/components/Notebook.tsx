import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react'
import CodeMirror from '@uiw/react-codemirror'
import { python } from '@codemirror/lang-python'
import { EditorView } from '@codemirror/view'
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { tags } from '@lezer/highlight'
import { api } from '../api'
import Markdown from './Markdown'
import type { Notebook as NotebookData, NotebookCell } from '../types'

const COLAB_DARK_BG = '#1e1e1e'

const pythonHighlight = HighlightStyle.define([
  { tag: tags.keyword, color: '#c586c0' },
  { tag: tags.operator, color: '#d4d4d4' },
  { tag: tags.string, color: '#ce9178' },
  { tag: tags.comment, color: '#6a9955' },
  { tag: tags.number, color: '#b5cea8' },
  { tag: tags.function(tags.variableName), color: '#dcdcaa' },
  { tag: tags.className, color: '#4ec9b0' },
  { tag: tags.bool, color: '#569cd6' },
  { tag: tags.null, color: '#569cd6' },
])

const cmExtensions = [python(), syntaxHighlighting(pythonHighlight)]
const cmTheme = EditorView.theme({
  '&': { backgroundColor: 'transparent', fontSize: '13px', color: '#d4d4d4' },
  '.cm-content': { fontFamily: "'JetBrains Mono','Fira Code',monospace", padding: '8px 0' },
  '.cm-line': { padding: '0 12px' },
  '&.cm-focused': { outline: 'none' },
  '.cm-gutters': { backgroundColor: 'transparent', borderRight: '0', color: '#5c6370' },
  '.cm-activeLineGutter': { backgroundColor: 'transparent' },
  '.cm-activeLine': { backgroundColor: 'transparent' },
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': { backgroundColor: 'rgba(66,133,244,0.25)' },
})
const cmSetup = {
  lineNumbers: true,
  foldGutter: false,
  highlightActiveLine: false,
  highlightActiveLineGutter: false,
  autocompletion: true,
}

interface NotebookProps {
  bookId: number
  sectionId?: number
  focus?: { seq: number; cellId: number } | null
}

export interface NotebookHandle {
  focusCell: (cellId: number) => void
}

interface Command {
  id: string
  label: string
  shortcut?: string
  run: () => void
}

const SNIPPETS: { title: string; code: string }[] = [
  {
    title: 'List comprehension',
    code: 'squares = [x**2 for x in range(10)]\nprint(squares)',
  },
  {
    title: 'Time a function',
    code: 'import timeit\nprint(timeit.timeit("sum(range(1000))", number=1000))',
  },
  {
    title: 'Matplotlib plot',
    code: 'import matplotlib.pyplot as plt\nplt.plot([1, 2, 3], [2, 4, 1])\nplt.title("Sample")\nplt.show()',
  },
  {
    title: 'Read CSV (pandas-like)',
    code: '# Simulated data\ndata = {"name": ["a", "b"], "value": [1, 2]}\nprint(data)',
  },
]

function fmtElapsed(ms: number): string {
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`
  return `${ms}ms`
}

export default forwardRef<NotebookHandle, NotebookProps>(function Notebook({ bookId, sectionId, focus }, ref) {
  const [notebook, setNotebook] = useState<NotebookData | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [runningIds, setRunningIds] = useState<Set<number>>(new Set())
  const cellRefs = useRef<Map<number, HTMLDivElement>>(new Map())

  const [paletteOpen, setPaletteOpen] = useState(false)
  const [snippetsOpen, setSnippetsOpen] = useState(false)
  const [varsOpen, setVarsOpen] = useState(false)
  const [runtimeOpen, setRuntimeOpen] = useState(false)
  const [activeCellId, setActiveCellId] = useState<number | null>(null)
  const [editingMarkdownId, setEditingMarkdownId] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)

  const refetch = useCallback(() => {
    return sectionId !== undefined
      ? api.getSectionNotebook(bookId, sectionId)
      : api.getNotebook(bookId)
  }, [bookId, sectionId])

  const load = useCallback(async () => {
    setLoading(true)
    setLoadError(null)
    try {
      const data = await refetch()
      setNotebook(data)
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [refetch])

  useEffect(() => { void load() }, [load])

  const focusCell = useCallback((cellId: number) => {
    const el = cellRefs.current.get(cellId)
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }, [])

  useImperativeHandle(ref, () => ({ focusCell }), [focusCell])

  useEffect(() => {
    if (notebook && focus) {
      const target = notebook.cells.find((c) => c.id === focus.cellId)
      if (target) {
        setActiveCellId(focus.cellId)
        focusCell(focus.cellId)
      }
    }
  }, [focus, notebook, focusCell])

  const patchCell = (cellId: number, patch: Partial<NotebookCell>) => {
    setNotebook((prev) => prev ? { ...prev, cells: prev.cells.map((c) => c.id === cellId ? { ...c, ...patch } : c) } : prev)
  }

  const setCells = (cells: NotebookCell[]) =>
    setNotebook((prev) => prev ? { ...prev, cells } : prev)

  const updateSource = (cellId: number, source: string) =>
    setNotebook((prev) => prev ? { ...prev, cells: prev.cells.map((c) => c.id === cellId ? { ...c, source } : c) } : prev)

  const handleRun = async (cellId: number) => {
    if (!notebook) return
    setRunningIds((s) => new Set(s).add(cellId))
    try {
      const result = await api.runNotebookCell(notebook.id, cellId)
      patchCell(cellId, {
        output: result.output,
        error: result.error,
        status: result.status,
        execution_count: result.execution_count,
        elapsed_ms: result.elapsed_ms,
        images: result.images ?? [],
        variables: result.variables ?? [],
      })
      if (result.error) setError(result.error)
    } catch (e) {
      patchCell(cellId, { status: 'error', error: e instanceof Error ? e.message : String(e) })
    } finally {
      setRunningIds((s) => { const n = new Set(s); n.delete(cellId); return n })
    }
  }

  const insertCell = async (cellType: 'code' | 'markdown', source = '', afterCellId?: number): Promise<NotebookCell | null> => {
    if (!notebook) return null
    try {
      const cell = await api.addNotebookCell(notebook.id, source, cellType, afterCellId)
      const fresh = await refetch()
      setCells(fresh.cells)
      setActiveCellId(cell.id)
      return cell
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      return null
    }
  }

  const handleAddCell = async (cellType: 'code' | 'markdown' = 'code', afterCellId?: number) => {
    await insertCell(cellType, '', afterCellId)
  }

  const handleSave = async (cellId: number, source: string) => {
    if (!notebook) return
    try {
      await api.updateNotebookCell(notebook.id, cellId, source)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const handleToggleType = async (cellId: number, target: 'code' | 'markdown') => {
    if (!notebook) return
    const cell = notebook.cells.find((c) => c.id === cellId)
    if (!cell || cell.cell_type === target) { setEditingMarkdownId(target === 'markdown' ? cellId : null); return }
    try {
      const updated = await api.updateNotebookCell(notebook.id, cellId, undefined, target)
      patchCell(cellId, { cell_type: updated.cell_type })
      if (target === 'markdown') setEditingMarkdownId(cellId)
      else setEditingMarkdownId(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const handleDelete = async (cellId: number) => {
    if (!notebook) return
    try {
      await api.deleteNotebookCell(notebook.id, cellId)
      const rest = notebook.cells.filter((c) => c.id !== cellId)
      setCells(rest)
      if (activeCellId === cellId) {
        const next = rest[0] ?? null
        setActiveCellId(next ? next.id : null)
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const handleMove = async (cellId: number, direction: 'up' | 'down') => {
    if (!notebook) return
    try {
      await api.moveNotebookCell(notebook.id, cellId, direction)
      const fresh = await refetch()
      setCells(fresh.cells)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const handleDuplicate = async (cellId: number) => {
    if (!notebook) return
    try {
      const dup = await api.duplicateNotebookCell(notebook.id, cellId)
      const fresh = await refetch()
      setCells(fresh.cells)
      setActiveCellId(dup.id)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const handleRunAll = async () => {
    if (!notebook) return
    setRunningIds(new Set(notebook.cells.filter((c) => c.cell_type === 'code').map((c) => c.id)))
    try {
      const cells = await api.runAllNotebookCells(notebook.id)
      setCells(cells.map((c) => ({ ...c, images: c.images ?? [], variables: c.variables ?? [] })))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setRunningIds(new Set())
    }
  }

  const handleRunAbove = async (cellId: number) => {
    if (!notebook) return
    try {
      await api.runAboveNotebookCell(notebook.id, cellId)
      const fresh = await refetch()
      setCells(fresh.cells.map((c) => ({ ...c, images: c.images ?? [], variables: c.variables ?? [] })))
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
  }

  const handleRunBelow = async (cellId: number) => {
    if (!notebook) return
    try {
      await api.runBelowNotebookCell(notebook.id, cellId)
      const fresh = await refetch()
      setCells(fresh.cells.map((c) => ({ ...c, images: c.images ?? [], variables: c.variables ?? [] })))
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
  }

  const handleRestart = async (runAll: boolean) => {
    if (!notebook) return
    try {
      if (runAll) {
        const cells = await api.restartNotebook(notebook.id)
        if (cells) setCells(cells.map((c) => ({ ...c, images: c.images ?? [], variables: c.variables ?? [] })))
        else { const fresh = await refetch(); setCells(fresh.cells) }
      } else {
        await api.resetNotebook(notebook.id)
        const fresh = await refetch()
        setCells(fresh.cells.map((c) => ({ ...c, status: 'idle', output: null, error: null, images: [], variables: [] })))
      }
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
  }

  const insertSnippet = async (snippet: { title: string; code: string }) => {
    await insertCell('code', snippet.code, activeCellId ?? undefined)
    setSnippetsOpen(false)
  }

  const commandList = useMemo<Command[]>(() => [
    { id: 'run', label: 'Run cell', shortcut: 'Ctrl+Enter', run: () => { if (activeCellId != null) void handleRun(activeCellId) } },
    { id: 'run-all', label: 'Run all cells', run: () => void handleRunAll() },
    { id: 'run-above', label: 'Run above', run: () => { if (activeCellId != null) void handleRunAbove(activeCellId) } },
    { id: 'run-below', label: 'Run below', run: () => { if (activeCellId != null) void handleRunBelow(activeCellId) } },
    { id: 'add-code', label: 'Insert code cell', shortcut: 'B', run: () => void handleAddCell('code', activeCellId ?? undefined) },
    { id: 'add-md', label: 'Insert markdown cell', shortcut: 'M', run: () => void handleAddCell('markdown', activeCellId ?? undefined) },
    { id: 'dup', label: 'Duplicate cell', run: () => { if (activeCellId != null) void handleDuplicate(activeCellId) } },
    { id: 'del', label: 'Delete cell', run: () => { if (activeCellId != null) void handleDelete(activeCellId) } },
    { id: 'restart', label: 'Restart runtime', run: () => { void handleRestart(false) } },
    { id: 'restart-run', label: 'Restart & run all', run: () => { void handleRestart(true) } },
    { id: 'snippets', label: 'Insert snippet', run: () => setSnippetsOpen(true) },
    { id: 'vars', label: 'Toggle variable explorer', run: () => setVarsOpen((v) => !v) },
  ], [activeCellId])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey
      if (mod && e.shiftKey && e.code === 'KeyP') {
        e.preventDefault()
        setPaletteOpen((v) => !v)
        return
      }
      if (paletteOpen || snippetsOpen || runtimeOpen) return
      const editable = (e.target as HTMLElement)?.closest?.('textarea, [contenteditable], .cm-content')
      if (mod) return
      if (editable) {
        if (e.key === 'Enter' && !editable.closest?.('.cm-content')) return
        if (e.code === 'Enter' || e.key === 'Enter') { e.preventDefault(); if (activeCellId != null) void handleRun(activeCellId); return }
        return
      }
      if (e.code === 'Enter') { e.preventDefault(); if (activeCellId != null) void handleRun(activeCellId) }
      else if (e.key === 'b' || e.key === 'B') { e.preventDefault(); void handleAddCell('code', activeCellId ?? undefined) }
      else if (e.key === 'm' || e.key === 'M') { e.preventDefault(); void handleAddCell('markdown', activeCellId ?? undefined) }
      else if (e.key === 'y' || e.key === 'Y') { e.preventDefault(); if (activeCellId != null) void handleToggleType(activeCellId, 'markdown') }
      else if (e.key === 'd' || e.key === 'D') { e.preventDefault(); if (activeCellId != null) void handleDuplicate(activeCellId) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [paletteOpen, snippetsOpen, runtimeOpen, activeCellId])

  const latestVariables = useMemo(() => {
    if (!notebook) return []
    for (let i = notebook.cells.length - 1; i >= 0; i--) {
      const c = notebook.cells[i]
      if (c.cell_type === 'code' && c.variables && c.variables.length) return c.variables
    }
    return []
  }, [notebook])

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center" style={{ background: COLAB_DARK_BG }}>
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-slate-600 border-t-blue-500" />
      </div>
    )
  }

  if (!notebook) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-sm text-slate-400" style={{ background: COLAB_DARK_BG }}>
        <span>Could not load notebook.</span>
        {loadError && <span className="max-w-md text-center text-xs text-red-400">{loadError}</span>}
        <button
          onClick={() => void load()}
          className="rounded-lg border border-slate-600 px-3 py-1.5 text-xs font-medium text-slate-200 transition-colors hover:bg-white/10"
        >
          Retry
        </button>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col" style={{ background: '#141414' }}>
      {/* Colab-style toolbar */}
      <div className="flex shrink-0 items-center justify-between border-b border-white/10 px-5 py-1.5" style={{ background: '#202124' }}>
        <div className="flex items-center gap-4">
          <span className="text-[13px] font-medium text-slate-200">Python Notebook</span>
          <div className="relative">
            <button
              onClick={() => setRuntimeOpen((v) => !v)}
              className="rounded px-2 py-1 text-xs text-slate-300 transition-colors hover:bg-white/10"
            >
              Runtime ▾
            </button>
            {runtimeOpen && (
              <div className="absolute left-0 top-full z-50 mt-1 w-56 rounded-md border border-white/10 bg-[#292a2d] py-1 shadow-xl">
                {[
                  { label: 'Run all', run: () => void handleRunAll() },
                  { label: 'Run above', run: () => { if (activeCellId != null) void handleRunAbove(activeCellId) } },
                  { label: 'Run below', run: () => { if (activeCellId != null) void handleRunBelow(activeCellId) } },
                  { label: 'Restart runtime', run: () => void handleRestart(false) },
                  { label: 'Restart & run all', run: () => void handleRestart(true) },
                ].map((item) => (
                  <button
                    key={item.label}
                    onClick={() => { setRuntimeOpen(false); item.run() }}
                    className="block w-full px-3 py-1.5 text-left text-xs text-slate-200 hover:bg-white/10"
                  >
                    {item.label}
                  </button>
                ))}
              </div>
            )}
          </div>
          <button onClick={() => setSnippetsOpen((v) => !v)} className="rounded px-2 py-1 text-xs text-slate-300 transition-colors hover:bg-white/10">
            Snippets
          </button>
          <button onClick={() => setVarsOpen((v) => !v)} className="rounded px-2 py-1 text-xs text-slate-300 transition-colors hover:bg-white/10">
            Variables
          </button>
        </div>
        <div className="flex items-center gap-3">
          <span className="flex items-center gap-1.5 text-[11px] text-slate-400">
            <span className="h-2 w-2 rounded-full bg-green-500" />
            {runningIds.size > 0 ? 'busy' : 'connected'}
          </span>
          <button
            onClick={() => setPaletteOpen(true)}
            className="rounded border border-white/10 px-2 py-1 text-xs text-slate-400 transition-colors hover:bg-white/10"
            title="Command palette (Ctrl+Shift+P)"
          >
            ⌘
          </button>
        </div>
      </div>

      {/* Snippets panel */}
      {snippetsOpen && (
        <div className="shrink-0 border-b border-white/10 bg-[#1a1a1a] px-5 py-3">
          <div className="mb-2 text-xs font-medium uppercase tracking-wider text-slate-500">Snippets</div>
          <div className="flex flex-wrap gap-2">
            {SNIPPETS.map((s) => (
              <button
                key={s.title}
                onClick={() => void insertSnippet(s)}
                className="rounded-md border border-white/10 bg-white/[0.03] px-3 py-1.5 text-xs text-slate-200 transition-colors hover:bg-white/10"
              >
                {s.title}
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        {/* Cells */}
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="flex w-full flex-col px-6 py-5">
            {error && (
              <div className="mb-3 flex items-center justify-between rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-400">
                <span className="break-all">{error}</span>
                <button onClick={() => setError(null)} className="ml-3 text-red-300 hover:text-red-200">✕</button>
              </div>
            )}
            {notebook.cells.length === 0 && (
              <div className="flex flex-col items-center gap-3 py-16 text-center text-slate-500">
                <p className="max-w-sm text-sm">No cells yet. Select text in the book and press <span className="font-medium text-slate-200">Code</span>, or add a cell.</p>
                <button
                  onClick={() => void handleAddCell('code')}
                  className="rounded-md bg-blue-600 px-4 py-1.5 text-xs font-medium text-white transition-colors hover:bg-blue-500"
                >
                  + Code cell
                </button>
              </div>
            )}
            <div className="flex flex-col">
              {notebook.cells.map((cell, idx) => (
                <Cell
                  key={cell.id}
                  cell={cell}
                  running={runningIds.has(cell.id)}
                  active={activeCellId === cell.id}
                  registerRef={(el) => { if (el) cellRefs.current.set(cell.id, el); else cellRefs.current.delete(cell.id) }}
                  onFocusCell={() => setActiveCellId(cell.id)}
                  editingMarkdown={editingMarkdownId === cell.id}
                  onStartMarkdownEdit={() => setEditingMarkdownId(cell.id)}
                  onCancelMarkdownEdit={() => setEditingMarkdownId(null)}
                  onSourceChange={updateSource}
                  onRun={() => void handleRun(cell.id)}
                  onSave={handleSave}
                  onToggleType={(t) => void handleToggleType(cell.id, t)}
                  onMoveUp={() => void handleMove(cell.id, 'up')}
                  onMoveDown={() => void handleMove(cell.id, 'down')}
                  onInsertAbove={() => void handleAddCell(cell.cell_type, idx > 0 ? notebook.cells[idx - 1].id : undefined)}
                  onInsertBelow={() => void handleAddCell(cell.cell_type, cell.id)}
                  onDuplicate={() => void handleDuplicate(cell.id)}
                  onDelete={() => void handleDelete(cell.id)}
                />
              ))}
            </div>
            <button
              onClick={() => void handleAddCell('code')}
              className="mt-1 rounded-md py-1.5 pl-2.5 text-left font-mono text-sm text-slate-500 transition-colors hover:bg-white/5 hover:text-slate-300"
            >
              + &nbsp;
            </button>
          </div>
        </div>

        {/* Variable explorer */}
        {varsOpen && (
          <div className="w-72 shrink-0 overflow-y-auto border-l border-white/10 bg-[#181818] p-3">
            <div className="mb-2 text-xs font-medium uppercase tracking-wider text-slate-500">Variables</div>
            {latestVariables.length === 0 ? (
              <div className="text-xs text-slate-600">Run a cell to inspect variables.</div>
            ) : (
              <table className="w-full text-left text-xs">
                <thead>
                  <tr className="text-slate-500">
                    <th className="pb-1 font-medium">Name</th>
                    <th className="pb-1 font-medium">Value</th>
                  </tr>
                </thead>
                <tbody>
                  {latestVariables.map((v) => (
                    <tr key={v.name} className="border-t border-white/5">
                      <td className="py-1 pr-2 font-mono text-slate-300">{v.name}</td>
                      <td className="py-1 font-mono text-slate-400">
                        <span className="mr-1 rounded bg-white/5 px-1 text-[10px] text-slate-500">{v.type}</span>
                        <span className="break-all">{v.value}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}
      </div>

      {/* Command palette */}
      {paletteOpen && (
        <CommandPalette
          commands={commandList}
          onClose={() => setPaletteOpen(false)}
        />
      )}
    </div>
  )
})

function CommandPalette({ commands, onClose }: { commands: Command[]; onClose: () => void }) {
  const [query, setQuery] = useState('')
  const filtered = commands.filter((c) => c.label.toLowerCase().includes(query.toLowerCase()))
  const inputRef = useRef<HTMLInputElement>(null)
  useEffect(() => { inputRef.current?.focus() }, [])
  return (
    <div className="fixed inset-0 z-[100] flex items-start justify-center bg-black/50 pt-24" onClick={onClose}>
      <div className="w-[480px] overflow-hidden rounded-lg border border-white/10 bg-[#202124] shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Type a command…"
          className="w-full border-b border-white/10 bg-transparent px-4 py-3 text-sm text-slate-100 outline-none placeholder:text-slate-500"
        />
        <div className="max-h-80 overflow-y-auto py-1">
          {filtered.map((c) => (
            <button
              key={c.id}
              onClick={() => { c.run(); onClose() }}
              className="flex w-full items-center justify-between px-4 py-2 text-left text-sm text-slate-200 hover:bg-white/10"
            >
              <span>{c.label}</span>
              {c.shortcut && <span className="text-xs text-slate-500">{c.shortcut}</span>}
            </button>
          ))}
          {filtered.length === 0 && <div className="px-4 py-2 text-sm text-slate-500">No commands</div>}
        </div>
      </div>
    </div>
  )
}

function Cell({
  cell,
  running,
  active,
  registerRef,
  onFocusCell,
  editingMarkdown,
  onStartMarkdownEdit,
  onCancelMarkdownEdit,
  onSourceChange,
  onRun,
  onSave,
  onToggleType,
  onMoveUp,
  onMoveDown,
  onInsertAbove,
  onInsertBelow,
  onDuplicate,
  onDelete,
}: {
  cell: NotebookCell
  running: boolean
  active: boolean
  registerRef: (el: HTMLDivElement | null) => void
  onFocusCell: () => void
  editingMarkdown: boolean
  onStartMarkdownEdit: () => void
  onCancelMarkdownEdit: () => void
  onSourceChange: (id: number, source: string) => void
  onRun: () => void
  onSave: (id: number, source: string) => void
  onToggleType: (target: 'code' | 'markdown') => void
  onMoveUp: () => void
  onMoveDown: () => void
  onInsertAbove: () => void
  onInsertBelow: () => void
  onDuplicate: () => void
  onDelete: () => void
}) {
  const saveTimer = useRef<number | null>(null)

  const handleChange = (value: string) => {
    onSourceChange(cell.id, value)
    if (saveTimer.current) window.clearTimeout(saveTimer.current)
    saveTimer.current = window.setTimeout(() => onSave(cell.id, value), 600)
  }

  useEffect(() => () => { if (saveTimer.current) window.clearTimeout(saveTimer.current) }, [])

  const isMd = cell.cell_type === 'markdown'
  const showOutput = cell.cell_type === 'code' && (cell.output || cell.status === 'error' || (cell.images && cell.images.length > 0))

  return (
    <div
      ref={registerRef}
      onClick={onFocusCell}
      className={`group relative border-l-4 px-0.5 transition-colors ${
        active ? 'border-indigo-500' : 'border-transparent focus-within:border-indigo-500/60'
      }`}
    >
      <div className="border border-transparent bg-transparent" style={{ background: '#141414' }}>
        {/* Control row */}
        <div className="flex items-center justify-between px-1 pt-0.5">
          <span className="font-mono text-sm text-slate-500">
            {isMd ? '' : running ? '[*]' : `[${cell.execution_count || ''}]`}
            {cell.cell_type === 'code' && cell.execution_count > 0 && (
              <span className="ml-1.5 text-[11px] text-slate-600">{fmtElapsed(cell.elapsed_ms)}</span>
            )}
          </span>
        </div>

        {/* Toolbar (hover) */}
        <div className="absolute right-1 top-0.5 z-10 flex items-center gap-0.5 rounded-md border border-white/10 bg-[#202124] px-1 py-0.5 opacity-0 shadow-lg transition-opacity group-hover:opacity-100">
          <button onClick={onRun} disabled={running || isMd || !cell.source.trim()} title="Run cell"
            className={`rounded p-1 disabled:opacity-30 ${running ? 'text-slate-400' : 'text-green-500 hover:bg-green-500/10'}`}>
            {running ? <span className="block h-4 w-4 animate-spin rounded-full border-2 border-slate-400 border-t-transparent" /> : <svg viewBox="0 0 24 24" fill="currentColor" className="h-4 w-4"><path d="M8 5v14l11-7z" /></svg>}
          </button>
          <button onClick={onMoveUp} title="Move up" className="rounded p-1 text-slate-400 hover:bg-white/10 hover:text-slate-200"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-3.5 w-3.5"><path d="M12 5v14M5 12l7-7 7 7" strokeLinecap="round" strokeLinejoin="round" /></svg></button>
          <button onClick={onMoveDown} title="Move down" className="rounded p-1 text-slate-400 hover:bg-white/10 hover:text-slate-200"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-3.5 w-3.5"><path d="M12 19V5M5 12l7 7 7-7" strokeLinecap="round" strokeLinejoin="round" /></svg></button>
          <button onClick={onInsertAbove} title="Insert cell above" className="rounded p-1 text-slate-400 hover:bg-white/10 hover:text-slate-200"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-3.5 w-3.5"><path d="M4 3h16M8 21h8M12 8v8" strokeLinecap="round" strokeLinejoin="round" /></svg></button>
          <button onClick={onInsertBelow} title="Insert cell below" className="rounded p-1 text-slate-400 hover:bg-white/10 hover:text-slate-200"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-3.5 w-3.5"><path d="M4 21h16M10 8v8M12 12" strokeLinecap="round" strokeLinejoin="round" /></svg></button>
          <button onClick={() => onToggleType(isMd ? 'code' : 'markdown')} title={isMd ? 'Convert to code (Y)' : 'Convert to markdown (Y)'} className="rounded p-1 text-slate-400 hover:bg-white/10 hover:text-slate-200">
            {isMd ? <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-3.5 w-3.5"><path d="M8 9l-3 3 3 3M16 9l3 3-3 3M13 6l-2 12" strokeLinecap="round" strokeLinejoin="round" /></svg> : <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-3.5 w-3.5"><path d="M15 7h3a2 2 0 012 2v6a2 2 0 01-2 2h-3M9 7H6a2 2 0 00-2 2v6a2 2 0 002 2h3" strokeLinecap="round" strokeLinejoin="round" /></svg>}
          </button>
          <button onClick={onDuplicate} title="Duplicate cell" className="rounded p-1 text-slate-400 hover:bg-white/10 hover:text-slate-200"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-3.5 w-3.5"><path d="M8 8h8m-8 4h8m-8 4h5M4 4h16v16H4z" strokeLinecap="round" strokeLinejoin="round" /></svg></button>
          <button onClick={onDelete} title="Delete cell" className="rounded p-1 text-slate-400 hover:bg-red-500/10 hover:text-red-400"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-3.5 w-3.5"><path d="M3 6h18M8 6V4a1 1 0 011-1h6a1 1 0 011 1v2m3 0v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6" strokeLinecap="round" strokeLinejoin="round" /></svg></button>
        </div>

        {/* Editor or markdown */}
        {isMd ? (
          editingMarkdown ? (
            <textarea
              value={cell.source}
              onChange={(e) => handleChange(e.target.value)}
              onBlur={onCancelMarkdownEdit}
              autoFocus
              placeholder="# Enter markdown…"
              className="w-full resize-y bg-transparent p-2 font-mono text-sm text-slate-200 outline-none placeholder:text-slate-600"
              rows={Math.max(2, Math.min(cell.source.split('\n').length + 1, 16))}
            />
          ) : (
            <div onClick={onStartMarkdownEdit} className="cursor-text px-2 py-1">
              {cell.source.trim() ? (
                <Markdown text={cell.source} />
              ) : (
                <span className="text-sm text-slate-600">Double-click to edit markdown</span>
              )}
            </div>
          )
        ) : (
          <div className="cursor-text" style={{ background: COLAB_DARK_BG }}>
            <CodeMirror
              value={cell.source}
              onChange={(v) => handleChange(v)}
              extensions={cmExtensions}
              theme={cmTheme}
              basicSetup={cmSetup}
              placeholder="# Enter Python code..."
              height="auto"
            />
          </div>
        )}

        {/* Output */}
        {showOutput && (
          <div className="mt-1 border-l-2 border-slate-700 bg-[#1a1a1a]">
            {cell.images && cell.images.length > 0 && (
              <div className="px-3 py-2">
                {cell.images.map((img, i) => (
                  <img
                    key={i}
                    src={`data:${img.mime};base64,${img.data}`}
                    alt="cell output"
                    className="max-w-full rounded border border-white/10"
                    style={{ width: img.width ? undefined : 'auto' }}
                  />
                ))}
              </div>
            )}
            {cell.output && (
              <pre className={`whitespace-pre-wrap px-3 py-2 font-mono text-[13px] leading-relaxed ${cell.status === 'error' ? 'text-red-400' : 'text-slate-300'}`}>
                {cell.output}
              </pre>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
