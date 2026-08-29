import 'katex/dist/katex.min.css'
import ReactMarkdown from 'react-markdown'
import rehypeKatex from 'rehype-katex'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'

export default function Markdown({ text }: { text: string }) {
  return (
    <div className="text-[15px] leading-7 text-slate-200">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[[rehypeKatex, { throwOnError: false }]]}
        components={{
          p: ({ children }: any) => <p className="mb-3 last:mb-0">{children}</p>,
          ul: ({ children }: any) => <ul className="mb-3 list-disc space-y-1 pl-6 last:mb-0">{children}</ul>,
          ol: ({ children }: any) => <ol className="mb-3 list-decimal space-y-1 pl-6 last:mb-0">{children}</ol>,
          li: ({ children }: any) => <li className="pl-1">{children}</li>,
          strong: ({ children }: any) => <strong className="font-semibold text-white">{children}</strong>,
          em: ({ children }: any) => <em className="italic">{children}</em>,
          h1: ({ children }: any) => <h1 className="mb-3 mt-4 text-xl font-semibold text-white first:mt-0">{children}</h1>,
          h2: ({ children }: any) => <h2 className="mb-2 mt-4 text-lg font-semibold text-white first:mt-0">{children}</h2>,
          h3: ({ children }: any) => <h3 className="mb-2 mt-3 text-base font-semibold text-white first:mt-0">{children}</h3>,
          a: ({ href, children }: any) => (
            <a href={href} target="_blank" rel="noreferrer" className="text-indigo-400 underline underline-offset-2">
              {children}
            </a>
          ),
          blockquote: ({ children }: any) => (
            <blockquote className="my-3 border-l-2 border-indigo-500/50 pl-4 italic text-slate-300">{children}</blockquote>
          ),
          hr: () => <hr className="my-4 border-slate-700/60" />,
          pre: ({ children }: any) => (
            <pre className="my-3 overflow-x-auto rounded-xl border border-white/[0.06] bg-white/[0.03] p-4 text-[13px] leading-6 text-slate-200">
              {children}
            </pre>
          ),
          code: ({ className, children }: any) =>
            typeof className === 'string' && className.includes('language-') ? (
              <code className="font-mono">{children}</code>
            ) : (
              <code className="rounded bg-white/[0.04] px-1.5 py-0.5 font-mono text-[13px] text-indigo-200">{children}</code>
            ),
          table: ({ children }: any) => (
            <div className="my-3 overflow-x-auto rounded-xl border border-white/[0.06]">
              <table className="w-full text-sm">{children}</table>
            </div>
          ),
          th: ({ children }: any) => (
            <th className="border-b border-white/[0.06] bg-white/[0.03] px-3 py-2 text-left font-semibold text-slate-200">
              {children}
            </th>
          ),
          td: ({ children }: any) => <td className="border-b border-white/[0.04] px-3 py-2">{children}</td>,
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  )
}
