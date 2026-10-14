import {useEffect,useMemo,useState} from 'react'
import {ArrowLeft,ArrowRight,Check,CheckCheck,ChevronDown,Copy,FileCode2,FolderOpen,LoaderCircle,Search} from 'lucide-react'
import {buildReviewScopes} from '../reviewTopics'
import {CodeDiff} from './CodeDiff'
import {SymbolExplorationPopover} from './SymbolExplorationPopover'
import type {SymbolSelection} from '../exploration'
import {MarkdownContent} from './MarkdownContent'
import type {Harnesses,Report,ReviewAssistantSettings} from '../types'
interface Props {report:Report;assistant:ReviewAssistantSettings;harnesses:Harnesses|null;onAssistantChange:(s:ReviewAssistantSettings)=>void;viewedAvailable:boolean;viewedStates:Record<string,string>;viewedBusy:Set<string>;viewedError:string;onToggleViewed:(path:string,viewed:boolean)=>void;hideViewed:boolean;onShowViewed:()=>void;focusPath:string|null;focusRequest:number}
const basename=(path:string)=>path.split('/').pop()||path
export function TopicReview({report,assistant,harnesses,onAssistantChange,viewedAvailable,viewedStates,viewedBusy,viewedError,onToggleViewed,hideViewed,onShowViewed,focusPath,focusRequest}:Props){
 const scopes=useMemo(()=>buildReviewScopes(report),[report]),[scopeId,setScopeId]=useState(''),[paths,setPaths]=useState<Record<string,string>>({}),[query,setQuery]=useState(''),[copied,setCopied]=useState(false)
 const [symbol,setSymbol]=useState<SymbolSelection|null>(null)
 const explore=(selection:SymbolSelection)=>setSymbol({...selection,request:Date.now()})
 useEffect(()=>{setScopeId('');setPaths({});setQuery('');setSymbol(null)},[report.id])
 useEffect(()=>{if(!focusPath)return;const owner=scopes.find(t=>t.files.some(f=>f.path===focusPath));if(owner){setScopeId(owner.id);setPaths(current=>({...current,[owner.id]:focusPath}));setQuery('')}},[focusPath,focusRequest,scopes])
 const scope=scopes.find(t=>t.id===scopeId)||scopes[0]
 const files=scope?.files.filter(f=>!hideViewed||viewedStates[f.path]!=='VIEWED')||[]
 const visible=files.filter(f=>f.path.toLowerCase().includes(query.toLowerCase().trim()))
 const selected=visible.find(f=>f.path===paths[scope?.id||''])||visible[0]
 const currentIndex=selected?visible.findIndex(f=>f.path===selected.path):-1
 const seen=scope?.files.filter(f=>viewedStates[f.path]==='VIEWED').length||0
 const choose=(path:string)=>{if(scope)setPaths(current=>({...current,[scope.id]:path}));setCopied(false)}
 const next=visible[currentIndex+1],previous=visible[currentIndex-1]
 const notes=selected?.notes.filter(n=>n.diff_summary?.trim())||[]
 const checks=[...new Set(selected?.notes.flatMap(n=>n.review_notes||[])||[])]
 function copy(){if(!selected)return;navigator.clipboard?.writeText(selected.file.patch).then(()=>{setCopied(true);setTimeout(()=>setCopied(false),1600)}).catch(()=>{})}
 if(!scope)return <div className="topic-review-empty"><FolderOpen size={25}/><h3>No changed files to review</h3><p>Analyze a pull request to create a file review.</p></div>
 return <section className="topic-review" aria-label="Review changes by topic">
  <nav className="review-topic-spine" aria-label="Change topics"><div className="review-topic-spine-head"><h3>Topics</h3><span>{scopes.length}</span></div><p className="review-topic-intro">Choose a part of the change to review.</p><div className="review-topic-choices">{scopes.map(t=>{const reviewed=t.files.filter(f=>viewedStates[f.path]==='VIEWED').length;return <button type="button" key={t.id} className={'review-topic-choice '+(t.id===scope.id?'active':'')} aria-current={t.id===scope.id?'true':undefined} onClick={()=>{setScopeId(t.id);setQuery('')}}><strong>{t.title}</strong><span>{t.files.length} files{viewedAvailable&&reviewed>0?` · ${reviewed} viewed`:''}</span>{viewedAvailable&&reviewed===t.files.length&&<CheckCheck size={15} aria-label="All files viewed"/>}</button>})}</div></nav>
  <div className="review-topic-workspace"><header className="review-topic-heading"><div><h2>{scope.title}</h2>{scope.focus&&<p>{scope.focus}</p>}</div><div className="review-topic-progress"><span>{viewedAvailable?`${seen} of ${scope.files.length} viewed`:`${scope.files.length} changed files`}</span>{viewedAvailable&&<progress value={seen} max={scope.files.length} aria-label="Files viewed in this topic"/>}</div></header>
   <div className="review-file-workspace"><aside className="review-file-queue" aria-label="Files in selected topic"><div className="review-file-queue-heading"><strong>Files</strong><span>{report.ai?.review_order?.length?'Suggested order':'Change order'}</span></div><label className="review-file-search"><Search size={14}/><input type="search" value={query} onChange={e=>setQuery(e.target.value)} placeholder="Find a file" aria-label="Find a file in this topic"/></label>
    <div className="review-file-choices">{visible.map(f=><button type="button" key={f.path} className={'review-file-choice '+(f.path===selected?.path?'active':'')} aria-current={f.path===selected?.path?'true':undefined} onClick={()=>choose(f.path)} title={f.path}><span className={'review-file-status '+f.file.status} aria-hidden="true"/><span className="review-file-choice-copy"><strong>{basename(f.path).split(/(?=[A-Z][a-z])/).map((part,i)=><span key={i}>{i>0&&<wbr/>}{part}</span>)}</strong><small>{f.path.includes('/')?f.path.slice(0,f.path.lastIndexOf('/')):'Repository root'}</small><em>{f.file.status}</em></span>{viewedStates[f.path]==='VIEWED'&&<Check size={13} aria-label="Viewed in GitHub"/>}</button>)}</div>
    {!visible.length&&<div className="review-file-list-empty"><p>{query?'No files match your search.':hideViewed?'Every file in this topic is viewed.':'No files in this topic.'}</p>{hideViewed&&!query&&<button type="button" onClick={onShowViewed}>Show viewed files</button>}</div>}
   </aside>
   <article className="review-file-reading" aria-label="Selected file review">{selected?<>
    <header className="review-file-heading"><div className="review-file-heading-name"><FileCode2 size={19}/><div><h3>{basename(selected.path)}</h3><code>{selected.path}</code>{selected.file.status==='renamed'&&selected.file.old_path!==selected.path&&<small>Previously {selected.file.old_path}</small>}</div></div><div className="review-file-heading-actions"><span className={'review-change-tag '+selected.file.status}>{selected.file.status}</span>{viewedAvailable&&<button type="button" className={'review-mark-viewed '+(viewedStates[selected.path]==='VIEWED'?'is-viewed':'')} disabled={viewedBusy.has(selected.path)} onClick={()=>onToggleViewed(selected.path,viewedStates[selected.path]!=='VIEWED')}>{viewedBusy.has(selected.path)?<LoaderCircle size={14} className="spinning"/>:<Check size={14}/>} {viewedStates[selected.path]==='VIEWED'?'Viewed':'Mark viewed'}</button>}</div></header>
    {!!notes.length&&<section className="review-file-notes" aria-label="Saved change notes"><h4>Change notes</h4>{notes.map((n,i)=><MarkdownContent key={i} text={n.diff_summary||''}/>)}{checks.length>0&&<div className="review-file-checks"><strong>Worth checking</strong><ul>{checks.map((note,i)=><li key={i}><MarkdownContent text={note}/></li>)}</ul></div>}</section>}
    {!!selected.reason&&<details className="review-file-reason"><summary>Why this file is in the review order <ChevronDown size={13}/></summary><MarkdownContent text={selected.reason}/></details>}
    <section className="review-file-diff" aria-label="Complete file diff"><div className="review-file-diff-heading"><strong>File diff</strong><span className="review-diff-count"><b>+{selected.added}</b><em>−{selected.removed}</em></span>{!!selected.file.patch&&<button type="button" onClick={copy}>{copied?<Check size={13}/>:<Copy size={13}/>} {copied?'Copied':'Copy diff'}</button>}</div>{selected.file.patch?<CodeDiff key={selected.path} patch={selected.file.patch} path={selected.path} oldPath={selected.file.old_path} onSymbolSelect={!report.demo?explore:undefined} inlineQuestion={!report.demo?{reportId:report.id,assistant,harnesses,onAssistantChange}:undefined}/>:<div className="review-file-no-diff">No text diff was captured for this file.</div>}</section>
    <footer className="review-file-navigation"><button type="button" disabled={!previous} onClick={()=>previous&&choose(previous.path)}><ArrowLeft size={14}/> Previous file</button><span>{currentIndex+1} of {visible.length}</span><button type="button" disabled={!next} onClick={()=>next&&choose(next.path)}>Next file <ArrowRight size={14}/></button></footer>
    {viewedError&&<p className="review-viewed-error" role="alert">{viewedError}</p>}
   </>:<div className="review-file-empty"><FolderOpen size={28}/><h3>{query?'No matching files':'Review complete for this topic'}</h3><p>{query?'Try a different file name or path.':'Choose another topic, or show viewed files to revisit the changes.'}</p></div>}</article>
   </div>
  </div>
  {!report.demo&&<SymbolExplorationPopover reportId={report.id} selection={symbol} onSelect={explore}/>}
 </section>
}
