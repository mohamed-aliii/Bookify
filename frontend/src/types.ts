export type BookStatus = 'pending' | 'ready' | 'failed'

export interface Book {
  id: number
  title: string
  filename: string
  num_pages: number
  status: BookStatus
  error: string | null
  content_start_section_id: number | null
  content_start_page: number | null
}

export interface ContentStartInfo {
  content_start_section_id: number | null
  content_start_page: number | null
  first_section_title: string | null
  sections: Section[]
}

export interface Section {
  id: number
  title: string
  level: number
  page_start: number
  page_end: number
}

export interface Citation {
  page: number | null
  section_title: string
  snippet: string
  url?: string | null
}

export interface Message {
  id: number
  role: 'user' | 'assistant'
  content: string
  citations: Citation[] | null
  created_at: string
}

export interface ChatSession {
  id: number
  book_id: number
  title: string
}

export interface Flashcard {
  id: number
  section_id: number
  front: string
  back: string
  ord: number
  ease: number
  interval_days: number
  due_at: string | null
  reps: number
  lapses: number
}

export type ReviewRating = 'again' | 'hard' | 'good' | 'easy'

export interface QuizAttempt {
  section_id: number | null
  score: number
  total: number
  created_at: string
}

export interface SectionProgress {
  section_id: number
  cards_total: number
  cards_due: number
  cards_mastered: number
  last_quiz: QuizAttempt | null
}

export interface BookProgress {
  cards_total: number
  cards_due: number
  cards_mastered: number
  sections: SectionProgress[]
  attempts: QuizAttempt[]
}

export interface Note {
  id: number
  section_id: number | null
  page: number | null
  quote: string | null
  content: string
  created_at: string
  updated_at: string
}

export interface VocabWord {
  id: number
  book_id: number
  section_id: number | null
  term: string
  translation: string
  note: string | null
  context: string | null
  page: number | null
  created_at: string
}

export interface TranslateWord {
  term: string
  translation: string
  note: string | null
}

export interface TranslateResult {
  words: TranslateWord[]
  context: string | null
}

export interface DashboardBook {
  id: number
  title: string
  status: string
  num_pages: number
  sections_count: number
  sections_read: number
  cards_total: number
  cards_due: number
  cards_mastered: number
  notes_count: number
  last_quiz: QuizAttempt | null
  last_activity: string | null
}

export interface Dashboard {
  cards_total: number
  cards_due: number
  cards_mastered: number
  books: DashboardBook[]
}

export interface SearchHit {
  book_id: number
  book_title: string
  section_id: number | null
  section_title: string
  page_start: number
  page_end: number
  snippet: string
  distance: number
}

export interface QuizQuestion {
  id: string
  question: string
  options: string[]
}

export interface Quiz {
  quiz_id: string
  questions: QuizQuestion[]
}

export interface QuizGradeResult {
  correct: boolean
  answer_index: number
  explanation: string
}

export interface AppSettings {
  llm_model: string
  llm_temperature: number | null
  llm_max_history: number
  reasoning_enabled: boolean
  embedding_provider: string
  embedding_model: string
  chunk_chars: number
  chunk_overlap: number
  top_k: number
  min_heading_ratio: number
  max_toc_level: number
  web_fallback_distance: number
  web_search_provider: string
  tavily_api_key_masked: string
  tavily_search_depth: string
  web_max_results: number
  web_query_expansion: boolean
  web_relevance_filter: boolean
  openrouter_api_key_masked: string
}

export interface PracticeProblem {
  problem_id: string
  problem_type: string
  difficulty: string
  question: string
  hints: string[]
  solution: string
}

export interface UnderstandingQuestions {
  questions: string[]
}

export interface UnderstandingAnalysis {
  analysis: {
    strengths: string[]
    gaps: string[]
    misconceptions: string[]
  }
  study_plan: string
  focus_concepts: string[]
}

export interface TeachBackQuestion {
  id: string
  text: string
  difficulty: string
  tests: string
}

export interface TeachBackQuestionsResponse {
  questions: TeachBackQuestion[]
}

export interface KnowledgePoint {
  id: number
  book_id: number
  section_id: number
  name: string
  description: string
  difficulty: number
}

export interface UserKnowledgePoint {
  id: number
  knowledge_point_id: number
  mastery: number
  quiz_correct: number
  quiz_total: number
  socratic_reveals: number
  socratic_total: number
  practice_score_sum: number
  practice_count: number
  last_practiced: string | null
}

export interface WeakArea {
  knowledge_point: KnowledgePoint
  user_kp: UserKnowledgePoint | null
  section_title: string
  recommendation: string
}

export interface StudyActivity {
  id: number
  activity_type: string
  knowledge_point_id: number | null
  result: string
  duration_seconds: number
  created_at: string
}

