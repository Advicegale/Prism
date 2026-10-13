import assert from 'node:assert/strict'
import {execFileSync} from 'node:child_process'
import {mkdtempSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {dirname,join} from 'node:path'
import {createRequire} from 'node:module'
import {fileURLToPath} from 'node:url'
const root=dirname(dirname(fileURLToPath(import.meta.url))),temp=mkdtempSync(join(tmpdir(),'prism-html-export-'))
try{
 const bundle=join(temp,'export.cjs')
 execFileSync(join(root,'node_modules/.bin/esbuild'),[join(root,'src/htmlExport.tsx'),'--bundle','--platform=node','--format=cjs','--jsx=automatic','--external:*?worker&inline',`--outfile=${bundle}`],{stdio:'pipe'})
 const {createHtmlReport,htmlReportFilename}=createRequire(import.meta.url)(bundle)
 const patch='diff --git a/new.java b/new.java\nnew file mode 100644\n--- /dev/null\n+++ b/new.java\n@@ -0,0 +1,180 @@\n'+Array.from({length:180},(_,i)=>'+line_'+(i+1)).join('\n')
 const file=(path,old_path=path,status='modified')=>({path,old_path,status,patch,new_ranges:[],old_ranges:[]})
 const report={id:'test',demo:false,created_at:'2026-10-13',meta:{repo:'AHOY',owner:'owner',number:25,title:'<script>window.bad=1</script>',body:'![image](https://remote.invalid/track)\n\n[bad](javascript:alert(1))',head:'abc123',url:'https://github.com/owner/AHOY/pull/25'},stats:{},files:[file('new.java','old.java','renamed'),file('','deleted.md','deleted'),file('settings.toml')],overview:{nodes:[]},groups:[],topics:[{id:'topic',title:'A < B',files:['old.java'],source:'paths'}],ai:null,architecture:{layers:[{id:'runtime',title:'Runtime',supporting:false}],nodes:[{id:'new.java',path:'new.java',label:'new.java',layer:'runtime',status:'renamed'},{id:'context',path:'context',label:'context',layer:'runtime',status:'context'}],edges:[{source:'new.java',target:'context',relation:'imports',confidence:'SOURCE_MATCH',status:'unchanged',detail:'<img src=x onerror=alert(1)>',evidence:[{path:'new.java',line:1,side:'head',code:'</script><script>window.bad=2</script>'}]}],notes:[],omitted_context:0}}
 const html=await createHtmlReport(report,'2026-10-13T00:00:00Z')
 assert.equal(htmlReportFilename(report),'AHOY-25.html')
 for(const path of ['new.java','deleted.md','settings.toml'])assert.ok(html.includes(path),'all files included: '+path)
 assert.ok(html.includes('line_180'),'full captured patch survives beyond original display limit')
 assert.ok(!html.includes('Show 160 more lines'),'no dead expansion controls in static rendering')
 assert.ok(!html.includes('diff --git a/new.java'),'raw diff prelude omitted')
 assert.ok(html.includes('&lt;script&gt;window.bad=1&lt;/script&gt;'))
 assert.ok(!html.includes('<script>window.bad'),'report strings never become executable script')
 assert.ok(!html.includes('<img '),'Markdown images cannot trigger remote requests')
 assert.ok(!html.includes('href="javascript:'))
 assert.equal((html.match(/<script>/g)||[]).length,1,'only the fixed offline interaction script is executable')
 assert.ok(!html.includes('src="https://'))
 assert.ok(!html.includes('Ask this PR')&&!html.includes('diff-ask-line'))
 assert.ok(html.includes('Content-Security-Policy'))
 const empty=await createHtmlReport({...report,files:[],topics:[],architecture:undefined},'now')
 assert.ok(empty.includes('No changed files'))
 console.log('HTML export checks passed: filename, complete file/patch coverage, rename/delete handling, escaped content, offline assets and no live assistant controls.')
}finally{rmSync(temp,{recursive:true,force:true})}
