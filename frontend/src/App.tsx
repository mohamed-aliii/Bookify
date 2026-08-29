import { Suspense, lazy } from 'react'
import { Route, Routes } from 'react-router-dom'
import { ToastProvider } from './components/ui/Toast'

const LibraryPage = lazy(() => import('./pages/LibraryPage'))
const BookPage = lazy(() => import('./pages/BookPage'))
const SettingsPage = lazy(() => import('./pages/SettingsPage'))
const StatsPage = lazy(() => import('./pages/StatsPage'))
const KnowledgeMapPage = lazy(() => import('./pages/KnowledgeMapPage'))

function PageLoader() {
  return (
    <div className="flex h-screen items-center justify-center bg-surface-0">
      <div className="flex flex-col items-center gap-3">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-slate-600 border-t-indigo-400" />
        <p className="text-xs text-slate-500">Loading…</p>
      </div>
    </div>
  )
}

export default function App() {
  return (
    <ToastProvider>
      <Suspense fallback={<PageLoader />}>
        <Routes>
          <Route path="/" element={<LibraryPage />} />
          <Route path="/books/:bookId" element={<BookPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="/stats" element={<StatsPage />} />
          <Route path="/knowledge-map" element={<KnowledgeMapPage />} />
        </Routes>
      </Suspense>
    </ToastProvider>
  )
}
