import {Fragment,useEffect,useMemo,useRef,useState} from 'react'
import {ArrowLeft,ArrowRight,Check,CheckCheck,ChevronDown,ChevronLeft,ChevronRight,ChevronsLeft,ChevronsRight,Copy,FileCode2,FolderOpen,Keyboard,LoaderCircle,Maximize2,Minimize2,Search,X} from 'lucide-react'
import {buildReviewScopes,fullDiffUrl,isPatchTruncated,topicProvenance} from '../reviewTopics'
import {CodeDiff} from './CodeDiff'
import {SymbolExplorationPopover} from './SymbolExplorationPopover'
import type {SymbolSelection} from '../exploration'
import {isTestPath,testsLast} from '../testPaths'
import {MarkdownContent} from './MarkdownContent'
import type {Harnesses,Report,ReviewAssistantSettings} from '../types'
import {READING_SHORTCUTS,readingShortcut,type ShortcutTarget} from '../reading'
interface Props {report:Report;assistant:ReviewAssistantSettings;harnesses:Harnesses|null;onAssistantChange:(s:ReviewAssistantSettings)=>void;viewedAvailable:boolean;viewedStates:Record<string,string>;viewedBusy:Set<string>;viewedError:string;onToggleViewed:(path:string,viewed:boolean)=>void;hideViewed:boolean;onShowViewed:()=>void;focusPath:string|null;focusRequest:number;active:boolean;focusMode:boolean;onToggleFocus:()=>void;onFileChange?:(path:string)=>void}
const basename=(path:string)=>path.split('/').pop()||path
export function TopicReview({report,assistant,harnesses,onAssistantChange,viewedAvailable,viewedStates,viewedBusy,viewedError,onToggleViewed,hideViewed,onShowViewed,focusPath,focusRequest,active,focusMode,onToggleFocus,onFileChange}:Props){
 const scopes=useMemo(()=>buildReviewScopes(report),[report]),[scopeId,setScopeId]=useState(''),[paths,setPaths]=useState<Record<string,string>>({}),[query,setQuery]=useState(''),[copied,setCopied]=useState(false)
 const [symbol,setSymbol]=useState<SymbolSelection|null>(null)
 const [spineCollapsed,setSpineCollapsed]=useState(()=>{try{return localStorage.getItem('prism:spine-collapsed')==='true'}catch{return false}})
 const [helpOpen,setHelpOpen]=useState(false)
 useEffect(()=>{try{localStorage.setItem('prism:spine-collapsed',String(spineCollapsed))}catch{/* Storage can be unavailable; the spine still works. */}},[spineCollapsed])
 const explore=(selection:SymbolSelection)=>setSymbol({...selection,request:Date.now()})
 useEffect(()=>{setScopeId('');setPaths({});setQuery('');setSymbol(null)},[report.id])
 useEffect(()=>{if(!focusPath)return;const owner=scopes.find(t=>t.files.some(f=>f.path===focusPath));if(owner){setScopeId(owner.id);setPaths(current=>({...current,[owner.id]:focusPath}));setQuery('')}},[focusPath,focusRequest,scopes])
 const scope=scopes.find(t=>t.id===scopeId)||scopes[0]
 const scopeIndex=scope?scopes.findIndex(t=>t.id===scope.id):-1
 const openTopic=(target:typeof scopes[number])=>{setScopeId(target.id);setQuery('');const next=paths[target.id]||testsLast(target.files).find(f=>!hideViewed||viewedStates[f.path]!=='VIEWED')?.path||target.files[0]?.path;if(next)onFileChange?.(next)}
 const pickTopic=(index:number)=>{const target=scopes[index];if(target)openTopic(target)}
 // Test files form their own group after the others; the suggested order is kept inside each group, and Previous/Next/j/k follow the displayed order.
 const ordered=useMemo(()=>scope?testsLast(scope.files):[],[scope])
 const files=ordered.filter(f=>!hideViewed||viewedStates[f.path]!=='VIEWED')
 const visible=files.filter(f=>f.path.toLowerCase().includes(query.toLowerCase().trim()))
 const selected=visible.find(f=>f.path===paths[scope?.id||''])||visible[0]
 const currentIndex=selected?visible.findIndex(f=>f.path===selected.path):-1
 const seen=scope?.files.filter(f=>viewedStates[f.path]==='VIEWED').length||0
 const choose=(path:string)=>{if(scope)setPaths(current=>({...current,[scope.id]:path}));setCopied(false);onFileChange?.(path)}
 const next=visible[currentIndex+1],previous=visible[currentIndex-1]
 const notes=selected?.notes.filter(n=>n.diff_summary?.trim())||[]
 const checks=[...new Set(selected?.notes.flatMap(n=>n.review_notes||[])||[])]
 const worth=checks.length?checks:selected?.checks||[],provenance=topicProvenance(scope?.source||'',report.ai?.topic_diagnostics)
 function copy(){if(!selected)return;navigator.clipboard?.writeText(selected.file.patch).then(()=>{setCopied(true);setTimeout(()=>setCopied(false),1600)}).catch(()=>{})}
 const keyboard=useRef<(event:KeyboardEvent)=>void>(()=>{})
 keyboard.current=event=>{
  if(helpOpen&&event.key==='Escape'){setHelpOpen(false);event.preventDefault();return}
  const action=readingShortcut({key:event.key,ctrlKey:event.ctrlKey,metaKey:event.metaKey,altKey:event.altKey,shiftKey:event.shiftKey,target:event.target as ShortcutTarget|null})
  if(!action)return
  if(action==='next-file'){if(!next)return;choose(next.path)}
  else if(action==='prev-file'){if(!previous)return;choose(previous.path)}
  else if(action==='toggle-focus')onToggleFocus()
  else if(action==='help')setHelpOpen(value=>!value)
  else document.dispatchEvent(new CustomEvent('prism:diff-command',{detail:action}))
  event.preventDefault()
 }
 useEffect(()=>{
  if(!active){setHelpOpen(false);return}
  const listener=(event:KeyboardEvent)=>keyboard.current(event)
  document.addEventListener('keydown',listener)
  return()=>document.removeEventListener('keydown',listener)
 },[active])
 if(!scope)return <div className="topic-review-empty"><FolderOpen size={25}/><h3>No changed files to review</h3><p>Analyze a pull request to create a file review.</p></div>
 return <section className={'topic-review'+(spineCollapsed?' spine-collapsed':'')} aria-label="Review changes by topic">
  {!spineCollapsed&&<nav className="review-topic-spine" aria-label="Change topics"><div className="review-topic-spine-head"><h3>Topics</h3><span>{scopes.length}</span><button type="button" className="review-topic-spine-toggle" onClick={()=>setSpineCollapsed(value=>!value)} aria-expanded="true" aria-label="Collapse topics" title="Collapse topics"><ChevronsLeft size={16}/></button></div><p className="review-topic-intro">Choose a part of the change to review.</p><div className="review-topic-choices">{scopes.map(t=>{const reviewed=t.files.filter(f=>viewedStates[f.path]==='VIEWED').length;return <button type="button" key={t.id} className={'review-topic-choice '+(t.id===scope.id?'active':'')} aria-current={t.id===scope.id?'true':undefined} onClick={()=>openTopic(t)}><strong>{t.title}</strong><span>{t.files.length} files{viewedAvailable&&reviewed>0?` · ${reviewed} viewed`:''}</span>{viewedAvailable&&reviewed===t.files.length&&<CheckCheck size={15} aria-label="All files viewed"/>}</button>})}</div></nav>}
  <div className="review-topic-workspace">{spineCollapsed&&<div className="review-topic-switcher"><button type="button" className="review-topic-spine-toggle" onClick={()=>setSpineCollapsed(false)} aria-label="Show topics list" title="Show topics list"><ChevronsRight size={16}/></button><div className="review-topic-picker" role="group" aria-label="Choose topic"><button type="button" aria-label="Previous topic" title="Previous topic" disabled={scopeIndex<=0} onClick={()=>pickTopic(scopeIndex-1)}><ChevronLeft size={16}/></button><select aria-label="Topic" value={scope.id} onChange={e=>{const index=scopes.findIndex(t=>t.id===e.target.value);if(index>=0)pickTopic(index)}}>{scopes.map((t,index)=><option key={t.id} value={t.id}>{`${index+1} of ${scopes.length} · ${t.title}`}</option>)}</select><button type="button" aria-label="Next topic" title="Next topic" disabled={scopeIndex>=scopes.length-1} onClick={()=>pickTopic(scopeIndex+1)}><ChevronRight size={16}/></button></div></div>}<header className="review-topic-heading"><div><h2>{scope.title}</h2>{scope.focus&&<p>{scope.focus}</p>}</div><div className="review-topic-tools"><div className="review-topic-progress"><span>{viewedAvailable?`${seen} of ${scope.files.length} viewed`:`${scope.files.length} changed files`}</span>{viewedAvailable&&<progress value={seen} max={scope.files.length} aria-label="Files viewed in this topic"/>}</div><button type="button" className={'review-topic-action'+(focusMode?' active':'')} aria-pressed={focusMode} onClick={onToggleFocus} title={focusMode?'Leave focus mode (Esc)':'Hide the surrounding report and widen the diff (F)'}>{focusMode?<Minimize2 size={14}/>:<Maximize2 size={14}/>}<span>{focusMode?'Exit focus':'Focus'}</span></button><button type="button" className="review-topic-action review-topic-shortcuts" aria-label="Keyboard shortcuts" aria-expanded={helpOpen} title="Keyboard shortcuts (?)" onClick={()=>setHelpOpen(value=>!value)}><Keyboard size={14}/></button></div></header>
 {!!provenance&&<p className="review-topic-provenance">{provenance}</p>}{!!scope.checks.length&&<details className="review-group-checks"><summary>Group checks ({scope.checks.length})</summary><ul>{scope.checks.map((check,i)=><li key={i}><MarkdownContent text={check}/></li>)}</ul></details>}
   <div className="review-file-workspace"><aside className="review-file-queue" aria-label="Files in selected topic"><div className="review-file-queue-heading"><strong>Files</strong><span>{report.ai?.review_order?.length?'Suggested order':'Change order'}</span></div><label className="review-file-search"><Search size={14}/><input type="search" value={query} onChange={e=>setQuery(e.target.value)} placeholder="Find a file" aria-label="Find a file in this topic"/></label>
    <div className="review-file-choices">{visible.map((f,i)=><Fragment key={f.path}>{isTestPath(f.path)&&(i===0||!isTestPath(visible[i-1].path))&&<div className="review-file-group" role="presentation">Tests · {visible.filter(v=>isTestPath(v.path)).length}</div>}<button type="button" className={'review-file-choice '+(f.path===selected?.path?'active':'')} aria-current={f.path===selected?.path?'true':undefined} onClick={()=>choose(f.path)} title={f.path}><span className={'review-file-status '+f.file.status} aria-hidden="true"/><span className="review-file-choice-copy"><strong>{basename(f.path).split(/(?=[A-Z][a-z])/).map((part,i)=><span key={i}>{i>0&&<wbr/>}{part}</span>)}</strong><small>{f.path.includes('/')?f.path.slice(0,f.path.lastIndexOf('/')):'Repository root'}</small><em>{f.file.status}{isPatchTruncated(f.file)&&<span className="review-partial-mark" title="Partial: the stored diff is truncated">+</span>}</em></span>{viewedStates[f.path]==='VIEWED'&&<Check size={13} aria-label="Viewed in GitHub"/>}</button></Fragment>)}</div>
    {!visible.length&&<div className="review-file-list-empty"><p>{query?'No files match your search.':hideViewed?'Every file in this topic is viewed.':'No files in this topic.'}</p>{hideViewed&&!query&&<button type="button" onClick={onShowViewed}>Show viewed files</button>}</div>}
   </aside>
   <article className="review-file-reading" aria-label="Selected file review">{selected?<>
    <header className="review-file-heading"><div className="review-file-heading-name"><FileCode2 size={19}/><div><h3>{basename(selected.path)}</h3><code>{selected.path}</code>{selected.file.status==='renamed'&&selected.file.old_path!==selected.path&&<small>Previously {selected.file.old_path}</small>}</div></div><div className="review-file-heading-actions"><span className={'review-change-tag '+selected.file.status}>{selected.file.status}</span>{viewedAvailable&&<button type="button" className={'review-mark-viewed '+(viewedStates[selected.path]==='VIEWED'?'is-viewed':'')} disabled={viewedBusy.has(selected.path)} onClick={()=>onToggleViewed(selected.path,viewedStates[selected.path]!=='VIEWED')}>{viewedBusy.has(selected.path)?<LoaderCircle size={14} className="spinning"/>:<Check size={14}/>} {viewedStates[selected.path]==='VIEWED'?'Viewed':'Mark viewed'}</button>}</div></header>
    {(!!notes.length||!!worth.length)&&<section className="review-file-notes" aria-label="Saved change notes">{!!notes.length&&<><h4>Change notes</h4>{notes.map((n,i)=><MarkdownContent key={i} text={n.diff_summary||''}/>)}</>}{worth.length>0&&<div className="review-file-checks"><strong>Worth checking</strong>{!checks.length&&<small className="muted"> from group analysis</small>}<ul>{worth.map((note,i)=><li key={i}><MarkdownContent text={note}/></li>)}</ul></div>}</section>}
    {!!selected.reason&&<details className="review-file-reason"><summary>Why this file is in the review order <ChevronDown size={13}/></summary><MarkdownContent text={selected.reason}/></details>}
    <section className="review-file-diff" aria-label="File diff"><div className="review-file-diff-heading"><strong>File diff</strong><span className="review-diff-count"><b>+{selected.added}</b><em>−{selected.removed}</em>{isPatchTruncated(selected.file)&&<i className="review-partial-mark" title="Partial: the stored diff is truncated">+</i>}</span>{!!selected.file.patch&&<button type="button" onClick={copy}>{copied?<Check size={13}/>:<Copy size={13}/>} {copied?'Copied':'Copy diff'}</button>}</div>{isPatchTruncated(selected.file)&&<p className="review-file-truncated" role="note">The stored diff is cut off at about 16,000 characters. +/− counts cover only the captured part.{!!fullDiffUrl(report.meta.url)&&<> <a href={fullDiffUrl(report.meta.url)} target="_blank" rel="noreferrer">Open the full diff on GitHub</a></>}</p>}{selected.file.patch?<CodeDiff key={selected.path} patch={selected.file.patch} path={selected.path} oldPath={selected.file.old_path} onSymbolSelect={!report.demo?explore:undefined} inlineQuestion={!report.demo?{reportId:report.id,assistant,harnesses,onAssistantChange}:undefined}/>:<div className="review-file-no-diff">No text diff was captured for this file.</div>}</section>
    <footer className="review-file-navigation"><button type="button" disabled={!previous} onClick={()=>previous&&choose(previous.path)}><ArrowLeft size={14}/> Previous file</button><span>{currentIndex+1} of {visible.length}</span><button type="button" disabled={!next} onClick={()=>next&&choose(next.path)}>Next file <ArrowRight size={14}/></button></footer>
    {viewedError&&<p className="review-viewed-error" role="alert">{viewedError}</p>}
   </>:<div className="review-file-empty"><FolderOpen size={28}/><h3>{query?'No matching files':'Review complete for this topic'}</h3><p>{query?'Try a different file name or path.':'Choose another topic, or show viewed files to revisit the changes.'}</p></div>}</article>
   </div>
  </div>
  {helpOpen&&<div className="reading-help" role="dialog" aria-label="Keyboard shortcuts"><div className="reading-help-head"><strong>Keyboard shortcuts</strong><button type="button" onClick={()=>setHelpOpen(false)}><X size={13}/> Close</button></div><dl>{READING_SHORTCUTS.map(([keys,label])=><div key={keys}><dt><kbd>{keys}</kbd></dt><dd>{label}</dd></div>)}</dl></div>}
  {!report.demo&&<SymbolExplorationPopover reportId={report.id} selection={symbol} onSelect={explore}/>}
 </section>
}
