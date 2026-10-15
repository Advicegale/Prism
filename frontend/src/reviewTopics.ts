/** File-level review scopes; stored symbol records supply notes, never navigation. */
import type {AIChange,ChangeTopic,DiffFile,Report,TopicDiagnostics} from './types'
export interface ReviewFile {path:string;file:DiffFile;notes:AIChange[];reason:string;added:number;removed:number;checks:string[]}
export interface ReviewScope {id:string;title:string;focus:string;source:string;files:ReviewFile[];checks:string[]}
export function filePath(file:DiffFile){return file.path||file.old_path}
/** Captured patches stop at 16000 chars; reports saved before the flag existed are judged by length. */
export function isPatchTruncated(file:Pick<DiffFile,'patch'|'patch_truncated'>){return file.patch_truncated===true||(file.patch_truncated===undefined&&file.patch.length>=16000)}
/** The full GitHub diff for a PR, or '' when the stored URL is not a github.com link. */
export function fullDiffUrl(url:string){return /^https:\/\/github\.com\//.test(url)?`${url}/files`:''}
/** Group risks repeat across groups; keys ignore case and spacing, and the first wording is kept. */
export function uniqueChecks(texts:(string|undefined)[]){const seen=new Map<string,string>();for(const text of texts){const clean=(text||'').trim(),key=clean.toLowerCase().replace(/\s+/g,' ');if(key&&!seen.has(key))seen.set(key,clean)}return [...seen.values()]}
const issueReasons:Record<string,string>={missing_groups:'it omitted some changes',duplicate_group:'it assigned a change twice',unknown_group:'it referred to an unknown change group',too_many_topics:'it proposed too many topics',bad_title:'a title was invalid',no_suggestions:'no topic plan was returned'}
/** Explains a path-grouped scope; '' for AI-planned scopes. Non-fatal issues (focus_cleared) did not cause the fallback, so they are not listed. */
export function topicProvenance(source:string,diagnostics?:Pick<TopicDiagnostics,'issues'>|null){if(source!=='paths')return ''
 const reasons=[...new Set((diagnostics?.issues||[]).filter(code=>code!=='focus_cleared').map(code=>issueReasons[code]||'it was invalid'))]
 return 'Grouped by file path.'+(reasons.length?` The AI topic plan was not used: ${reasons.join('; ')}.`:'')
}
export function buildReviewScopes(report:Report):ReviewScope[]{
 const canonical=new Map(report.files.flatMap(f=>[[f.path,filePath(f)],[f.old_path,filePath(f)]]))
 const notes=new Map<string,AIChange[]>(),nodePaths=new Map<string,string>()
 for(const n of report.overview.nodes)nodePaths.set(n.id,n.path)
 for(const g of report.groups)for(const n of g.graph.nodes)nodePaths.set(n.id,n.path)
 for(const g of report.ai?.groups||[])for(const c of g.changes||[]){const raw=nodePaths.get(c.symbol_id),path=raw?canonical.get(raw)||raw:undefined;if(path){if(!notes.has(path))notes.set(path,[]);notes.get(path)!.push(c)}}
 const aiGroups=report.ai?.groups||[],anchors=new Map<string,string[]>(),multiFile=new Set<string>()
 for(const g of report.groups){if(g.files.length===1)anchors.set(g.files[0],[...(anchors.get(g.files[0])||[]),g.id]);else if(g.files.length>1)multiFile.add(g.id)}
 const risksFor=(ids:string[])=>uniqueChecks(aiGroups.filter(g=>ids.includes(g.id)).flatMap(g=>g.risks||[]))
 const order=new Map((report.ai?.review_order||[]).map((step,i)=>[canonical.get(step.path)||step.path,{rank:i,reason:step.reason}]))
 const files=report.files.map((file,i)=>{const path=filePath(file),lines=file.patch.split('\n');return {path,file,notes:notes.get(path)||[],reason:order.get(path)?.reason||'',added:lines.filter(l=>l.startsWith('+')&&!l.startsWith('+++')).length,removed:lines.filter(l=>l.startsWith('-')&&!l.startsWith('---')).length,rank:order.get(path)?.rank??(report.files.length+i),checks:risksFor([...(anchors.get(path)||[]),...(anchors.get(file.old_path)||[])])}}).sort((a,b)=>a.rank-b.rank||a.path.localeCompare(b.path))
 const topics:ChangeTopic[]=report.ai?.topics?.length?report.ai.topics:report.topics||[]
 const result:ReviewScope[]=topics.map(t=>({id:t.id,title:t.title,focus:t.focus||'',source:t.source,files:files.filter(f=>t.files.includes(f.path)||t.files.includes(f.file.old_path)),checks:risksFor((t.group_ids||[]).filter(id=>multiFile.has(id)))})).filter(t=>t.files.length)
 const assigned=new Set(result.flatMap(t=>t.files.map(f=>f.path))),remaining=files.filter(f=>!assigned.has(f.path))
 if(remaining.length)result.push({id:'remaining-files',title:result.length?'Other changes':'Changes in this pull request',focus:'',source:'files',files:remaining,checks:[]})
 return result
}