export interface StudySession {
  id: number
  book_id: number
  started_at: string
  completed_at: string | null
  xp_earned: number
  activities_count: number
}

export interface StudySessionPlan {
  session: StudySession
  activities: StudyActivity[]
  total_activities: number
  current_index: number
}

export interface ConceptGraphNode {
  id: number
  name: string
  description: string
  difficulty: number
  mastery: number | null
  section_id: number
  section_title: string
}

export interface ConceptGraphEdge {
  id: number
  source: number
  target: number
  relationship_type: string
  strength: number
}

export interface ConceptGraph {
  nodes: ConceptGraphNode[]
  edges: ConceptGraphEdge[]
}

export interface NotebookImage {
  mime: string
  data: string
  width?: number
}

export interface NotebookVariable {
  name: string
  type: string
  value: string
}

export interface NotebookCell {
  id: number
  notebook_id: number
  ord: number
  cell_type: 'code' | 'markdown'
  source: string
  output: string | null
  error: string | null
  status: string
  execution_count: number
  elapsed_ms: number
  images: NotebookImage[]
  variables: NotebookVariable[]
}

export interface Notebook {
  id: number
  book_id: number
  title: string
  cells: NotebookCell[]
}

export interface CodeBlock {
  id: number
  book_id: number
  section_id: number
  language: string
  code: string
  description: string
  ord: number
}

export interface UserProfile {
  id: number
  display_name: string
  total_xp: number
  level: number
  current_streak: number
  longest_streak: number
  daily_xp_goal: number
  last_study_date: string | null
}

export interface DailyProgress {
  date: string
  xp_earned: number
  flashcards_reviewed: number
  quizzes_taken: number
  quizzes_perfect: number
  notes_created: number
  sections_read: number
  study_minutes: number
  goal_met: boolean
}

export interface AchievementDef {
  key: string
  name: string
  description: string
  icon: string
  category: string
  xp_reward: number
  earned: boolean
  earned_at: string | null
}

export interface GamificationStats {
  total_xp: number
  level: number
  xp_to_next_level: number
  current_streak: number
  longest_streak: number
  books_explored: number
  total_cards_reviewed: number
  total_quizzes: number
  perfect_quizzes: number
  total_notes: number
  achievements_earned: number
  achievements_total: number
  daily_goal_progress: number
}

export interface CrossBookLink {
  id: number
  source_kp_id: number
  target_kp_id: number
  similarity: number
  relationship_label: string
  explanation: string
  source_book_title: string | null
  target_book_title: string | null
  source_kp_name: string | null
  target_kp_name: string | null
}

export interface ConceptCluster {
  id: number
  name: string
  description: string
  member_count: number
  books_involved: string[]
}

export interface RelatedSection {
  book_id: number
  book_title: string
  section_id: number
  section_title: string
  page_start: number
  page_end: number
  similarity_score: number
  shared_clusters: string[]
  explanation: string
}

export interface ReadingProgress {
  section_id: number
  completed_at: string
  time_spent_seconds: number
}

export interface ChapterProgress {
  section_id: number
  title: string
  level: number
  read: boolean
  children_read: number
  total_children: number
  cards_mastered: number
  cards_total: number
  quiz_score: number | null
  mastery: number | null
}

export interface ReadingSummary {
  sections_read: number
  total_sections: number
  read_percent: number
  chapter_progress: ChapterProgress[]
}

export interface BookDashboard {
  sections_read: number
  total_sections: number
  read_percent: number
  cards_total: number
  cards_mastered: number
  cards_due: number
  quiz_avg_score: number | null
  total_quizzes: number
  kp_mastery_avg: number | null
  chapter_progress: ChapterProgress[]
  next_steps: string[]
  recent_activity: { type: string; section: string; score?: string; preview?: string; at: string }[]
}

export interface RecallCheckResult {
  score: number
  accurate_points: string[]
  missed_points: string[]
  misconceptions: string[]
  encouragement: string
}

export interface QuizError {
  id: number
  book_id: number
  section_id: number | null
  question: string
  user_answer: string
  correct_answer: string
  explanation: string
  created_at: string
}

export type ReadAction = 'simplify' | 'explain' | 'examples' | 'code' | 'create_flashcard' | 'create_note' | 'ask' | 'translate'

export interface ReadAskRequest {
  action: ReadAction
  text: string
  page?: number | null
  section_id?: number | null
  question?: string | null
}

export interface ChatMessage {
  id: number
  role: 'user' | 'assistant'
  content: string
  action?: string | null
  created_at?: string | null
}

export interface SectionChatSession {
  session_id: number
  messages: ChatMessage[]
}

export interface SectionChatRequest {
  text: string
  action: string
  page?: number | null
  question?: string | null
}
