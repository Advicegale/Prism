// Use the existing TypeScript compiler and Node assertions; no new test dependency.
import assert from 'node:assert/strict'
import {execFileSync} from 'node:child_process'
import {mkdtempSync,readFileSync,renameSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {dirname,join} from 'node:path'
import {fileURLToPath,pathToFileURL} from 'node:url'
const root=dirname(dirname(fileURLToPath(import.meta.url))),temp=mkdtempSync(join(tmpdir(),'prism-layout-test-'))
try{
 execFileSync(join(root,'node_modules/.bin/tsc'),[join(root,'src/layout/architectureLayout.ts'),'--target','ES2022','--module','ES2022','--lib','ES2022,DOM','--skipLibCheck','--outDir',temp],{stdio:'inherit'})
 renameSync(join(temp,'architectureLayout.js'),join(temp,'architectureLayout.mjs'))
 const {buildArchitectureLayout,routeDrawing}=await import(pathToFileURL(join(temp,'architectureLayout.mjs')).href)
 const input=JSON.parse(readFileSync(join(root,'tests/fixtures/port-reservation.json'),'utf8'))
 const result=buildArchitectureLayout(input)
 assert.deepEqual(new Set(Object.keys(result.positions)),new Set(input.cards.map(n=>n.id)))
 assert.deepEqual(new Set(result.routes.map(r=>r.id)),new Set(input.pairs.map(p=>p.id)))
 assert.equal(result.diagnostics.cardPasses,0)
 assert.equal(result.diagnostics.sharedPorts,0)
 assert.equal(result.diagnostics.sharedSegments,0,'future port access cannot be consumed by an earlier route')
 assert.equal(result.diagnostics.fallbacks,0)
 for(const route of result.routes){assert.ok(route.points.length>=2);assert.match(routeDrawing(route).path,/^M/)}
 const rects=Object.values(result.positions)
 for(let i=0;i<rects.length;i++)for(let j=0;j<i;j++){const a=rects[i],b=rects[j];assert.ok(a.x+a.width<=b.x||b.x+b.width<=a.x||a.y+a.height<=b.y||b.y+b.height<=a.y)}
 const repeated=buildArchitectureLayout(input)
 assert.deepEqual(repeated.positions,result.positions,'completed bounded searches must produce stable positions')
 const isolated=buildArchitectureLayout({cards:[{id:'alone.gd',layer:'game',rank:0,height:132}],groups:[{id:'game',title:'Scene composition'}],pairs:[]})
 assert.equal(isolated.positions['alone.gd'].height,132)
 assert.equal(isolated.routes.length,0)
 const empty=buildArchitectureLayout({cards:[],groups:[],pairs:[]})
 assert.deepEqual(empty.positions,{})
 assert.equal(empty.routes.length,0)
 const crossing=routeDrawing({id:'v',source:'a',target:'b',points:[[60,0],[60,120]],bridges:[[60,60]],fallback:false})
 assert.equal(crossing.bridges.length,1)
 assert.match(crossing.path,/ C/,'perpendicular crossings get bridge arcs, not junction dots')
 console.log('Architecture layout checks passed: coverage, separate ports/lanes, future-port regression, no card overlap, repeatability, isolates, empty map and crossing bridges.')
}finally{rmSync(temp,{recursive:true,force:true})}
