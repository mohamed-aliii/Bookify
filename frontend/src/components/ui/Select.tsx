import { useState, useRef, useEffect, useCallback } from 'react'

interface SelectOption {
  value: number | string
  label: string
  disabled?: boolean
}

interface Props {
  value: number | string
  onChange: (value: number | string) => void
  options: SelectOption[]
  placeholder?: string
  className?: string
  disabled?: boolean
}

export default function Select({ value, onChange, options, placeholder, className = '', disabled }: Props) {
  const [open, setOpen] = useState(false)
  const [highlighted, setHighlighted] = useState(-1)
  const ref = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  const selected = options.find(o => o.value === value)

  const close = useCallback(() => { setOpen(false); setHighlighted(-1) }, [])

  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) close()
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [close])

  useEffect(() => {
    if (open && highlighted >= 0 && listRef.current) {
      const el = listRef.current.children[highlighted] as HTMLElement
      el?.scrollIntoView({ block: 'nearest' })
    }
  }, [highlighted, open])

  const handleKey = (e: React.KeyboardEvent) => {
    if (!open) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpen(true) }
      if (e.key === 'ArrowDown') { e.preventDefault(); setOpen(true) }
      return
    }

    const enabled = options.filter(o => !o.disabled)
    const idx = enabled.findIndex(o => o.value === value)

    if (e.key === 'Escape') { close(); return }
    if (e.key === 'ArrowDown') { e.preventDefault(); setHighlighted(h => Math.min(h + 1, enabled.length - 1)); return }
    if (e.key === 'ArrowUp') { e.preventDefault(); setHighlighted(h => Math.max(h - 1, 0)); return }
    if (e.key === 'Enter') {
      e.preventDefault()
      if (highlighted >= 0 && enabled[highlighted]) {
        onChange(enabled[highlighted].value)
      }
      close()
      return
    }

    // Type-ahead
    const char = e.key.toLowerCase()
    const match = enabled.find((o, i) => i > idx && String(o.label).toLowerCase().startsWith(char))
    if (match) { onChange(match.value); setHighlighted(enabled.indexOf(match)) }
  }

  return (
    <div ref={ref} className={`relative ${className}`}>
      <button
        type="button"
        onClick={() => !disabled && setOpen(!open)}
        onKeyDown={handleKey}
        disabled={disabled}
        className={`
          flex w-full items-center justify-between gap-2 rounded-xl border px-3.5 py-2.5 text-sm
          transition-all duration-200
          ${open
            ? 'border-indigo-500/60 bg-surface-2 shadow-glow-indigo'
            : 'border-slate-700/80 bg-surface-2 hover:border-slate-600'
          }
          ${disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}
          text-left
        `}
      >
        <span className={`truncate ${selected ? 'text-slate-100' : 'text-slate-600'}`}>
          {selected?.label ?? placeholder ?? 'Select...'}
        </span>
        <svg
          viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
          className={`h-4 w-4 shrink-0 text-slate-500 transition-transform duration-200 ${open ? 'rotate-180' : ''}`}
        >
          <path d="M6 9l6 6 6-6" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
      </button>

      {open && (
        <div
          ref={listRef}
          className="absolute z-50 mt-1.5 w-full max-h-60 overflow-auto rounded-xl border border-white/[0.08] bg-surface-2 p-1 shadow-glass animate-scale-in"
        >
          {options.map((option, i) => {
            if (option.disabled) return null
            const isSelected = option.value === value
            return (
              <button
                key={option.value}
                type="button"
                onClick={() => { onChange(option.value); close() }}
                onMouseEnter={() => setHighlighted(i)}
                className={`
                  flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm transition-colors duration-100
                  ${isSelected ? 'bg-indigo-500/10 text-indigo-400' : highlighted === i ? 'bg-white/[0.04] text-slate-100' : 'text-slate-300'}
                `}
              >
                <span className="truncate">{option.label}</span>
                {isSelected && (
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="ml-auto h-3.5 w-3.5 shrink-0 text-indigo-400">
                    <path d="M5 12l5 5L20 7" strokeLinecap="round" strokeLinejoin="round"/>
                  </svg>
                )}
              </button>
            )
          })}
          {options.filter(o => !o.disabled).length === 0 && (
            <div className="px-3 py-4 text-center text-xs text-slate-600">No options</div>
          )}
        </div>
      )}
    </div>
  )
}
