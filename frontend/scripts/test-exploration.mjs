import assert from 'node:assert/strict'
import {execFileSync} from 'node:child_process'
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {dirname,join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {createRequire} from 'node:module'
const root=dirname(dirname(fileURLToPath(import.meta.url))),temp=mkdtempSync(join(tmpdir(),'prism-exploration-'))
try {
  const entry=join(temp,'entry.ts'),bundle=join(temp,'bundle.cjs')
  writeFileSync(entry,`export * from ${JSON.stringify(join(root,'src/exploration.ts'))};export * from ${JSON.stringify(join(root,'src/diff.ts'))};`)
  execFileSync(join(root,'node_modules/.bin/esbuild'),[entry,'--bundle','--platform=node','--format=cjs',`--outfile=${bundle}`],{stdio:'pipe'})
  const {fileMapLayout,popoverBounds,sourceClick,diffSourcePosition,parseDiffRows}=createRequire(import.meta.url)(bundle)
  const rows=parseDiffRows('@@ -8,2 +10,2 @@\n same\n-oldName\n+newName')
  assert.deepEqual(diffSourcePosition(rows[2],'both','new.ts','old.ts'),{side:'old',path:'old.ts',line:9})
  assert.deepEqual(diffSourcePosition(rows[3],'both','new.ts','old.ts'),{side:'new',path:'new.ts',line:11})
  assert.deepEqual(diffSourcePosition(rows[1],'both','new.ts','old.ts'),{side:'new',path:'new.ts',line:10})
  assert.deepEqual(diffSourcePosition(rows[1],'old','new.ts','old.ts'),{side:'old',path:'old.ts',line:8})
  const text='\tconst emoji="😀"; const café = 1',offset=text.indexOf('café')+1,node={}
  const source={textContent:text,contains:n=>n===node,closest:()=>null,ownerDocument:{caretPositionFromPoint:()=>({offsetNode:node,offset}),createRange:()=>({selectNodeContents(){},setEnd(){},toString:()=>text.slice(0,offset)})}}
  globalThis.window={getSelection:()=>({isCollapsed:true})}
  const event={button:0,clientX:220,clientY:400,currentTarget:source}
  const click=sourceClick(event,'arbitrary.ts','old',8)
  assert.equal(click.column,offset,'UTF-16 source columns retain emoji and tabs')
  assert.equal(click.path,'arbitrary.ts');assert.equal(click.side,'old')
  assert.equal(sourceClick({...event,button:1},'file.ts','new',1),null)
  assert.equal(sourceClick({...event,ctrlKey:true},'file.ts','new',1),null)
  window.getSelection=()=>({isCollapsed:false})
  assert.equal(sourceClick(event,'file.ts','new',1),null,'dragged text selection never opens the explorer')
  const bounds=popoverBounds(1278,798,1280,800)
  assert.ok(bounds.left>=12&&bounds.top>=12&&bounds.left+bounds.width<=1268&&bounds.top+bounds.height<=788)
  const projection={root:{definition:{path:'a.ts'}},nodes:['a.ts','b.ts','c.ts','d.ts'].map(path=>({path})),connections:[{source:'a.ts',target:'b.ts'},{source:'a.ts',target:'c.ts'},{source:'b.ts',target:'d.ts'},{source:'c.ts',target:'d.ts'},{source:'d.ts',target:'a.ts'}]}
  const layout=fileMapLayout(projection)
  assert.equal(layout.positions.size,4,'merged files appear once even with a cycle')
  assert.equal(layout.positions.get('b.ts').x,layout.positions.get('c.ts').x)
  assert.notEqual(layout.positions.get('b.ts').y,layout.positions.get('c.ts').y)
  assert.ok(layout.positions.get('d.ts').x>layout.positions.get('c.ts').x)
  for(const [a,p] of layout.positions)for(const [b,q] of layout.positions){if(a===b)continue;assert.ok(p.x+210<=q.x||q.x+210<=p.x||p.y+96<=q.y||q.y+96<=p.y)}
  assert.deepEqual(fileMapLayout(projection),layout)
  console.log('Exploration checks passed: generic source offsets, Unicode/tabs, selection preservation, Split/Unified revision paths, viewport bounds, shared-file merging and cycle layout.')
}finally{rmSync(temp,{recursive:true,force:true})}
