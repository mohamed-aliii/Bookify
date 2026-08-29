import type {
  AppSettings,
  Book,
  BookProgress,
  ChatSession,
  Citation,
  Dashboard,
  Flashcard,
  KnowledgePoint,
  Message,
  Note,
  PracticeProblem,
  Quiz,
  QuizAttempt,
  QuizGradeResult,
  ReviewRating,
  SearchHit,
  Section,
  StudySessionPlan,
  TeachBackQuestionsResponse,
  TranslateResult,
  UnderstandingQuestions,
  VocabWord,
  WeakArea,
} from './types'

async function parse<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const text = await res.text()
    throw new Error(text || `${res.status} ${res.statusText}`)
  }
  return res.json() as Promise<T>
}

export function authFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  return fetch(input, init)
}

export const api = {
  listBooks: () => authFetch('/api/books').then((r) => parse<Book[]>(r)),
  getDashboard: () => authFetch('/api/books/dashboard').then((r) => parse<Dashboard>(r)),
  searchLibrary: (q: string, k = 12) =>
    authFetch(`/api/search?q=${encodeURIComponent(q)}&k=${k}`).then((r) => parse<SearchHit[]>(r)),
  uploadBook: (file: File) => {
    const form = new FormData()
    form.append('file', file)
    return authFetch('/api/books', { method: 'POST', body: form }).then((r) => parse<Book>(r))
  },
  getBook: (id: number) => authFetch(`/api/books/${id}`).then((r) => parse<Book>(r)),
  deleteBook: (id: number) =>
    authFetch(`/api/books/${id}`, { method: 'DELETE' }).then((r) => parse<{ ok: boolean }>(r)),
  reindexBook: (id: number) =>
    authFetch(`/api/books/${id}/reindex`, { method: 'POST' }).then((r) => parse<{ ok: boolean }>(r)),
  getSections: (id: number) => authFetch(`/api/books/${id}/sections`).then((r) => parse<Section[]>(r)),
  listSessions: (bookId: number) =>
    authFetch(`/api/books/${bookId}/sessions`).then((r) => parse<ChatSession[]>(r)),
  createSession: (bookId: number) =>
    authFetch(`/api/books/${bookId}/sessions`, { method: 'POST' }).then((r) => parse<ChatSession>(r)),
  generateSessionTitle: (sessionId: number) =>
    authFetch(`/api/sessions/${sessionId}/title`, { method: 'POST' }).then((r) => parse<ChatSession>(r)),
  listMessages: (sessionId: number) =>
    authFetch(`/api/sessions/${sessionId}/messages`).then((r) => parse<Message[]>(r)),
  summaryCached: (bookId: number, sectionId: number) =>
    authFetch(`/api/books/${bookId}/sections/${sectionId}/summary`).then((r) => parse<{ cached: boolean }>(r)),
  getFlashcards: (bookId: number) => authFetch(`/api/books/${bookId}/flashcards`).then((r) => parse<Flashcard[]>(r)),
  getDueCards: (bookId: number, limit = 30) =>
    authFetch(`/api/books/${bookId}/review?limit=${limit}`).then((r) => parse<Flashcard[]>(r)),
  reviewCard: (bookId: number, cardId: number, rating: ReviewRating) =>
    authFetch(`/api/books/${bookId}/flashcards/${cardId}/review`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rating }),
    }).then((r) => parse<Flashcard>(r)),
  recordQuizAttempt: (bookId: number, sectionId: number | null, score: number, total: number) =>
    authFetch(`/api/books/${bookId}/quiz-attempts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ section_id: sectionId, score, total }),
    }).then((r) => parse<QuizAttempt>(r)),
  getProgress: (bookId: number) =>
    authFetch(`/api/books/${bookId}/progress`).then((r) => parse<BookProgress>(r)),
  listNotes: (bookId: number) => authFetch(`/api/books/${bookId}/notes`).then((r) => parse<Note[]>(r)),
  createNote: (bookId: number, body: { content: string; section_id?: number | null; page?: number | null; quote?: string | null }) =>
    authFetch(`/api/books/${bookId}/notes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then((r) => parse<Note>(r)),
  updateNote: (bookId: number, noteId: number, patch: Partial<{ content: string; section_id: number | null; page: number | null; quote: string | null }>) =>
    authFetch(`/api/books/${bookId}/notes/${noteId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    }).then((r) => parse<Note>(r)),
  deleteNote: (bookId: number, noteId: number) =>
    authFetch(`/api/books/${bookId}/notes/${noteId}`, { method: 'DELETE' }).then((r) => parse<{ ok: boolean }>(r)),
  translateSelection: (bookId: number, body: { text: string; page?: number | null }) =>
    authFetch(`/api/books/${bookId}/vocab/translate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then((r) => parse<TranslateResult>(r)),
  listVocab: (bookId: number) => authFetch(`/api/books/${bookId}/vocab`).then((r) => parse<VocabWord[]>(r)),
  addVocab: (bookId: number, body: { term: string; translation: string; note?: string | null; context?: string | null; section_id?: number | null; page?: number | null }) =>
    authFetch(`/api/books/${bookId}/vocab`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then((r) => parse<VocabWord>(r)),
  addVocabBatch: (bookId: number, words: { term: string; translation: string; note?: string | null; context?: string | null }[], sectionId: number | null) =>
    authFetch(`/api/books/${bookId}/vocab/batch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ words, section_id: sectionId }),
    }).then((r) => parse<VocabWord[]>(r)),
  deleteVocab: (bookId: number, wordId: number) =>
    authFetch(`/api/books/${bookId}/vocab/${wordId}`, { method: 'DELETE' }).then((r) => parse<{ ok: boolean }>(r)),
  generateFlashcards: (bookId: number, sectionId: number, count: number | null) =>
    authFetch(`/api/books/${bookId}/sections/${sectionId}/flashcards`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ count }),
    }).then((r) => parse<Flashcard[]>(r)),
  addFlashcard: (bookId: number, sectionId: number, front: string, back: string) =>
    authFetch(`/api/books/${bookId}/sections/${sectionId}/flashcards/single`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ front, back }),
    }).then((r) => parse<Flashcard>(r)),
  generateQuiz: (bookId: number, sectionId: number | null, numQuestions: number | null) =>
    authFetch(`/api/books/${bookId}/quiz`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ section_id: sectionId, num_questions: numQuestions }),
    }).then((r) => parse<Quiz>(r)),
  gradeQuiz: (quizId: string, questionId: string, selected: number) =>
    authFetch(`/api/quiz/${quizId}/grade`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question_id: questionId, selected }),
    }).then((r) => parse<QuizGradeResult>(r)),
  getSettings: () => authFetch('/api/settings').then((r) => parse<AppSettings>(r)),
  updateSettings: (settings: unknown) =>
    authFetch('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(settings),
    }).then((r) => parse<AppSettings>(r)),

  generatePracticeProblem: (bookId: number, sectionId: number, problemType: string) =>
    authFetch(`/api/books/${bookId}/practice/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ section_id: sectionId, problem_type: problemType }),
    }).then((r) => parse<PracticeProblem>(r)),
  getTeachBackQuestions: (bookId: number, sectionId: number) =>
    authFetch(`/api/books/${bookId}/teachback/questions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ section_id: sectionId }),
    }).then((r) => parse<TeachBackQuestionsResponse>(r)),
  teachBackChat: (bookId: number, sectionId: number, conversation: { role: string; content: string }[]) =>
    authFetch(`/api/books/${bookId}/teachback/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ section_id: sectionId, conversation }),
    }),
  tts: (text: string, lang: string = 'en', quality: string = 'fast') =>
    authFetch('/api/tts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, lang, quality }),
    }),
  getUnderstandingQuestions: (bookId: number, sectionId: number) =>
    authFetch(`/api/books/${bookId}/understand`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ section_id: sectionId }),
    }).then((r) => parse<UnderstandingQuestions>(r)),

  listKnowledgePoints: (bookId: number) =>
    authFetch(`/api/books/${bookId}/knowledge-points`).then((r) => parse<KnowledgePoint[]>(r)),
  extractKnowledgePoints: (bookId: number, force = false, limit = 12) =>
    authFetch(`/api/books/${bookId}/knowledge-points/extract`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ force, limit }),
    }).then((r) => parse<{ ok: boolean; created: number; total_sections: number; total_kps: number }>(r)),
  getWeakAreas: (bookId: number, limit = 20) =>
    authFetch(`/api/books/${bookId}/weak-areas?limit=${limit}`).then((r) => parse<WeakArea[]>(r)),
  reportActivity: (bookId: number, body: { activity_type: string; knowledge_point_id?: number | null; result?: string; reveal_level?: number; duration_seconds?: number }) =>
    authFetch(`/api/books/${bookId}/intelligence/report`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then((r) => parse<{ ok: boolean }>(r)),
  startStudySession: (bookId: number) =>
    authFetch(`/api/books/${bookId}/study-sessions/start`, { method: 'POST' }).then((r) => parse<StudySessionPlan>(r)),
  getStudySession: (bookId: number, sessionId: number) =>
    authFetch(`/api/books/${bookId}/study-sessions/${sessionId}`).then((r) => parse<StudySessionPlan>(r)),
  advanceStudySession: (bookId: number, sessionId: number, body: { activity_id: number; result: string; duration_seconds?: number; knowledge_point_id?: number | null }) =>
    authFetch(`/api/books/${bookId}/study-sessions/${sessionId}/next`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then((r) => parse<{ xp_earned: number; total_xp: number; completed: number; total: number; current_index: number; all_done: boolean }>(r)),
  completeStudySession: (bookId: number, sessionId: number) =>
    authFetch(`/api/books/${bookId}/study-sessions/${sessionId}/complete`, { method: 'POST' }).then((r) => parse<{ session_id: number; xp_earned: number; activities_completed: number; correct_count: number; duration_seconds: number }>(r)),

  getReadingProgress: (bookId: number) =>
    authFetch(`/api/books/${bookId}/reading-progress`).then((r) => parse<import('./types').ReadingProgress[]>(r)),
  toggleRead: (bookId: number, sectionId: number) =>
    authFetch(`/api/books/${bookId}/sections/${sectionId}/read`, { method: 'POST' }).then((r) => parse<{ read: boolean }>(r)),
  getReadingSummary: (bookId: number) =>
    authFetch(`/api/books/${bookId}/reading-summary`).then((r) => parse<import('./types').ReadingSummary>(r)),
  checkRecall: (bookId: number, sectionId: number, recallText: string) =>
    authFetch(`/api/books/${bookId}/sections/${sectionId}/recall`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ recall_text: recallText }),
    }).then((r) => parse<import('./types').RecallCheckResult>(r)),
  getBookDashboard: (bookId: number) =>
    authFetch(`/api/books/${bookId}/book-dashboard`).then((r) => parse<import('./types').BookDashboard>(r)),
  getQuizErrors: (bookId: number, limit = 30) =>
    authFetch(`/api/books/${bookId}/errors?limit=${limit}`).then((r) => parse<import('./types').QuizError[]>(r)),

  getBookPdfUrl: (bookId: number) => `/api/books/${bookId}/pdf`,
  getBookCoverUrl: (bookId: number) => `/api/books/${bookId}/cover`,
  askAboutText: (bookId: number, body: import('./types').ReadAskRequest) =>
    authFetch(`/api/books/${bookId}/read/ask`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),

  getSectionChat: (bookId: number, sectionId: number) =>
    authFetch(`/api/books/${bookId}/sections/${sectionId}/chat`).then((r) =>
      parse<import('./types').SectionChatSession>(r),
    ),
  sendSectionChat: (bookId: number, sectionId: number, body: import('./types').SectionChatRequest) =>
    authFetch(`/api/books/${bookId}/sections/${sectionId}/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  getNotebook: async (bookId: number) => {
    const res = await authFetch(`/api/books/${bookId}/notebook`)
    if (!res.ok) throw new Error('Failed to load notebook')
    return await res.json() as Promise<import('./types').Notebook>
  },
  getSectionNotebook: async (bookId: number, sectionId: number) => {
    const res = await authFetch(`/api/books/${bookId}/sections/${sectionId}/notebook`)
    if (!res.ok) throw new Error('Failed to load notebook')
    return await res.json() as Promise<import('./types').Notebook>
  },
  addNotebookCell: async (notebookId: number, source: string, cellType: 'code' | 'markdown' = 'code', afterCellId?: number) => {
    const body: Record<string, unknown> = { source, cell_type: cellType }
    if (afterCellId !== undefined) body.after_cell_id = afterCellId
    const res = await authFetch(`/api/notebooks/${notebookId}/cells`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!res.ok) throw new Error(await res.text())
    return await res.json() as Promise<import('./types').NotebookCell>
  },
  updateNotebookCell: async (notebookId: number, cellId: number, source?: string, cellType?: 'code' | 'markdown') => {
    const body: Record<string, unknown> = {}
    if (source !== undefined) body.source = source
    if (cellType !== undefined) body.cell_type = cellType
    const res = await authFetch(`/api/notebooks/${notebookId}/cells/${cellId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!res.ok) throw new Error(await res.text())
    return await res.json() as Promise<import('./types').NotebookCell>
  },
  deleteNotebookCell: async (notebookId: number, cellId: number) => {
    const res = await authFetch(`/api/notebooks/${notebookId}/cells/${cellId}`, { method: 'DELETE' })
    if (!res.ok) throw new Error(await res.text())
  },
  runNotebookCell: async (notebookId: number, cellId: number) => {
    const res = await authFetch(`/api/notebooks/${notebookId}/cells/${cellId}/run`, { method: 'POST' })
    if (!res.ok) throw new Error(await res.text())
    return await res.json() as Promise<import('./types').NotebookCell>
  },
  runAllNotebookCells: async (notebookId: number) => {
    const res = await authFetch(`/api/notebooks/${notebookId}/run/all`, { method: 'POST' })
    if (!res.ok) throw new Error(await res.text())
    return await res.json() as Promise<import('./types').NotebookCell[]>
  },
  runAboveNotebookCell: async (notebookId: number, cellId: number) => {
    const res = await authFetch(`/api/notebooks/${notebookId}/cells/${cellId}/run_above`, { method: 'POST' })
    if (!res.ok) throw new Error(await res.text())
    return await res.json() as Promise<import('./types').NotebookCell>
  },
  runBelowNotebookCell: async (notebookId: number, cellId: number) => {
    const res = await authFetch(`/api/notebooks/${notebookId}/cells/${cellId}/run_below`, { method: 'POST' })
    if (!res.ok) throw new Error(await res.text())
    return await res.json() as Promise<import('./types').NotebookCell>
  },
  moveNotebookCell: async (notebookId: number, cellId: number, direction: 'up' | 'down') => {
    const res = await authFetch(`/api/notebooks/${notebookId}/cells/${cellId}/move?direction=${direction}`, { method: 'POST' })
    if (!res.ok) throw new Error(await res.text())
    return await res.json() as Promise<import('./types').NotebookCell>
  },
  duplicateNotebookCell: async (notebookId: number, cellId: number) => {
    const res = await authFetch(`/api/notebooks/${notebookId}/cells/${cellId}/duplicate`, { method: 'POST' })
    if (!res.ok) throw new Error(await res.text())
    return await res.json() as Promise<import('./types').NotebookCell>
  },
  restartNotebook: async (notebookId: number) => {
    const res = await authFetch(`/api/notebooks/${notebookId}/restart`, { method: 'POST' })
    if (!res.ok) throw new Error(await res.text())
    const j = await res.json()
    return Array.isArray(j) ? j as import('./types').NotebookCell[] : null
  },
  resetNotebook: async (notebookId: number) => {
    const res = await authFetch(`/api/notebooks/${notebookId}/reset`, { method: 'POST' })
    if (!res.ok) throw new Error(await res.text())
  },
  listCodeBlocks: async (bookId: number) => {
    const res = await authFetch(`/api/books/${bookId}/code-blocks`)
    if (!res.ok) throw new Error(await res.text())
    return await res.json() as Promise<import('./types').CodeBlock[]>
  },
  extractCodeBlocks: async (bookId: number, force = false) => {
    const res = await authFetch(`/api/books/${bookId}/code-blocks/extract?force=${force}`, { method: 'POST' })
    if (!res.ok) throw new Error(await res.text())
    return await res.json() as Promise<{ ok: boolean; message?: string; created?: number }>
  },
}

