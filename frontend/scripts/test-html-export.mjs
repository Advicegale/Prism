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
 const longPatch='diff --git a/long.ts b/long.ts\n--- a/long.ts\n+++ b/long.ts\n@@ -0,0 +1,2000 @@\n'+Array.from({length:2000},(_,i)=>'+const value_'+i+' = '+i+';').join('\n')
 const mixed={id:'mixed',title:'Mixed topic',focus:'',source:'paths',files:['tests/app.test.ts','long.ts','src/app.ts'],changed_count:0,graph:{nodes:[],edges:[],truncated:false},connections:[]}
 const testsOnly={id:'tests-only',title:'Only tests',focus:'',source:'paths',files:['tests/other.test.ts'],changed_count:0,graph:{nodes:[],edges:[],truncated:false},connections:[]}
 const tree={...report,ai:null,files:[{path:'tests/app.test.ts',old_path:'tests/app.test.ts',status:'modified',patch,new_ranges:[],old_ranges:[]},{path:'long.ts',old_path:'long.ts',status:'modified',patch:longPatch,new_ranges:[],old_ranges:[]},{path:'src/app.ts',old_path:'src/app.ts',status:'modified',patch,new_ranges:[],old_ranges:[]},{path:'tests/other.test.ts',old_path:'tests/other.test.ts',status:'modified',patch,new_ranges:[],old_ranges:[]}],topics:[mixed,testsOnly],architecture:undefined}
 const withTests=await createHtmlReport(tree,'2026-10-13T00:00:00Z')
 const label='<p class="muted">Tests</p>'
 assert.equal(withTests.split(label).length-1,2,'mixed topic labels the tests in its file index and file list; the tests-only topic has no label')
 const mixedStart=withTests.indexOf('id="topic-0"'),indexStart=withTests.indexOf('<nav class="file-index"',mixedStart)
 const indexEnd=withTests.indexOf('</nav>',indexStart),indexHtml=withTests.slice(indexStart,indexEnd)
 assert.ok(indexHtml.indexOf(label)>indexHtml.indexOf('app.ts</a>')&&indexHtml.indexOf(label)<indexHtml.indexOf('app.test.ts</a>'),'Tests label sits before the first test file in the index')
 assert.ok(indexHtml.indexOf('long.ts</a>')<indexHtml.indexOf(label),'source and long files come before the tests')
 const detailsStart=withTests.indexOf('<details id="file-',mixedStart)
 assert.ok(withTests.indexOf(label,detailsStart)>detailsStart && withTests.indexOf(label,detailsStart)<withTests.indexOf('app.test.ts</span>',detailsStart),'Tests label precedes the first test file in the file list')
 assert.equal(withTests.split('The stored diff is cut off at about 16,000 characters.').length-1,1,'only the truncated long.ts gets the notice')
 assert.ok(withTests.includes('+/− counts cover only the captured part.'))
 assert.ok(withTests.includes('long.ts'),'truncated file is still exported')
 assert.ok(withTests.includes('value_1999'),'stored lines of the capped diff are still exported')
 const emptyGraph={nodes:[],edges:[],truncated:false}
 const grouped={...tree,ai:{groups:[{id:'g-long',risks:['Long file risk']},{id:'g-pair',risks:['Pair risk']}]},groups:[{id:'g-long',files:['long.ts'],changed_ids:[],graph:emptyGraph},{id:'g-pair',files:['src/app.ts','tests/app.test.ts'],changed_ids:[],graph:emptyGraph}],topics:[{...mixed,group_ids:['g-pair','g-long']}]}
 const groupedHtml=await createHtmlReport(grouped,'2026-10-13T00:00:00Z')
 assert.equal(groupedHtml.split('Group checks (1)').length-1,1,'topic group checks come from multi-file groups only')
 assert.ok(groupedHtml.includes('Pair risk'))
 assert.equal(groupedHtml.split('Long file risk').length-1,1,'one-file group risk is shown on its file')
 assert.equal(groupedHtml.split('from group analysis').length-1,1,'file-level checks are labelled as group analysis')
 const partial=await createHtmlReport({...report,ai:{...report.ai,review_state:{feedback_status:'running'}}},'now')
 assert.ok(partial.includes('still being generated')&&partial.includes('only the feedback saved so far'),'partial export is labeled')
 const stopped=await createHtmlReport({...report,ai:{...report.ai,review_state:{feedback_status:'failed'}}},'now')
 assert.ok(stopped.includes('incomplete because analysis stopped'),'failed partial export is labeled')
 console.log('HTML export checks passed: filename, complete file/patch coverage, rename/delete handling, escaped content, offline assets, group checks and no live assistant controls.')
}finally{rmSync(temp,{recursive:true,force:true})}
