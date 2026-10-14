import assert from 'node:assert/strict'
import {execFileSync} from 'node:child_process'
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {dirname,join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {createRequire} from 'node:module'
const root=dirname(dirname(fileURLToPath(import.meta.url))),temp=mkdtempSync(join(tmpdir(),'prism-assistant-'))
try {
  const entry=join(temp,'entry.ts'),bundle=join(temp,'bundle.cjs')
  writeFileSync(entry,`export * from ${JSON.stringify(join(root,'src/assistantSettings.ts'))};`)
  execFileSync(join(root,'node_modules/.bin/esbuild'),[entry,'--bundle','--platform=node','--format=cjs',`--outfile=${bundle}`],{stdio:'pipe'})
  const {loadAssistantState,saveAssistantState,assistantSummary,assistantModelOptions,assistantEffortOptions,installedFallback,DEFAULT_ASSISTANT}=createRequire(import.meta.url)(bundle)

  // Fake in-memory storage with the same surface as window.localStorage.
  const memory=(initial={})=>{
    const data=new Map(Object.entries(initial))
    return {data,getItem:key=>data.has(key)?data.get(key):null,setItem:(key,value)=>{data.set(key,String(value))}}
  }
  const defaults={assistant:{harness:'codex',model:'default',effort:'default'},analyzeWithAi:false}

  // Fresh profile: defaults, and AI notes are off.
  assert.deepEqual(loadAssistantState(memory()),defaults,'fresh defaults')
  assert.deepEqual(DEFAULT_ASSISTANT,{harness:'codex',model:'default',effort:'default'})

  // Migration from the question keys (the Ask panel and Architecture panel used these).
  assert.deepEqual(loadAssistantState(memory({
    'prism:question-harness':'claude','prism:question-model':'sonnet','prism:question-effort':'high',
  })),{assistant:{harness:'claude',model:'sonnet',effort:'high'},analyzeWithAi:false},'question keys migrate the assistant')
  assert.deepEqual(loadAssistantState(memory({'prism:question-harness':'codex'})),{assistant:{harness:'codex',model:'default',effort:'default'},analyzeWithAi:false},'missing question model and effort default')
  assert.deepEqual(loadAssistantState(memory({'prism:question-harness':'none'})).assistant,{harness:'codex',model:'default',effort:'default'},'unknown question harness falls back to codex')

  // Migration from the old Analyze keys: a real CLI turns AI notes on, "none" turns them off.
  assert.deepEqual(loadAssistantState(memory({'prism:harness':'claude','prism:model':'opus','prism:effort':'max'})),{assistant:{harness:'claude',model:'opus',effort:'max'},analyzeWithAi:true},'analysis keys migrate harness, model, effort and AI notes')
  assert.deepEqual(loadAssistantState(memory({'prism:harness':'none','prism:model':'gpt-x','prism:effort':'low'})),defaults,'none becomes analyzeWithAi false and default codex')
  assert.deepEqual(loadAssistantState(memory({'prism:harness':'none'})),defaults,'none alone keeps the defaults')
  assert.equal(loadAssistantState(memory({'prism:harness':'codex'})).analyzeWithAi,true,'codex in the old Analyze form implies AI notes')

  // Question keys win over the Analyze keys for the assistant, but AI notes still follow the Analyze harness.
  assert.deepEqual(loadAssistantState(memory({
    'prism:harness':'none','prism:model':'analysis-model','prism:effort':'low',
    'prism:question-harness':'claude','prism:question-model':'haiku','prism:question-effort':'medium',
  })),{assistant:{harness:'claude',model:'haiku',effort:'medium'},analyzeWithAi:false},'question keys win over analysis keys')

  // Once the new key exists, the old keys are ignored.
  assert.deepEqual(loadAssistantState(memory({
    'prism:assistant':JSON.stringify({harness:'codex',model:'gpt-new',effort:'low'}),'prism:analyze-ai':'true',
    'prism:harness':'claude','prism:question-harness':'claude',
  })),{assistant:{harness:'codex',model:'gpt-new',effort:'low'},analyzeWithAi:true},'new keys win over old keys')
  assert.equal(loadAssistantState(memory({'prism:assistant':JSON.stringify(DEFAULT_ASSISTANT),'prism:harness':'claude'})).analyzeWithAi,false,'a saved profile without analyze-ai starts with AI notes off')
  assert.equal(loadAssistantState(memory({'prism:analyze-ai':'false','prism:harness':'claude'})).analyzeWithAi,false,'an explicit analyze-ai false beats the old harness')

  // Corrupt or odd saved values fall back safely.
  for(const raw of ['{not json','null','"codex"','42','[]']) assert.deepEqual(loadAssistantState(memory({'prism:assistant':raw})).assistant,DEFAULT_ASSISTANT,`corrupt prism:assistant ${raw} falls back to defaults`)
  assert.deepEqual(loadAssistantState(memory({'prism:assistant':'{not json','prism:question-harness':'claude'})).assistant,DEFAULT_ASSISTANT,'corrupt new key does not reuse old keys')
  assert.deepEqual(loadAssistantState(memory({'prism:assistant':JSON.stringify({harness:'none',model:'',effort:7})})).assistant,DEFAULT_ASSISTANT,'invalid fields fall back one by one')
  assert.deepEqual(loadAssistantState(memory({'prism:assistant':JSON.stringify({harness:'claude',model:'  opus ',effort:null})})).assistant,{harness:'claude',model:'opus',effort:'default'},'partial objects keep valid fields')
  assert.equal(loadAssistantState(memory({'prism:analyze-ai':'yes'})).analyzeWithAi,false,'unknown analyze-ai value is off')

  // Save and load round trip.
  const storage=memory()
  const state={assistant:{harness:'claude',model:'claude-custom-1',effort:'xhigh'},analyzeWithAi:true}
  saveAssistantState(storage,state)
  assert.equal(storage.data.get('prism:analyze-ai'),'true')
  assert.deepEqual(JSON.parse(storage.data.get('prism:assistant')),state.assistant)
  assert.deepEqual(loadAssistantState(storage),state,'save then load round-trips')
  saveAssistantState(storage,{assistant:{harness:'codex',model:'default',effort:'default'},analyzeWithAi:false})
  assert.deepEqual(loadAssistantState(storage),defaults,'a later save overwrites the earlier state')
  assert.equal(storage.data.get('prism:analyze-ai'),'false')

  // Summaries for the topbar button and the panels.
  assert.equal(assistantSummary({harness:'codex',model:'default',effort:'default'}),'Codex · default model')
  assert.equal(assistantSummary({harness:'claude',model:'sonnet',effort:'high'}),'Claude Code · sonnet')

  // Model and effort options come from the detected CLI and never include the implicit default.
  const harnesses={
    codex:{installed:true,discovery:'',models:[{id:'gpt-a',label:'GPT A',efforts:['low','high'],default_effort:'low',is_default:false},{id:'gpt-b',label:'',efforts:[],default_effort:'',is_default:true}]},
    claude:{installed:false,discovery:'',models:[],aliases:['default','sonnet','opus'],efforts:['low','max'],default_effort:''},
  }
  assert.deepEqual(assistantModelOptions(harnesses,'codex'),[{id:'gpt-a',label:'GPT A'},{id:'gpt-b',label:'gpt-b'}])
  assert.deepEqual(assistantModelOptions(harnesses,'claude'),[{id:'sonnet',label:'sonnet'},{id:'opus',label:'opus'}],'claude aliases without default')
  assert.deepEqual(assistantModelOptions(null,'claude'),[{id:'sonnet',label:'sonnet'},{id:'opus',label:'opus'},{id:'haiku',label:'haiku'}],'claude falls back to known aliases before detection')
  assert.deepEqual(assistantModelOptions(null,'codex'),[],'codex has no list before detection')
  assert.deepEqual(assistantEffortOptions(harnesses,'codex','gpt-a'),['low','high'],'model efforts win')
  assert.deepEqual(assistantEffortOptions(harnesses,'codex','gpt-b'),['low','medium','high'],'no model or harness efforts use the default list')
  assert.deepEqual(assistantEffortOptions(harnesses,'claude','sonnet'),['low','max'],'harness efforts when the model has none')

  // Missing harness switches to the installed CLI with default settings; otherwise nothing changes.
  assert.equal(installedFallback({harness:'codex',model:'gpt-a',effort:'high'},harnesses),null,'installed harness stays')
  assert.deepEqual(installedFallback({harness:'claude',model:'opus',effort:'max'},harnesses),{harness:'codex',model:'default',effort:'default'},'uninstalled claude falls back to installed codex')
  const codexOnly={...harnesses,codex:{...harnesses.codex,installed:false},claude:{...harnesses.claude,installed:true}}
  assert.deepEqual(installedFallback({harness:'codex',model:'gpt-a',effort:'high'},codexOnly),{harness:'claude',model:'default',effort:'default'},'switches to the installed CLI')
  const none={...harnesses,codex:{...harnesses.codex,installed:false}}
  assert.equal(installedFallback({harness:'codex',model:'default',effort:'default'},none),null,'no switch when neither CLI is installed')

  console.log('Assistant checks passed: fresh defaults, question and analysis migrations, question-key precedence, corrupt values, save/load round trips, summaries, model and effort options, and installed-CLI fallback.')
} finally {rmSync(temp,{recursive:true,force:true})}
