import { useEffect, useState } from 'react'
import type { Book, Dashboard } from '../types'
import { api } from '../api'

export default function MasteryLeaderboard() {
  const [books, setBooks] = useState<Book[]>([])
  const [dashboard, setDashboard] = useState<Dashboard | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    Promise.all([api.listBooks(), api.getDashboard()]).then(([bks, dash]) => { setBooks(bks); setDashboard(dash) }).catch(() => {}).finally(() => setLoading(false))
  }, [])

  const statsByBook = new Map((dashboard?.books ?? []).map(d => [d.id, d]))
  const ranked = books.filter(b => b.status === 'ready').map(b => {
    const s = statsByBook.get(b.id)
    const total = s?.cards_total ?? 0
    const mastered = s?.cards_mastered ?? 0
    return { ...b, total, mastered, pct: total > 0 ? mastered / total : 0 }
  }).sort((a, b) => b.pct - a.pct || b.total - a.total)

  const rankColor = (i: number) => i === 0 ? 'text-amber-400' : i === 1 ? 'text-slate-300' : i === 2 ? 'text-amber-600' : 'text-slate-500'
  const rankBg = (i: number) => i === 0 ? 'bg-amber-500/10' : i === 1 ? 'bg-slate-400/10' : i === 2 ? 'bg-amber-700/10' : 'bg-white/[0.02]'

  return (
    <div className="card p-6">
      <h3 className="section-title mb-4">Mastery Leaderboard</h3>
      {loading ? (
        <div className="py-8 text-center text-xs text-slate-500">Loading…</div>
      ) : ranked.length === 0 ? (
        <div className="py-8 text-center text-xs text-slate-500">No books indexed yet.</div>
      ) : (
        <div className="space-y-2">
          {ranked.map((b, i) => (
            <div key={b.id} className={`flex items-center gap-3 rounded-xl px-4 py-3 transition-colors duration-150 hover:bg-white/[0.02] ${rankBg(i)}`}>
              <span className={`w-6 text-center text-sm font-bold ${rankColor(i)}`}>{i + 1}</span>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-slate-200 truncate">{b.title}</p>
                <p className="text-2xs text-slate-500">{b.mastered}/{b.total} cards mastered</p>
              </div>
              <div className="w-24 shrink-0">
                <div className="h-2 rounded-full bg-slate-800 overflow-hidden">
                  <div className="h-full rounded-full bg-indigo-500 transition-all duration-500" style={{ width: `${Math.round(b.pct * 100)}%` }} />
                </div>
              </div>
              <span className="w-12 text-right text-xs font-medium text-slate-400">{Math.round(b.pct * 100)}%</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
