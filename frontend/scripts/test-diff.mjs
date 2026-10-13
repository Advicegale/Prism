import assert from 'node:assert/strict'
import {execFileSync} from 'node:child_process'
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {dirname, join} from 'node:path'
import {createRequire} from 'node:module'
import {fileURLToPath} from 'node:url'
const root = dirname(dirname(fileURLToPath(import.meta.url))), temp = mkdtempSync(join(tmpdir(), 'prism-diff-'))
try {
  const entry = join(temp, 'entry.ts'), bundle = join(temp, 'diff.cjs')
  writeFileSync(entry, `export * from ${JSON.stringify(join(root, 'src/diff.ts'))};\nexport * from ${JSON.stringify(join(root, 'src/components/CodeDiff.tsx'))};\nexport {createElement} from ${JSON.stringify(join(root, 'node_modules/react/index.js'))};\nexport {renderToStaticMarkup} from ${JSON.stringify(join(root, 'node_modules/react-dom/server.node.js'))};`)
  execFileSync(join(root, 'node_modules/.bin/esbuild'), [entry, '--bundle', '--platform=node', '--format=cjs', '--jsx=automatic', `--outfile=${bundle}`], {stdio: 'pipe'})
  const {parseDiffRows, buildDiffBlocks, alignSplitRows, changedWordRanges, diffAnchor, CodeDiff, createElement, renderToStaticMarkup} = createRequire(import.meta.url)(bundle)
  const rows = patch => parseDiffRows(patch).filter(r => r.hunk >= 0)
  const align = patch => buildDiffBlocks(rows(patch)).flatMap(alignSplitRows)
  const patch = 'diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -10,3 +20,4 @@\n-  const limit = 10;\n-  return read(limit);\n-}\n+  audit();\n+  const limit = 20;\n+  return read(limit);\n+}\n@@ -30,2 +50,2 @@\n same\n-last\n+next\n'
  const parsed = rows(patch), aligned = align(patch)
  assert.equal(aligned.find(r => r.left?.oldLine === 10)?.right?.newLine, 21, 'added prelude must not shift replacement alignment')
  assert.equal(aligned.find(r => r.right?.newLine === 20)?.left, undefined, 'pure insertion has a blank old cell')
  assert.deepEqual(aligned.filter(r => r.left).map(r => r.left.oldLine), [10, 11, 12, 30, 31], 'old source order and coordinates survive alignment')
  assert.deepEqual(aligned.filter(r => r.right).map(r => r.right.newLine), [20, 21, 22, 23, 50, 51], 'new source order and coordinates survive alignment')
  const same = parsed.findIndex(r => r.kind === 'context')
  assert.deepEqual(diffAnchor('a.ts', parsed, same, same, 'old'), {path: 'a.ts', old_lines: [30], new_lines: []}, 'before context excludes head coordinate')
  assert.deepEqual(diffAnchor('a.ts', parsed, same, same, 'new'), {path: 'a.ts', old_lines: [], new_lines: [50]}, 'after context excludes base coordinate')
  assert.deepEqual(diffAnchor('a.ts', parsed, 1, 6, 'old').old_lines, [10, 11, 12])
  assert.deepEqual(diffAnchor('a.ts', parsed, 6, 1, 'new').new_lines, [20, 21, 22], 'reverse shift selection remains on chosen side')
  for (const [patch, side] of [['@@ -0,0 +1,3 @@\n+a\n+b\n+c', 'right'], ['@@ -7,3 +0,0 @@\n-a\n-b\n-c', 'left']]) {
    const content = align(patch).filter(r => !r.note)
    assert.equal(content.length, 3)
    assert.ok(content.every(r => r[side] && !r[side === 'left' ? 'right' : 'left']), 'whole-file add/delete stays one-sided')
  }
  const notes = align('@@ -1 +1 @@\n-old value\n\\ No newline at end of file\n+new value\n\\ No newline at end of file')
  assert.equal(notes.filter(r => r.note).length, 3, 'hunk and both no-newline notes remain present')
  const unrelated = align('@@ -1 +1 @@\n-cache.clear();\n+scheduleRefresh();').filter(r => !r.note)
  assert.ok(unrelated.every(r => !(r.left && r.right)), 'unrelated lines are not presented as a replacement pair')
  const unicode = changedWordRanges('const label = "Olá";', 'const label = "Adeus";')
  assert.equal('const label = "Olá";'.slice(unicode.left[0].start, unicode.left[0].end), 'Olá')
  assert.equal('const label = "Adeus";'.slice(unicode.right[0].start, unicode.right[0].end), 'Adeus')
  const refs = parseDiffRows('@@ -1 +1 @@\n-x\n+y', [null, {oldLine: 101}, {newLine: 205}])
  assert.equal(refs[1].oldLine, 101); assert.equal(refs[2].newLine, 205)
  // Dense blocks use bounded matching but must never drop, repeat or reorder either side.
  const huge = '@@ -1,100 +1,110 @@\n'+Array.from({length: 100}, (_, i) => '-old_'+i).join('\n')+'\n'+Array.from({length: 110}, (_, i) => '+new_'+i).join('\n')
  const dense = align(huge)
  assert.deepEqual(dense.filter(r => r.left).map(r => r.left.oldLine), Array.from({length: 100}, (_, i) => i+1))
  assert.deepEqual(dense.filter(r => r.right).map(r => r.right.newLine), Array.from({length: 110}, (_, i) => i+1))
  assert.deepEqual(changedWordRanges('x'.repeat(9000), 'y'.repeat(9000)), {left: [], right: []}, 'long-line work is bounded')
  const markup = renderToStaticMarkup(createElement(CodeDiff, {patch, path: 'a.ts', expanded: true}))
  assert.ok(markup.includes('Before · base') && markup.includes('After · head'))
  assert.ok(markup.includes('data-side="old" data-line="10"') && markup.includes('data-side="new" data-line="21"'))
  assert.ok(markup.includes('diff-word-change'), 'changed tokens are emphasized')
  const staticMarkup = renderToStaticMarkup(createElement(CodeDiff, {patch, path: 'a.ts', expanded: true, interactive: false}))
  assert.ok(!staticMarkup.includes('diff-reader-controls') && !staticMarkup.includes('diff-code-split'), 'export stays unified with no dead controls')
  const hostile = renderToStaticMarkup(createElement(CodeDiff, {patch: '@@ -1 +1 @@\n-const text="old"\n+const text="<img src=x onerror=alert(1)>"', path: 'plain', expanded: true}))
  assert.ok(!hostile.includes('<img '), 'source stays escaped even inside changed-word markup')
  console.log('Diff checks passed: replacement alignment, one-sided gaps, source ordering, revision-specific anchors/ranges, no-newline markers, Unicode word changes, large-block bounds, rendered gutters and static export.')
} finally {rmSync(temp, {recursive: true, force: true})}
