import type {ReactNode} from 'react'

interface Props {text:string}

/** Render inline-code spans while preserving formatting line breaks in model text. */
export function InlineMarkdown({text}:Props){
 const parts:ReactNode[]=[]
 const codeSpan=/(^|[^`])`([^`\n]+)`(?!`)/g
 let cursor=0
 let match:RegExpExecArray|null

 while((match=codeSpan.exec(text))){
  const codeStart=match.index+match[1].length
  if(codeStart>cursor)parts.push(text.slice(cursor,codeStart))
  parts.push(<code className="markdown-inline-code" key={match.index}>{match[2]}</code>)
  cursor=codeSpan.lastIndex
 }

 if(cursor===0)return <span className="inline-markdown">{text}</span>
 if(cursor<text.length)parts.push(text.slice(cursor))
 return <span className="inline-markdown">{parts}</span>
}
