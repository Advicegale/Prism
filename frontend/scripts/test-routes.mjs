import assert from 'node:assert/strict'
import {execFileSync} from 'node:child_process'
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {dirname,join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {createRequire} from 'node:module'
const root=dirname(dirname(fileURLToPath(import.meta.url))),temp=mkdtempSync(join(tmpdir(),'prism-routes-'))
try {
  const entry=join(temp,'entry.ts'),bundle=join(temp,'bundle.cjs')
  writeFileSync(entry,`export * from ${JSON.stringify(join(root,'src/routes.ts'))};`)
  execFileSync(join(root,'node_modules/.bin/esbuild'),[entry,'--bundle','--platform=node','--format=cjs',`--outfile=${bundle}`],{stdio:'pipe'})
  const {parseRoute,formatRoute,documentTitle}=createRequire(import.meta.url)(bundle)
  const id='0123456789abcdef01234567'
  const home={name:'home'},history={name:'history'},settings={name:'settings'}
  const report=(view,file)=>file===undefined?{name:'report',id,view}:{name:'report',id,view,file}

  // Every route kind.
  assert.deepEqual(parseRoute(''),home)
  assert.deepEqual(parseRoute('#'),home)
  assert.deepEqual(parseRoute('#/'),home)
  assert.deepEqual(parseRoute('#/reports'),history)
  assert.deepEqual(parseRoute('#/settings'),settings)
  assert.deepEqual(parseRoute(`#/reports/${id}`),report('architecture'),'bare report id opens the architecture view')
  assert.deepEqual(parseRoute(`#/reports/${id}/architecture`),report('architecture'))
  assert.deepEqual(parseRoute(`#/reports/${id}/topics`),report('topics'))
  assert.deepEqual(parseRoute(`#/reports/${id}/topics?file=server%2Fsrc%2Fapp.ts`),report('topics','server/src/app.ts'))
  assert.deepEqual(parseRoute(`#/reports/${id}?file=a.ts`),report('architecture','a.ts'),'file without a view is kept')
  assert.deepEqual(parseRoute(`/reports/${id}/topics`),report('topics'),'hash without the leading # still parses')
  assert.deepEqual(parseRoute(`#/reports/${id}/topics?other=1&file=b.ts`),report('topics','b.ts'),'other parameters are ignored')
  assert.deepEqual(parseRoute(`#/reports/${id}/topics?file=`),report('topics'),'empty file means no file')

  // Fallbacks: anything unrecognized is home.
  const garbage=['#/garbage','#garbage','#reports','#/reports/','#/settings/','#/settings?x=1','#/reports?file=a.ts','#/reports/abc','#/reports/0123456789abcdef0123456',
    '#/reports/0123456789ABCDEF01234567','#/reports/0123456789abcdef0123456g',`#/reports/${id}/graph`,`#/reports/${id}/`,`#/reports/${id}/topics/`,`#/reports/${id}/topics/x`,
    `#/reports/${id}/topics?file=%E0%A4%A`,`#/reports/${id}/topics?file=%`,`#/reports/${id}/topics/?file=a.ts`,'#/reports/a/b/c/d']
  for(const hash of garbage)assert.deepEqual(parseRoute(hash),home,`falls back to home for ${hash}`)

  // Round trips, including file names with characters that break naive hashes.
  const files=['server/src/app.ts','docs/My File.md','src/ñandú/ü.ts','emoji/🚀.ts','a#b.ts','what?.ts','100%.md','a+b.ts','a&file=b.ts','  spaced  ','file']
  const routes=[home,history,settings,report('architecture'),report('topics'),...files.map(file=>report('topics',file)),...files.map(file=>report('architecture',file))]
  for(const route of routes)assert.deepEqual(parseRoute(formatRoute(route)),route,`round trip ${JSON.stringify(route)}`)

  // Exact formats.
  assert.equal(formatRoute(home),'#/')
  assert.equal(formatRoute(history),'#/reports')
  assert.equal(formatRoute(settings),'#/settings')
  assert.equal(formatRoute(report('architecture')),`#/reports/${id}/architecture`)
  assert.equal(formatRoute(report('topics','server/src/app.ts')),`#/reports/${id}/topics?file=server%2Fsrc%2Fapp.ts`)
  assert.equal(formatRoute(report('topics','a+b.ts')),`#/reports/${id}/topics?file=a%2Bb.ts`,'plus signs are encoded, not read as spaces')
  assert.equal(documentTitle(home,null),'Prism · Structural PR Review')
  assert.equal(documentTitle(report('topics'),{repo:'prism',number:40}),'Prism · prism #40')
  assert.equal(documentTitle(report('topics'),null),'Prism · Structural PR Review','no title until the report is loaded')
  assert.equal(documentTitle(history,null),'Prism · Recent reports')
  assert.equal(documentTitle(settings,null),'Prism · Configuration')
  console.log('Route checks passed: every route kind, fallbacks for garbage, bad ids, unknown views and trailing slashes, and file round trips and tab titles.')
} finally {rmSync(temp,{recursive:true,force:true})}
