/** File-level review scopes; stored symbol records supply notes, never navigation. */
import type {AIChange,ChangeTopic,DiffFile,Report} from './types'
export interface ReviewFile {path:string;file:DiffFile;notes:AIChange[];reason:string;added:number;removed:number}
export interface ReviewScope {id:string;title:string;focus:string;source:string;files:ReviewFile[]}
export function filePath(file:DiffFile){return file.path||file.old_path}
/** Captured patches stop at 16000 chars; reports saved before the flag existed are judged by length. */
export function isPatchTruncated(file:Pick<DiffFile,'patch'|'patch_truncated'>){return file.patch_truncated===true||(file.patch_truncated===undefined&&file.patch.length>=16000)}
/** The full GitHub diff for a PR, or '' when the stored URL is not a github.com link. */
export function fullDiffUrl(url:string){return /^https:\/\/github\.com\//.test(url)?`${url}/files`:''}
export function buildReviewScopes(report:Report):ReviewScope[]{
 const canonical=new Map(report.files.flatMap(f=>[[f.path,filePath(f)],[f.old_path,filePath(f)]]))
 const notes=new Map<string,AIChange[]>(),nodePaths=new Map<string,string>()
 for(const n of report.overview.nodes)nodePaths.set(n.id,n.path)
 for(const g of report.groups)for(const n of g.graph.nodes)nodePaths.set(n.id,n.path)
 for(const g of report.ai?.groups||[])for(const c of g.changes||[]){const raw=nodePaths.get(c.symbol_id),path=raw?canonical.get(raw)||raw:undefined;if(path){if(!notes.has(path))notes.set(path,[]);notes.get(path)!.push(c)}}
 const order=new Map((report.ai?.review_order||[]).map((step,i)=>[canonical.get(step.path)||step.path,{rank:i,reason:step.reason}]))
 const files=report.files.map((file,i)=>{const path=filePath(file),lines=file.patch.split('\n');return {path,file,notes:notes.get(path)||[],reason:order.get(path)?.reason||'',added:lines.filter(l=>l.startsWith('+')&&!l.startsWith('+++')).length,removed:lines.filter(l=>l.startsWith('-')&&!l.startsWith('---')).length,rank:order.get(path)?.rank??(report.files.length+i)}}).sort((a,b)=>a.rank-b.rank||a.path.localeCompare(b.path))
 const topics:ChangeTopic[]=report.ai?.topics?.length?report.ai.topics:report.topics||[]
 const result:ReviewScope[]=topics.map(t=>({id:t.id,title:t.title,focus:t.focus||'',source:t.source,files:files.filter(f=>t.files.includes(f.path)||t.files.includes(f.file.old_path))})).filter(t=>t.files.length)
 const assigned=new Set(result.flatMap(t=>t.files.map(f=>f.path))),remaining=files.filter(f=>!assigned.has(f.path))
 if(remaining.length)result.push({id:'remaining-files',title:result.length?'Other changes':'Changes in this pull request',focus:'',source:'files',files:remaining})
 return result
}
