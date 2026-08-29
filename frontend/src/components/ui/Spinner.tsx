interface Props {
  label?: string
  size?: 'sm' | 'md' | 'lg'
  className?: string
}

export default function Spinner({ label, size = 'md', className = '' }: Props) {
  const sizeMap = { sm: 'h-4 w-4', md: 'h-6 w-6', lg: 'h-8 w-8' }
  const thickness = size === 'sm' ? 'border-2' : 'border-[2.5px]'

  return (
    <div className={`flex items-center gap-3 ${className}`}>
      <div className={`${sizeMap[size]} animate-spin rounded-full ${thickness} border-slate-600 border-t-indigo-400`} />
      {label && <span className="text-xs text-slate-400">{label}</span>}
    </div>
  )
}
