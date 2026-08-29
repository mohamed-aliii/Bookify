import { useEffect, useState } from 'react'
import { api } from '../api'
import type { BookDashboard, QuizError } from '../types'
import ErrorJournal from './ErrorJournal'

function Spinner({ label }: { label?: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-14">
      <div className="h-7 w-7 animate-spin rounded-full border-2 border-slate-600 border-t-indigo-400" />
      {label && <p className="text-xs text-slate-500">{label}</p>}
    </div>
  )
}

function StatCard({ label, value, sub, color }: { label: string; value: string | number; sub?: string; color: string }) {
  return (
    <div className="card p-5">
      <p className="text-2xs font-medium uppercase tracking-wider text-slate-500">{label}</p>
      <p className={`mt-1 text-2xl font-bold ${color}`}>{value}</p>
      {sub && <p className="mt-0.5 text-2xs text-slate-500">{sub}</p>}
    </div>
  )
}

function MasteryBar({ mastery }: { mastery: number }) {
  const pct = Math.round(mastery * 100)
  let color = 'bg-emerald-500/70'
  if (pct < 40) color = 'bg-red-500/70'
  else if (pct < 70) color = 'bg-amber-500/70'
  return (
    <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-slate-800/60">
      <div className={`h-full rounded-full transition-all ${color}`} style={{ width: `${pct}%` }} />
    </div>
  )
}

export default function ProgressTab({ bookId }: { bookId: number }) {
  const [dashboard, setDashboard] = useState<BookDashboard | null>(null)
  const [errors, setErrors] = useState<QuizError[] | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    Promise.all([api.getBookDashboard(bookId), api.getQuizErrors(bookId)])
      .then(([d, e]) => { setDashboard(d); setErrors(e) })
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [bookId])

  if (loading) return <Spinner label="Loading progress…" />
  if (!dashboard) return <div className="py-16 text-center text-sm text-slate-500">Could not load progress.</div>

  return (
    <div className="space-y-8">
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard
          label="Sections Read"
          value={`${dashboard.sections_read}/${dashboard.total_sections}`}
          sub={`${dashboard.read_percent}%`}
          color="text-emerald-400"
        />
        <StatCard
          label="Cards Mastered"
          value={`${dashboard.cards_mastered}/${dashboard.cards_total}`}
          sub={dashboard.cards_due > 0 ? `${dashboard.cards_due} due` : 'All caught up'}
          color="text-indigo-400"
        />
        <StatCard
          label="Quiz Average"
          value={dashboard.quiz_avg_score != null ? `${dashboard.quiz_avg_score}%` : '—'}
          sub={`${dashboard.total_quizzes} quizzes`}
          color="text-amber-400"
        />
        <StatCard
          label="KP Mastery"
          value={dashboard.kp_mastery_avg != null ? `${Math.round(dashboard.kp_mastery_avg * 100)}%` : '—'}
          sub="knowledge points"
          color="text-rose-400"
        />
      </div>

      {dashboard.chapter_progress.length > 0 && (
        <div>
          <h3 className="section-title mb-3">Chapter Progress</h3>
          <div className="space-y-2">
            {dashboard.chapter_progress.map((ch) => (
              <div key={ch.section_id} className="flex items-center gap-3 rounded-xl border border-white/[0.04] bg-white/[0.02] px-4 py-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className={`text-sm font-medium ${ch.read ? 'text-slate-200' : 'text-slate-500'}`}>
                      {ch.title}
                    </span>
                    {!ch.read && <span className="badge-neutral text-[10px]">unread</span>}
                  </div>
                  <div className="mt-1.5 flex items-center gap-2">
                    {ch.total_children > 0 && (
                      <span className="text-2xs text-slate-600">{ch.children_read}/{ch.total_children} subsections</span>
                    )}
                    {ch.cards_total > 0 && (
                      <span className="text-2xs text-slate-600">{ch.cards_mastered}/{ch.cards_total} cards</span>
                    )}
                    {ch.quiz_score != null && (
                      <span className="text-2xs text-slate-600">quiz {ch.quiz_score}%</span>
                    )}
                  </div>
                </div>
                {ch.mastery != null && (
                  <div className="flex w-28 items-center gap-2">
                    <MasteryBar mastery={ch.mastery} />
                    <span className="text-2xs tabular-nums text-slate-500">{Math.round(ch.mastery * 100)}%</span>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {dashboard.next_steps.length > 0 && (
        <div>
          <h3 className="section-title mb-3">What to do next</h3>
          <div className="space-y-2">
            {dashboard.next_steps.map((step, i) => (
              <div key={i} className="flex items-start gap-2 rounded-xl border border-white/[0.04] bg-white/[0.02] px-4 py-3">
                <span className="mt-0.5 text-indigo-400">→</span>
                <span className="text-sm text-slate-300">{step}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {dashboard.recent_activity.length > 0 && (
        <div>
          <h3 className="section-title mb-3">Recent Activity</h3>
          <div className="space-y-1">
            {dashboard.recent_activity.map((a, i) => (
              <div key={i} className="flex items-center gap-3 rounded-lg px-3 py-2 text-sm text-slate-400">
                <span className={`badge-${a.type === 'quiz' ? 'warning' : 'neutral'}`}>{a.type}</span>
                <span className="text-slate-300">{a.section}</span>
                {a.score && <span className="text-xs text-slate-500">{a.score}</span>}
                {a.preview && <span className="truncate text-xs text-slate-500">{a.preview}</span>}
              </div>
            ))}
          </div>
        </div>
      )}

      {errors && errors.length > 0 && <ErrorJournal errors={errors} />}
    </div>
  )
}