export interface ChatHandlers {
  onCitations?: (citations: Citation[]) => void
  onToken: (token: string) => void
  onReasoning?: (token: string) => void
  onStatus?: (status: string) => void
  onEvent?: (type: string, data: StreamEvent) => void
}

interface StreamEvent {
  type: string
  value?: string
  message?: string
  citations?: Citation[]
  id?: number
  notebook_id?: number
  cell_id?: number
}

export async function streamChat(
  sessionId: number,
  content: string,
  handlers: ChatHandlers,
  signal?: AbortSignal,
): Promise<void> {
  const res = await authFetch(`/api/sessions/${sessionId}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content }),
    signal,
  })
  if (!res.ok || !res.body) throw new Error(await res.text())

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const events = buffer.split('\n\n')
    buffer = events.pop() ?? ''
    for (const raw of events) {
      const line = raw.trim()
      if (!line.startsWith('data:')) continue
      const event = JSON.parse(line.slice(5).trim()) as StreamEvent
      if (event.type === 'content' && event.value !== undefined) handlers.onToken(event.value)
      else if (event.type === 'reasoning' && event.value !== undefined) handlers.onReasoning?.(event.value)
      else if (event.type === 'status' && event.value !== undefined) handlers.onStatus?.(event.value)
      else if (event.type === 'citations' && event.citations && handlers.onCitations)
        handlers.onCitations(event.citations)
      else if (event.type === 'error') throw new Error(event.message ?? 'Stream error')
      else handlers.onEvent?.(event.type, event)
    }
  }
}

export async function streamLearning(
  url: string,
  body: Record<string, unknown>,
  handlers: ChatHandlers,
  signal?: AbortSignal,
): Promise<void> {
  const res = await authFetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  })
  if (!res.ok || !res.body) throw new Error(await res.text())

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const events = buffer.split('\n\n')
    buffer = events.pop() ?? ''
    for (const raw of events) {
      const line = raw.trim()
      if (!line.startsWith('data:')) continue
      const event = JSON.parse(line.slice(5).trim()) as StreamEvent
      if (event.type === 'content' && event.value !== undefined) handlers.onToken(event.value)
      else if (event.type === 'reasoning' && event.value !== undefined) handlers.onReasoning?.(event.value)
      else if (event.type === 'status' && event.value !== undefined) handlers.onStatus?.(event.value)
      else if (event.type === 'error') throw new Error(event.message ?? 'Stream error')
      else handlers.onEvent?.(event.type, event)
    }
  }
}

export async function streamSummary(
  bookId: number,
  sectionId: number,
  force: boolean,
  handlers: { onToken: (token: string) => void },
  signal?: AbortSignal,
): Promise<void> {
  const res = await authFetch(`/api/books/${bookId}/sections/${sectionId}/summary`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ force }),
    signal,
  })
  if (!res.ok || !res.body) throw new Error(await res.text())

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const events = buffer.split('\n\n')
    buffer = events.pop() ?? ''
    for (const raw of events) {
      const line = raw.trim()
      if (!line.startsWith('data:')) continue
      const event = JSON.parse(line.slice(5).trim()) as StreamEvent
      if (event.type === 'content' && event.value !== undefined) handlers.onToken(event.value)
      else if (event.type === 'error') throw new Error(event.message ?? 'Stream error')
    }
  }
}


// --- Concept Graph ---

export async function getConceptGraph(bookId: number) {
  const res = await authFetch(`/api/books/${bookId}/concept-graph`)
  if (!res.ok) throw new Error('Failed to fetch concept graph')
  return await res.json() as Promise<import('./types').ConceptGraph>
}

export async function getBookSections(bookId: number) {
  const res = await authFetch(`/api/books/${bookId}/sections`)
  if (!res.ok) throw new Error('Failed to fetch sections')
  return await res.json() as Promise<import('./types').Section[]>
}

export async function extractSectionConceptGraph(bookId: number, sectionId: number, force = false) {
  const res = await authFetch(`/api/books/${bookId}/sections/${sectionId}/concept-graph/extract`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ force }),
  })
  if (!res.ok) throw new Error(await res.text())
  return await res.json() as Promise<{ ok: boolean; kp_created?: number; created?: number; total_edges?: number; message?: string }>
}

export async function getContentStart(bookId: number) {
  const res = await authFetch(`/api/books/${bookId}/content-start`)
  if (!res.ok) throw new Error('Failed to fetch content start')
  return await res.json() as Promise<import('./types').ContentStartInfo>
}

export async function setContentStart(bookId: number, page: number | null) {
  const res = await authFetch(`/api/books/${bookId}/content-start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ page }),
  })
  if (!res.ok) throw new Error(await res.text())
  return await res.json() as Promise<{ ok: boolean }>
}

