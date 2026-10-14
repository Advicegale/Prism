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
  const {fileMapLayout,mergeExplorationViews,popoverBounds,sourceClick,diffSourcePosition,parseDiffRows,FILE_CARD_WIDTH,FILE_CARD_HEIGHT}=createRequire(import.meta.url)(bundle)
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
  assert.ok(bounds.width>1100&&bounds.height>700,'Desktop popover uses nearly the full viewport')
  for(const [width,height] of [[1440,900],[1728,1117],[390,844],[320,480]]){
    const b=popoverBounds(200,300,width,height)
    assert.ok(b.left>=0&&b.top>=0&&b.left+b.width<=width&&b.top+b.height<=height)
  }
  const projection={root:{definition:{path:'a.ts'}},nodes:['a.ts','b.ts','c.ts','d.ts'].map(path=>({path})),connections:[{source:'a.ts',target:'b.ts'},{source:'a.ts',target:'c.ts'},{source:'b.ts',target:'d.ts'},{source:'c.ts',target:'d.ts'}]}
  const layout=fileMapLayout(projection)
  assert.equal(layout.positions.size,4,'merged files appear once even with a cycle')
  assert.equal(layout.positions.get('b.ts').x,layout.positions.get('c.ts').x)
  assert.notEqual(layout.positions.get('b.ts').y,layout.positions.get('c.ts').y)
  assert.ok(layout.positions.get('d.ts').x>layout.positions.get('c.ts').x)
  for(const [a,p] of layout.positions)for(const [b,q] of layout.positions){if(a===b)continue;assert.ok(p.x+FILE_CARD_WIDTH<=q.x||q.x+FILE_CARD_WIDTH<=p.x||p.y+FILE_CARD_HEIGHT<=q.y||q.y+FILE_CARD_HEIGHT<=p.y)}
  assert.deepEqual(fileMapLayout(projection),layout)
  const centered=fileMapLayout(projection,'b.ts',{width:780,height:560})
  assert.ok(centered.positions.get('a.ts').x<centered.positions.get('b.ts').x)
  assert.ok(centered.positions.get('b.ts').x<centered.positions.get('d.ts').x)
  const point=centered.positions.get('b.ts')
  assert.ok(point.x+FILE_CARD_WIDTH/2>=390&&point.x+FILE_CARD_WIDTH/2<=centered.width-390,'Clicked file can be centered horizontally')
  assert.ok(point.y+FILE_CARD_HEIGHT/2>=280&&point.y+FILE_CARD_HEIGHT/2<=centered.height-280,'Clicked file can be centered vertically')
  const cyclic={...projection,connections:[...projection.connections,{source:'d.ts',target:'a.ts'}]}
  const cycle=fileMapLayout(cyclic)
  assert.equal(cycle.positions.size,4)
  assert.deepEqual(fileMapLayout(cyclic),cycle,'File cycles terminate deterministically')
  for(const [a,p] of cycle.positions)for(const [b,q] of cycle.positions){if(a!==b)assert.ok(p.x+FILE_CARD_WIDTH<=q.x||q.x+FILE_CARD_WIDTH<=p.x||p.y+FILE_CARD_HEIGHT<=q.y||q.y+FILE_CARD_HEIGHT<=p.y)}
  const anchor=(path,start=0)=>({path,start_byte:start,end_byte:start+6,revision:'rev',line:1,column:start,end_line:1,end_column:start+6})
  const rootEntity={id:'root',name:'channel',ref:{entity:'channel',fields:[]},definition:anchor('definition.ts')}
  const fileNode=path=>({id:path,path,changed:true,symbols:[{name:'channel',entity_id:'channel',anchor:anchor(path)}]})
  const edge=(source,target,id)=>({id,source,target,indirect:false,hidden_paths:[],evidence:[{id,kind:'import',anchor:anchor(target)}]})
  const base={root:rootEntity,revision:'rev',side:'new',changed_only:true,coverage:{complete:true,omitted:[]},boundaries:[],status:'expandable',has_more:true}
  const consumers={...base,query_id:'down',direction:'consumers',nodes:[fileNode('definition.ts'),fileNode('clicked.ts'),fileNode('consumer.ts')],connections:[edge('definition.ts','clicked.ts','carrier'),edge('clicked.ts','consumer.ts','downstream')]}
  const origins={...base,query_id:'up',direction:'origins',nodes:[fileNode('definition.ts'),fileNode('clicked.ts'),fileNode('input.ts')],connections:[edge('clicked.ts','definition.ts','carrier'),edge('definition.ts','input.ts','upstream')]}
  const before=JSON.stringify({consumers,origins}),combined=mergeExplorationViews({consumers,origins},anchor('clicked.ts',4))
  assert.equal(combined.direction,'both');assert.equal(combined.focus.path,'clicked.ts')
  assert.equal(combined.nodes.length,4,'Shared files are merged across both directions')
  assert.equal(combined.connections.length,3,'A proven carrier is deduplicated between projections')
  assert.ok(combined.connections.some(e=>e.source==='input.ts'&&e.target==='definition.ts'),'Upstream edges point toward the selected source')
  assert.equal(JSON.stringify({consumers,origins}),before,'Combining the tree never mutates either cursor projection')
  assert.equal(mergeExplorationViews({consumers,origins:{...origins,revision:'older'}},anchor('clicked.ts')).nodes.length,3,'Stale revision graphs cannot enter the current tree')
  const stale=mergeExplorationViews({consumers:{...consumers,has_more:false,status:'no_further_changed_files'},origins:{...origins,revision:'older',has_more:true,status:'partial'}},anchor('clicked.ts'))
  assert.equal(stale.has_more,false);assert.equal(stale.status,'no_further_changed_files','Stale projections cannot change completion state')
  console.log('Exploration checks passed: source offsets/revisions, near-viewport bounds, clicked-source centering, independently scoped bidirectional merging, causal arrows and cycle-safe layout.')
}finally{rmSync(temp,{recursive:true,force:true})}
