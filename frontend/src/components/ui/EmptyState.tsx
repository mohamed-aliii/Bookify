import type { ReactNode } from 'react'

interface Props {
  children: ReactNode
  className?: string
}

export default function EmptyState({ children, className = '' }: Props) {
  return (
    <div className={`flex flex-col items-center justify-center py-16 text-center ${className}`}>
      {children}
    </div>
  )
}

export function EmptyStateIcon({ children }: { children: ReactNode }) {
  return (
    <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-white/[0.03] text-3xl text-slate-600">
      {children}
    </div>
  )
}

export function EmptyStateTitle({ children }: { children: ReactNode }) {
  return <h3 className="text-sm font-medium text-slate-300">{children}</h3>
}

export function EmptyStateDescription({ children }: { children: ReactNode }) {
  return <p className="mt-1.5 max-w-sm text-xs text-slate-500 leading-relaxed">{children}</p>
}
