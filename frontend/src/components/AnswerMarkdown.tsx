import { memo } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

function AnswerMarkdownInner({ content }: { content: string }) {
  return (
    <div className="prose prose-invert prose-sm max-w-none prose-p:leading-relaxed prose-headings:font-semibold prose-strong:text-white prose-code:rounded prose-code:bg-black/40 prose-code:px-1.5 prose-code:py-0.5 prose-code:text-[13px] prose-code:before:content-none prose-code:after:content-none prose-pre:bg-black/50 prose-pre:border prose-pre:border-white/10">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: (props) => (
            <a {...props} target="_blank" rel="noreferrer" className="text-indigo-400 underline" />
          ),
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  )
}

export const AnswerMarkdown = memo(AnswerMarkdownInner)
