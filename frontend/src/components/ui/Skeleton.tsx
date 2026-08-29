interface Props {
  lines?: number
  className?: string
}

export function SkeletonText({ lines = 3, className = '' }: Props) {
  return (
    <div className={`space-y-2.5 ${className}`}>
      {Array.from({ length: lines }).map((_, i) => (
        <div
          key={i}
          className="skeleton h-3.5 rounded-lg"
          style={{ width: i === lines - 1 ? '65%' : `${70 + Math.random() * 30}%` }}
        />
      ))}
    </div>
  )
}

export function SkeletonCard({ className = '' }: { className?: string }) {
  return (
    <div className={`card p-5 ${className}`}>
      <div className="flex items-start gap-4">
        <div className="skeleton h-16 w-12 shrink-0 rounded-xl" />
        <div className="flex-1 space-y-3">
          <div className="skeleton h-4 w-3/4 rounded-lg" />
          <div className="skeleton h-3 w-1/2 rounded-lg" />
          <div className="skeleton h-3 w-1/3 rounded-lg" />
        </div>
      </div>
    </div>
  )
}

export function SkeletonRow({ className = '' }: { className?: string }) {
  return (
    <div className={`flex items-center gap-3 ${className}`}>
      <div className="skeleton h-8 w-8 shrink-0 rounded-lg" />
      <div className="flex-1 space-y-2">
        <div className="skeleton h-3.5 w-2/3 rounded-lg" />
        <div className="skeleton h-2.5 w-1/3 rounded-lg" />
      </div>
      <div className="skeleton h-6 w-16 shrink-0 rounded-lg" />
    </div>
  )
}

export function SkeletonAvatar({ size = 36, className = '' }: { size?: number; className?: string }) {
  return <div className={`skeleton shrink-0 rounded-full ${className}`} style={{ width: size, height: size }} />
}