export async function extractConceptEdges(bookId: number, force = false) {
  const res = await authFetch(`/api/books/${bookId}/concept-graph/extract`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ force }),
  })
  if (!res.ok) throw new Error(await res.text())
  return await res.json() as Promise<{ ok: boolean; created?: number; message?: string }>
}

export async function extractKnowledgePoints(bookId: number, force = false, limit = 12) {
  return api.extractKnowledgePoints(bookId, force, limit)
}

export async function getKpDetail(bookId: number, kpId: number) {
  const res = await authFetch(`/api/books/${bookId}/concept-graph/${kpId}`)
  if (!res.ok) throw new Error('Failed to fetch KP detail')
  return await res.json()
}


// --- Gamification ---

export async function getProfile() {
  const res = await authFetch('/api/gamification/profile')
  if (!res.ok) throw new Error('Failed to fetch profile')
  return await res.json() as Promise<import('./types').UserProfile>
}

export async function updateProfile(data: { display_name?: string; daily_xp_goal?: number }) {
  const res = await authFetch('/api/gamification/profile', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  })
  if (!res.ok) throw new Error(await res.text())
  return await res.json() as Promise<import('./types').UserProfile>
}

export async function getTodayProgress() {
  const res = await authFetch('/api/gamification/progress/today')
  if (!res.ok) throw new Error('Failed to fetch today progress')
  return await res.json() as Promise<import('./types').DailyProgress>
}

