import assert from 'node:assert/strict'
import {execFileSync} from 'node:child_process'
import {mkdtempSync,renameSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {dirname,join} from 'node:path'
import {fileURLToPath,pathToFileURL} from 'node:url'
const root=dirname(dirname(fileURLToPath(import.meta.url))),temp=mkdtempSync(join(tmpdir(),'prism-review-test-'))
try{
 execFileSync(join(root,'node_modules/.bin/tsc'),[join(root,'src/reviewTopics.ts'),'--target','ES2022','--module','ES2022','--skipLibCheck','--outDir',temp],{stdio:'inherit'})
 renameSync(join(temp,'reviewTopics.js'),join(temp,'reviewTopics.mjs'))
 const {buildReviewScopes,fullDiffUrl,isPatchTruncated,topicProvenance,uniqueChecks}=await import(pathToFileURL(join(temp,'reviewTopics.mjs')).href)
 const file=(path,old_path=path,status='modified')=>({path,old_path,status,patch:'--- a/file\n+++ b/file\n-old\n+new\n context'})
 const report={files:[file('new.java','old.java','renamed'),file('','removed.java','deleted'),file('README.md'),file('config.toml')],overview:{nodes:[{id:'symbol',path:'old.java'}]},groups:[],topics:[{id:'fallback',title:'Fallback',files:['README.md']}],ai:{topics:[{id:'feature',title:'Feature',focus:'Review behavior',source:'ai',files:['old.java','removed.java']}],review_order:[{path:'removed.java',reason:'Removal first'},{path:'old.java',reason:'Then callers'}],groups:[{changes:[{symbol_id:'symbol',diff_summary:'Updated behavior'}]}]}}
 const scopes=buildReviewScopes(report)
 assert.deepEqual(scopes.map(s=>s.title),['Feature','Other changes'])
 assert.deepEqual(scopes[0].files.map(f=>f.path),['removed.java','new.java'])
 assert.equal(scopes[0].files[1].notes[0].diff_summary,'Updated behavior')
 assert.equal(scopes[0].files[1].reason,'Then callers')
 assert.deepEqual(new Set(scopes.flatMap(s=>s.files.map(f=>f.path))),new Set(['new.java','removed.java','README.md','config.toml']),'every changed file remains reviewable even when saved topics omit files')
 assert.equal(scopes[0].files[0].added,1);assert.equal(scopes[0].files[0].removed,1)
 const fallback=buildReviewScopes({...report,ai:undefined})
 assert.equal(fallback[0].title,'Fallback')
 assert.equal(buildReviewScopes({...report,ai:undefined,topics:[]})[0].files.length,4)
 assert.deepEqual(buildReviewScopes({...report,files:[],ai:undefined,topics:[]}),[])
 assert.equal(isPatchTruncated({patch:'short',patch_truncated:true}),true,'flag true wins over length')
 assert.equal(isPatchTruncated({patch:'x'.repeat(16010),patch_truncated:false}),false,'flag false wins over length')
 assert.equal(isPatchTruncated({patch:'short'}),false,'reports without the flag and a short patch are complete')
 assert.equal(isPatchTruncated({patch:'x'.repeat(16010)}),true,'reports without the flag use the 16000-char cap')
 assert.equal(fullDiffUrl('https://github.com/owner/repo/pull/7'),'https://github.com/owner/repo/pull/7/files')
 assert.equal(fullDiffUrl('http://github.com/owner/repo/pull/7'),'','only https github.com links are offered')
 assert.equal(fullDiffUrl('https://github.example/owner/repo/pull/7'),'')
 assert.equal(fullDiffUrl(''),'')
 assert.deepEqual(uniqueChecks(['  Retry   path ','retry path','',undefined,'Other']),['Retry   path','Other'],'checks ignore case and spacing, keep the first wording and drop empty text')
 const checkReport={files:['one.ts','two.ts','three.ts','four.ts','solo.ts'].map(path=>file(path)),overview:{nodes:[]},groups:[['g-one',['one.ts']],['g-pair',['two.ts','three.ts']],['g-pair-2',['three.ts','four.ts']],['g-solo',['solo.ts']],['g-solo-2',['solo.ts']]].map(([id,files])=>({id,files,changed_ids:[],graph:{nodes:[],edges:[],truncated:false}})),topics:[{id:'t',title:'Topic',files:['one.ts','two.ts','three.ts','four.ts','solo.ts'],group_ids:['g-one','g-pair','g-pair-2','g-solo','g-solo-2']}],ai:{groups:[{id:'g-one',risks:['Check  the Retry path','Ignore cache']},{id:'g-pair',risks:['check the retry path','Pair risk']},{id:'g-pair-2',risks:['Pair  RISK','New']},{id:'g-solo',risks:['Solo risk']},{id:'g-solo-2',risks:['solo RISK']}]}}
 const [checkScope]=buildReviewScopes(checkReport),checkFiles=Object.fromEntries(checkScope.files.map(f=>[f.path,f.checks]))
 assert.deepEqual(checkFiles['one.ts'],['Check  the Retry path','Ignore cache'],'a one-file group is an exact anchor for its file')
 assert.deepEqual(checkFiles['two.ts'],[],'multi-file group risks stay at scope level')
 assert.deepEqual(checkFiles['solo.ts'],['Solo risk'],'repeated risks from two one-file groups show once')
 assert.deepEqual(checkScope.checks,['check the retry path','Pair risk','New'],'scope checks come from multi-file groups only, de-duplicated across groups')
 assert.deepEqual(buildReviewScopes({...checkReport,ai:undefined})[0].checks,[],'reports without AI have no group checks')
 assert.deepEqual(buildReviewScopes({...checkReport,ai:undefined})[0].files.map(f=>f.checks),[[],[],[],[],[]])
 assert.equal(topicProvenance('ai',{issues:['missing_groups']}),'','AI-planned scopes say nothing about provenance')
 assert.equal(topicProvenance('paths'),'Grouped by file path.')
 assert.equal(topicProvenance('paths',null),'Grouped by file path.','older reports without diagnostics only get the path note')
 assert.equal(topicProvenance('paths',{source:'paths',issues:[],appended_paths:0}),'Grouped by file path.')
 assert.equal(topicProvenance('paths',{issues:['focus_cleared']}),'Grouped by file path.','a non-fatal issue does not explain a fallback')
 assert.equal(topicProvenance('paths',{issues:['missing_groups','missing_groups','too_many_topics']}),'Grouped by file path. The AI topic plan was not used: it omitted some changes; it proposed too many topics.')
 assert.equal(topicProvenance('paths',{issues:['no_suggestions']}),'Grouped by file path. The AI topic plan was not used: no topic plan was returned.')
 assert.equal(topicProvenance('paths',{issues:['not_a_list','bad_members']}),'Grouped by file path. The AI topic plan was not used: it was invalid.')
 console.log('Topic review checks passed: complete file coverage, semantic/fallback scopes, renamed notes/order, deleted paths, diff counts, group checks and topic provenance.')
}finally{rmSync(temp,{recursive:true,force:true})}
