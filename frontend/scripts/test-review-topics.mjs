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
 const {buildReviewScopes}=await import(pathToFileURL(join(temp,'reviewTopics.mjs')).href)
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
 console.log('Topic review checks passed: complete file coverage, semantic/fallback scopes, renamed notes/order, deleted paths and diff counts.')
}finally{rmSync(temp,{recursive:true,force:true})}