export async function getProgressHistory(days = 365) {
  const res = await authFetch(`/api/gamification/progress/history?days=${days}`)
  if (!res.ok) throw new Error('Failed to fetch progress history')
  return await res.json() as Promise<import('./types').DailyProgress[]>
}

export async function getAchievements() {
  const res = await authFetch('/api/gamification/achievements')
  if (!res.ok) throw new Error('Failed to fetch achievements')
  return await res.json() as Promise<import('./types').AchievementDef[]>
}

export async function getRecentAchievements() {
  const res = await authFetch('/api/gamification/achievements/recent')
  if (!res.ok) throw new Error('Failed to fetch recent achievements')
  return await res.json() as Promise<import('./types').AchievementDef[]>
}

export async function acknowledgeAchievement(key: string) {
  const res = await authFetch(`/api/gamification/achievements/${key}/acknowledge`, { method: 'POST' })
  if (!res.ok) throw new Error(await res.text())
}

export async function getGamificationStats() {
  const res = await authFetch('/api/gamification/stats')
  if (!res.ok) throw new Error('Failed to fetch stats')
  return await res.json() as Promise<import('./types').GamificationStats>
}


// --- Cross-Book ---

export async function getCrossBookLinks() {
  const res = await authFetch('/api/cross-book/links')
  if (!res.ok) throw new Error('Failed to fetch cross-book links')
  return await res.json()
}

export async function extractCrossBookLinks() {
  const res = await authFetch('/api/cross-book/extract', { method: 'POST' })
  if (!res.ok) throw new Error(await res.text())
  return await res.json()
}

export async function getCrossBookClusters() {
  const res = await authFetch('/api/cross-book/clusters')
  if (!res.ok) throw new Error('Failed to fetch clusters')
  return await res.json()
}

export async function getUnifiedGraph() {
  const res = await authFetch('/api/cross-book/unified-graph')
  if (!res.ok) throw new Error('Failed to fetch unified graph')
  return await res.json()
}

export async function getRelatedSections(bookId: number, sectionId: number) {
  const res = await authFetch(`/api/cross-book/related/${bookId}/${sectionId}`)
  if (!res.ok) throw new Error('Failed to fetch related sections')
  return await res.json()
}
