const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { createHash } = require('node:crypto')
const { isolatedEnvironment, execute } = require('./main-durability-electron-qualification.cjs')

function mainSource() {
  return `
const {app}=require('electron')
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict')
const {createHash}=require('node:crypto')
const {JournalPublicationCapacity,startJournalPublicationPreparation}=require('./preparation.cjs')
const {createIncrementalChatJournal}=require('./journal.cjs')
const {deriveChatRecordMutation}=require('./mutation.cjs')
const {MainDurabilityFlusher}=require('./flusher.cjs')
const {IncrementalChatJournalDescriptorCache}=require('./cache.cjs')
const {checkpointFileReference}=require('./protocol.cjs')
const state=process.env.TW_DURABILITY_QUALIFICATION_STATE
app.setPath('userData',path.join(state,'user-data'))
app.setPath('logs',path.join(state,'logs'))
app.disableHardwareAcceleration()
const evidence=[],trace=[]
let cache,job
async function main(){
 assert.equal(process.type,'browser');assert.equal(process.versions.electron.split('.')[0],'41')
 assert(__dirname.includes('.asar/'))
 const flusher=new MainDurabilityFlusher({now:()=>0,setTimer:()=>0,clearTimer:()=>{},
  fsync:(fd,done)=>({joinSync:()=>{fs.fsyncSync(fd);done()}}),fsyncSync:fs.fsyncSync,close:fs.closeSync})
 cache=new IncrementalChatJournalDescriptorCache(flusher)
 const journal=createIncrementalChatJournal(path.join(state,'journals'),{descriptorCache:cache,
  descriptorDrainSync:()=>flusher.drainSync(),rotationEnabled:true})
 const first={appChatId:'chat',title:'one',archived:false,createdAt:1,updatedAt:1,messages:[],runs:[],persistenceRevision:1}
 const second={...first,title:'two',persistenceRevision:2},third={...second,title:'three',persistenceRevision:3}
 journal.initialize('chat',first);journal.append(deriveChatRecordMutation(first,second))
 const output=path.join(state,'exact-R.record');fs.writeFileSync(output,'')
 const capacity=new JournalPublicationCapacity(1,4*1024*1024)
 let released=0
 job=startJournalPublicationPreparation({workerEntryPath:path.join(__dirname,'worker.cjs'),
  capture:()=>{const lease=journal.captureSource('chat',2);assert(lease);journal.append(deriveChatRecordMutation(second,third));journal.rotateForPreparation('chat');assert(lease.isCurrent());return lease},
  output:checkpointFileReference(output),maxOutputBytes:1024*1024,capacity,reservationBytes:2*1024*1024,releaseCredit:()=>released++})
 assert(job);const artifact=await job.result
 const expected=Buffer.from(JSON.stringify(second));assert.deepEqual(fs.readFileSync(output),expected)
 assert.equal(artifact.sha256,createHash('sha256').update(expected).digest('hex'))
 assert.equal(released,0);assert.equal(capacity.reserve(1),null)
 job.release();job=null;assert.equal(released,1);assert.deepEqual(capacity.snapshot(),{jobs:0,bytes:0})
 evidence.push('actual nonzero-R journal lease survives append and rotation; exact JSON bytes and SHA; child validates and fsyncs output directory before exit')
 assert.equal(capacity.reserve(5*1024*1024),null)
 evidence.push('max jobs and byte credit stay held until release')
 for(const kind of ['cancel','death','replacement']){
  const source=path.join(state,kind+'.source'),out=path.join(state,kind+'.output')
  fs.writeFileSync(source,'{}');fs.writeFileSync(out,'')
  const sourceRef=checkpointFileReference(source),fd=fs.openSync(source,'r')
  let sourceClosed=false,credit=0
  const lease={chatId:'chat',revision:2,generation:1,checkpoint:{file:sourceRef,fd,prefixBytes:sourceRef.identity.size,mutablePrefix:false},sealed:null,active:null,
   isCurrent:()=>!sourceClosed,release:()=>{trace.push(kind+':source-close-after-exit');fs.closeSync(fd);sourceClosed=true},cancel:()=>{}}
  job=startJournalPublicationPreparation({workerEntryPath:path.join(__dirname,kind==='death'?'death.cjs':'stalled.cjs'),capture:()=>lease,
   output:checkpointFileReference(out),maxOutputBytes:1024,capacity:new JournalPublicationCapacity(1,100),reservationBytes:100,releaseCredit:()=>credit++})
  assert(job)
  const rejection=job.result.then(()=>{throw new Error('unexpected success')},error=>error)
  if(kind==='replacement'){fs.renameSync(out,out+'.original');fs.writeFileSync(out,'replacement')}
  if(kind!=='death')job.cancel()
  assert.equal(sourceClosed,false);assert.equal(credit,0);assert(fs.fstatSync(fd).isFile())
  await rejection
  if(kind==='replacement'){
   assert.equal(fs.readFileSync(out,'utf8'),'replacement');assert.equal(sourceClosed,false);assert.equal(credit,0)
   fs.unlinkSync(out);fs.renameSync(out+'.original',out);job.release()
  }
  assert.equal(sourceClosed,true);assert.equal(credit,1);assert.equal(fs.existsSync(out),false);job=null
  evidence.push(kind+': confirmed worker exit precedes borrowed fd release and identity-bound cleanup')
 }
 cache.retireSync();cache=null
 return {status:'PASS',electron:process.versions.electron,node:process.versions.node,processType:process.type,asar:true,evidence,trace}
}
main().then(result=>{fs.writeFileSync(path.join(state,'result.json'),JSON.stringify(result,null,2));app.exit(0)})
 .catch(async error=>{if(job){job.cancel();try{await job.result}catch{}};try{cache?.retireSync()}catch{};fs.writeFileSync(path.join(state,'result.json'),JSON.stringify({status:'FAIL',error:String(error),evidence,trace}));app.exit(1)})
`
}

