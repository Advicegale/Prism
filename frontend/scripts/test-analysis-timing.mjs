import assert from 'node:assert/strict'
import {execFileSync} from 'node:child_process'
import {mkdtempSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {dirname,join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {createRequire} from 'node:module'
const root=dirname(dirname(fileURLToPath(import.meta.url))),temp=mkdtempSync(join(tmpdir(),'prism-timing-'))
try{
 const bundle=join(temp,'timing.cjs')
 execFileSync(join(root,'node_modules/.bin/esbuild'),[join(root,'src/analysisTiming.ts'),'--bundle','--platform=node','--format=cjs',`--outfile=${bundle}`],{stdio:'pipe'})
 const {formatDuration,analysisDurationTooltip}=createRequire(import.meta.url)(bundle)
 assert.equal(formatDuration(.23),'<1s');assert.equal(formatDuration(59.9),'1m')
 assert.equal(formatDuration(74.74),'1m 15s');assert.equal(formatDuration(3661),'1h 1m 1s')
 for(const value of [undefined,null,-1,NaN,Infinity])assert.equal(formatDuration(value),'Not recorded')
 const tooltip=timing=>analysisDurationTooltip({analysis_timings:timing})
 assert.equal(tooltip({graph_seconds:3.24,review_seconds:71.5,total_seconds:74.74,review_status:'completed'}),'Graph ready (viewable): 3s\nReview finalized: 1m 15s total (1m 12s after graph)')
 assert.ok(tooltip({graph_seconds:4,review_status:'running'}).includes('Still generating'))
 assert.ok(tooltip({graph_seconds:4,review_status:'not_requested'}).includes('graph only'))
 assert.ok(tooltip({graph_seconds:4,review_status:'failed',review_seconds:20}).includes('Not finalized (stopped after 20s)'))
 assert.ok(tooltip({review_status:'failed'}).includes('Not finalized'))
 assert.ok(tooltip({graph_seconds:4,review_seconds:20,review_status:'completed',review_kind:'regenerated'}).includes('Review regenerated: 20s'))
 assert.ok(tooltip(undefined).includes('Not recorded for this saved report'))
 console.log('Analysis timing checks passed: stage boundaries, duration units, completed/running/failed/graph-only/regenerated and legacy states.')
}finally{rmSync(temp,{recursive:true,force:true})}
