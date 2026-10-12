import ReactMarkdown, { type Components } from 'react-markdown'
import remarkBreaks from 'remark-breaks'
import remarkGfm from 'remark-gfm'

interface Props {
  text: string
  className?: string
}

const components: Components = {
  code({ children, className }) {
    return <code className={className || 'markdown-inline-code'}>{children}</code>
  },
}

/** Render model-provided Markdown without allowing embedded raw HTML. */
export function MarkdownContent({ text, className }: Props) {
  return <div className={['markdown-content', className].filter(Boolean).join(' ')}>
    <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]} components={components}>
      {text}
    </ReactMarkdown>
  </div>
}