/** Recursively copy relative source imports once. Hash and bundle the copies,
 * never reopen live sources after snapshotting. No repository build output used. */
function snapshotSources(repo, destination, entries) {
  const hashes = {}
  const visit = (relative) => {
    relative = path.normalize(relative).split(path.sep).join('/')
    if (hashes[relative]) return
    const bytes = fs.readFileSync(path.join(repo, relative))
    hashes[relative] = createHash('sha256').update(bytes).digest('hex')
    const target = path.join(destination, relative)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, bytes, { mode: 0o400 })
    const text = bytes.toString('utf8')
    for (const match of text.matchAll(/(?:from\s*|import\s*)['"](\.[^'"]+)['"]/g)) {
      const base = path.join(path.dirname(relative), match[1])
      const candidate = [base, base + '.ts', base + '.tsx', path.join(base, 'index.ts')].find(
        (file) =>
          fs.existsSync(path.join(repo, file)) && fs.statSync(path.join(repo, file)).isFile()
      )
      if (!candidate) throw new Error('Missing snapshot import: ' + base)
      visit(candidate)
    }
  }
  for (const entry of Object.values(entries)) visit(entry)
  return hashes
}

async function prepare(root, repo = path.resolve(__dirname, '..')) {
  const { build } = require('esbuild')
  const asar = require('@electron/asar')
  const env = isolatedEnvironment(root)
  const packageDir = path.join(root, 'package'),
    out = path.join(packageDir, 'out')
  for (const directory of [
    out,
    env.HOME,
    env.XDG_CONFIG_HOME,
    env.XDG_CACHE_HOME,
    env.TW_DURABILITY_QUALIFICATION_STATE,
    path.join(env.TW_DURABILITY_QUALIFICATION_STATE, 'user-data'),
    path.join(env.TW_DURABILITY_QUALIFICATION_STATE, 'logs')
  ])
    fs.mkdirSync(directory, { recursive: true })
  const entries = Object.fromEntries(
    Object.entries({
      preparation: 'JournalPublicationPreparation',
      worker: 'JournalPublicationPreparationWorker',
      journal: 'IncrementalChatJournal',
      mutation: 'ChatRecordMutation',
      flusher: 'MainDurabilityFlusher',
      cache: 'IncrementalChatJournalDescriptorCache',
      protocol: 'CheckpointPreparationProtocol'
    }).map(([name, file]) => [name, 'src/main/store/' + file + '.ts'])
  )
  const snapshot = path.join(root, 'source-snapshot')
  const sourceSha256 = snapshotSources(repo, snapshot, entries)
  await build({
    entryPoints: Object.fromEntries(
      Object.entries(entries).map(([name, file]) => [name, path.join(snapshot, file)])
    ),
    outdir: out,
    outExtension: { '.js': '.cjs' },
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    external: ['electron'],
    nodePaths: [path.join(repo, 'node_modules')]
  })
  fs.writeFileSync(
    path.join(packageDir, 'package.json'),
    JSON.stringify({
      name: 'journal-publication-qualification',
      version: '1.0.0',
      main: 'out/main.cjs'
    })
  )
  fs.writeFileSync(path.join(out, 'main.cjs'), mainSource())
  fs.writeFileSync(path.join(out, 'stalled.cjs'), 'setInterval(()=>{},1000)\n')
  fs.writeFileSync(path.join(out, 'death.cjs'), 'process.exit(9)\n')
  const archive = path.join(root, 'qualification.asar')
  await asar.createPackage(packageDir, archive)
  return {
    root,
    env,
    archive,
    sourceSha256,
    archiveSha256: createHash('sha256').update(fs.readFileSync(archive)).digest('hex')
  }
}

module.exports = { mainSource, snapshotSources, prepare }
if (require.main === module) {
  if (process.argv[2] !== '--run-exclusive')
    throw new Error('Root-exclusive native clearance required')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'taskwraith-journal-publication-electron-'))
  prepare(root)
    .then(execute)
    .then((receipt) => {
      console.log(JSON.stringify(receipt, null, 2))
      process.exitCode =
        receipt.code === 0 && receipt.closureConfirmed && receipt.result?.status === 'PASS' ? 0 : 1
    })
    .catch((error) => {
      fs.writeFileSync(
        path.join(root, 'receipt.json'),
        JSON.stringify({ root, status: 'FAIL', error: String(error) })
      )
      console.error(error)
      process.exitCode = 1
    })
}
