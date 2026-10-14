import assert from 'node:assert/strict'
import {execFileSync} from 'node:child_process'
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {dirname,join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {createRequire} from 'node:module'
const root=dirname(dirname(fileURLToPath(import.meta.url))),temp=mkdtempSync(join(tmpdir(),'prism-reading-'))
try {
  const entry=join(temp,'entry.ts'),bundle=join(temp,'bundle.cjs')
  writeFileSync(entry,`export * from ${JSON.stringify(join(root,'src/reading.ts'))};`)
  execFileSync(join(root,'node_modules/.bin/esbuild'),[entry,'--bundle','--platform=node','--format=cjs',`--outfile=${bundle}`],{stdio:'pipe'})
  const {defaultDiffMode,nextDefaultMode,readingShortcut,READING_SHORTCUTS}=createRequire(import.meta.url)(bundle)
  const plain={tagName:'DIV',isContentEditable:false,closest:()=>null}
  const key=(value,extra={})=>({key:value,ctrlKey:false,metaKey:false,altKey:false,target:plain,...extra})
  assert.equal(defaultDiffMode(0),'unified');assert.equal(defaultDiffMode(NaN),'unified')
  assert.equal(defaultDiffMode(959),'unified');assert.equal(defaultDiffMode(960),'split');assert.equal(defaultDiffMode(1400),'split')
  assert.equal(nextDefaultMode(920,'split'),'split','split stays split at 920')
  assert.equal(nextDefaultMode(930,'unified'),'unified','unified stays unified at 930')
  assert.equal(nextDefaultMode(960,'unified'),'split','flips to split at 960')
  assert.equal(nextDefaultMode(899,'split'),'unified','flips back to unified below 900')
  assert.equal(nextDefaultMode(0,'split'),'unified');assert.equal(nextDefaultMode(NaN,'split'),'unified')
  assert.equal(readingShortcut(key('j')),'next-file');assert.equal(readingShortcut(key('J')),'next-file')
  assert.equal(readingShortcut(key('k')),'prev-file');assert.equal(readingShortcut(key('K')),'prev-file')
  assert.equal(readingShortcut(key(']')),'next-change')
  assert.equal(readingShortcut(key('s')),'toggle-mode');assert.equal(readingShortcut(key('S')),'toggle-mode')
  assert.equal(readingShortcut(key('f')),'toggle-focus');assert.equal(readingShortcut(key('F')),'toggle-focus')
  assert.equal(readingShortcut(key('?')),'help');assert.equal(readingShortcut(key('?',{shiftKey:true})),'help')
  assert.equal(readingShortcut(key('x')),null,'unknown key')
  assert.equal(readingShortcut(key('constructor')),null,'prototype names are not shortcuts')
  assert.equal(readingShortcut(key('Escape')),null,'Escape is handled by the owners of open surfaces')
  for(const modifier of ['ctrlKey','metaKey','altKey'])assert.equal(readingShortcut(key('j',{[modifier]:true})),null,`${modifier} is left to the browser`)
  for(const tagName of ['INPUT','TEXTAREA','SELECT'])assert.equal(readingShortcut(key('j',{target:{tagName,isContentEditable:false,closest:()=>null}})),null,`${tagName} keeps its keys`)
  assert.equal(readingShortcut(key('j',{target:{tagName:'DIV',isContentEditable:true,closest:()=>null}})),null,'contenteditable keeps its keys')
  assert.equal(readingShortcut(key('j',{target:{tagName:'DIV',isContentEditable:false,closest:selector=>selector==='.symbol-exploration'?{}:null}})),null,'explorer window keeps its keys')
  assert.equal(readingShortcut(key('j',{target:{tagName:'BUTTON',isContentEditable:false,closest:()=>null}})),'next-file','buttons still navigate')
  assert.equal(readingShortcut(key('j',{target:null})),'next-file','events without a target still navigate')
  assert.ok(READING_SHORTCUTS.some(([keys])=>keys.includes('?')),'help overlay lists the shortcuts')
  console.log('Reading checks passed: diff layout width thresholds with hysteresis, shortcut keys, modifiers, editable targets and explorer exclusion.')
} finally {rmSync(temp,{recursive:true,force:true})}
