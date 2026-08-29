import { useCallback, useEffect, useState } from 'react'
import { api } from '../api'
import type { AppSettings } from '../types'
import AppShell from '../components/AppShell'
import Spinner from '../components/ui/Spinner'

type Tab = 'model' | 'search' | 'ingestion' | 'chat'

const TABS: { key: Tab; label: string }[] = [
  { key: 'model', label: 'AI Model' },
  { key: 'search', label: 'Web Search' },
  { key: 'ingestion', label: 'Ingestion' },
  { key: 'chat', label: 'Chat' },
]

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-xs font-medium text-slate-300">{label}</span>
      {children}
      {hint && <p className="mt-1.5 text-2xs text-slate-600 leading-relaxed">{hint}</p>}
    </label>
  )
}

function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors duration-200 ${checked ? 'bg-indigo-600' : 'bg-slate-700'}`}
    >
      <span className={`inline-block h-4 w-4 rounded-full bg-white shadow-sm transition-transform duration-200 ${checked ? 'translate-x-6' : 'translate-x-1'}`} />
    </button>
  )
}

export default function SettingsPage() {
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [tab, setTab] = useState<Tab>('model')
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [tavilyKeyDraft, setTavilyKeyDraft] = useState('')
  const [orKeyDraft, setOrKeyDraft] = useState('')

  useEffect(() => { api.getSettings().then(setSettings).catch((e) => setError(e.message)) }, [])

  const update = useCallback((patch: Partial<AppSettings>) => {
    setSettings((prev) => prev ? { ...prev, ...patch } : prev)
    setDirty(true); setSaved(false)
  }, [])

  const save = useCallback(async () => {
    if (!settings) return
    setSaving(true); setError(null)
    try {
      const payload: AppSettings & { tavily_api_key?: string; openrouter_api_key?: string } = { ...settings }
      if (tavilyKeyDraft) payload.tavily_api_key = tavilyKeyDraft
      if (orKeyDraft) payload.openrouter_api_key = orKeyDraft
      const updated = await api.updateSettings(payload)
      setSettings(updated); setDirty(false); setSaved(true); setTavilyKeyDraft(''); setOrKeyDraft('')
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) } finally { setSaving(false) }
  }, [settings, tavilyKeyDraft, orKeyDraft])

  const header = (
    <>
      <h1 className="text-sm font-semibold text-slate-200">Settings</h1>
      <div className="ml-auto flex items-center gap-3">
        {saved && <span className="text-2xs text-emerald-400">Saved</span>}
        {error && <span className="text-2xs text-red-400">{error}</span>}
        <button onClick={save} disabled={!dirty || saving} className="btn-primary btn-sm">
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
    </>
  )

  return (
    <AppShell header={header}>
      <div className="page-container max-w-3xl">
        <div className="mb-6 flex gap-1 rounded-xl bg-white/[0.02] p-1 border border-white/[0.04]">
          {TABS.map((t) => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={`flex-1 rounded-lg px-4 py-2.5 text-sm font-medium transition-all duration-200 ${
                tab === t.key ? 'bg-surface-3 text-white shadow-sm' : 'text-slate-500 hover:text-slate-300 hover:bg-white/[0.02]'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

        {!settings ? (
          <div className="py-16"><Spinner label="Loading settings…" /></div>
        ) : (
          <div className="card-surface space-y-5 p-6">
            {tab === 'model' && (
              <>
                <Field label="LLM Model">
                  <input type="text" value={settings.llm_model} onChange={(e) => update({ llm_model: e.target.value })} className="input" />
                </Field>
                <Field label="Temperature">
                  <div className="flex items-center gap-4">
                    <input type="range" min={0} max={2} step={0.1} value={settings.llm_temperature ?? 0.7} onChange={(e) => update({ llm_temperature: Number(e.target.value) })} className="flex-1" />
                    <span className="w-10 text-right text-sm font-medium text-slate-300 tabular-nums">{settings.llm_temperature ?? 'auto'}</span>
                  </div>
                </Field>
                <Field label="Max history messages">
                  <input type="number" value={settings.llm_max_history} min={0} max={50} onChange={(e) => update({ llm_max_history: Number(e.target.value) })} className="input" />
                </Field>
                <div className="flex items-center justify-between py-1">
                  <span className="text-xs font-medium text-slate-400">Enable reasoning / chain-of-thought</span>
                  <Toggle checked={settings.reasoning_enabled} onChange={(v) => update({ reasoning_enabled: v })} />
                </div>
                <Field label="OpenRouter API Key" hint={settings.openrouter_api_key_masked ? `Current: ${settings.openrouter_api_key_masked}. Type a new value to replace.` : undefined}>
                  <input type="password" value={orKeyDraft} onChange={(e) => { setOrKeyDraft(e.target.value); setDirty(true); setSaved(false) }} placeholder="sk-or-…" className="input" />
                </Field>
              </>
            )}

            {tab === 'search' && (
              <>
                <Field label="Search Provider">
                  <select value={settings.web_search_provider} onChange={(e) => update({ web_search_provider: e.target.value })} className="input">
                    <option value="tavily">Tavily (1,000 free credits/mo)</option>
                    <option value="duckduckgo">DuckDuckGo (unlimited, free)</option>
                  </select>
                </Field>
                <Field label="Tavily API Key" hint={settings.tavily_api_key_masked ? `Current: ${settings.tavily_api_key_masked}. Type a new value to replace.` : undefined}>
                  <div className="flex gap-2">
                    <input type="password" value={tavilyKeyDraft} onChange={(e) => { setTavilyKeyDraft(e.target.value); setDirty(true); setSaved(false) }} placeholder="tvly-…" className="input flex-1" />
                    <a href="https://app.tavily.com" target="_blank" rel="noreferrer" className="btn-secondary btn-sm shrink-0">Get key</a>
                  </div>
                </Field>
                <Field label="Search Depth">
                  <select value={settings.tavily_search_depth} onChange={(e) => update({ tavily_search_depth: e.target.value })} className="input">
                    <option value="fast">Fast (1 credit, lowest latency)</option>
                    <option value="basic">Basic (1 credit, balanced)</option>
                    <option value="advanced">Advanced (2 credits, highest relevance)</option>
                  </select>
                </Field>
                <Field label="Max results per search">
                  <input type="number" value={settings.web_max_results} min={1} max={20} onChange={(e) => update({ web_max_results: Number(e.target.value) })} className="input" />
                </Field>
                <div className="flex items-center justify-between py-1">
                  <div>
                    <span className="text-xs font-medium text-slate-400">Query expansion</span>
                    <p className="text-2xs text-slate-600">LLM sub-query decomposition for better recall</p>
                  </div>
                  <Toggle checked={settings.web_query_expansion} onChange={(v) => update({ web_query_expansion: v })} />
                </div>
                <div className="flex items-center justify-between py-1">
                  <div>
                    <span className="text-xs font-medium text-slate-400">Relevance filter</span>
                    <p className="text-2xs text-slate-600">LLM scoring before passing to context (1 extra call)</p>
                  </div>
                  <Toggle checked={settings.web_relevance_filter} onChange={(v) => update({ web_relevance_filter: v })} />
                </div>
              </>
            )}

            {tab === 'ingestion' && (
              <>
                <Field label="Chunk size (characters)">
                  <input type="number" value={settings.chunk_chars} min={400} max={5000} step={100} onChange={(e) => update({ chunk_chars: Number(e.target.value) })} className="input" />
                </Field>
                <Field label="Chunk overlap (characters)">
                  <input type="number" value={settings.chunk_overlap} min={0} max={1000} step={50} onChange={(e) => update({ chunk_overlap: Number(e.target.value) })} className="input" />
                </Field>
                <Field label="Top-K retrieval">
                  <input type="number" value={settings.top_k} min={1} max={20} onChange={(e) => update({ top_k: Number(e.target.value) })} className="input" />
                </Field>
                <Field label="Min heading font ratio">
                  <input type="number" value={settings.min_heading_ratio} min={1.0} max={2.0} step={0.01} onChange={(e) => update({ min_heading_ratio: Number(e.target.value) })} className="input" />
                </Field>
                <Field label="Max TOC level">
                  <input type="number" value={settings.max_toc_level} min={1} max={4} onChange={(e) => update({ max_toc_level: Number(e.target.value) })} className="input" />
                </Field>
              </>
            )}

            {tab === 'chat' && (
              <Field label="Web fallback distance threshold" hint="When retrieval cosine distance exceeds this, fall back to web. Lower = more aggressive.">
                <div className="flex items-center gap-4">
                  <input type="range" min={0.3} max={0.9} step={0.05} value={settings.web_fallback_distance} onChange={(e) => update({ web_fallback_distance: Number(e.target.value) })} className="flex-1" />
                  <span className="w-10 text-right text-sm font-medium text-slate-300 tabular-nums">{settings.web_fallback_distance}</span>
                </div>
              </Field>
            )}
          </div>
        )}
      </div>
    </AppShell>
  )
}
