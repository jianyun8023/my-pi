import assert from 'node:assert/strict';
import fs from 'node:fs';
const base=process.argv[2],agent=process.argv[3],output=process.argv[4];
if(!base?.startsWith('http://127.0.0.1:') || !/^\/(?:private\/)?tmp\//.test(agent))throw Error('Use an isolated local fixture');
const req=async(url,body)=>{const r=await fetch(base+url,{method:body?'POST':'GET',headers:{'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});const result=await r.json();if(!r.ok)throw Error(`${r.status} ${JSON.stringify(result)}`);return result;};
const reviews=()=>fs.existsSync(agent+'/review-count.jsonl')?fs.readFileSync(agent+'/review-count.jsonl','utf8').trim().split('\n').filter(Boolean).length:0;
const report=[];
for(const mode of ['cache','deny']){
 const created=await req('/api/agent/new',{cwd:agent+'/workspace',type:'ensure_session',toolNames:['bash']}),id=created.sessionId;
 const controller=new AbortController(),events=[],response=await fetch(`${base}/api/agent/${id}/events`,{signal:controller.signal});
 const reader=(async()=>{
  let buffer='';
  for await(const chunk of response.body){
   buffer+=new TextDecoder().decode(chunk);let end;
   while((end=buffer.indexOf('\n\n'))>=0){
    const record=buffer.slice(0,end);buffer=buffer.slice(end+2);
    for(const line of record.split('\n'))if(line.startsWith('data: ')){
     try{events.push(JSON.parse(line.slice(6)));}catch{}
    }
   }
  }
 })().catch(()=>{});
 const before=reviews();
 try{
  await req('/api/agent/'+id,{type:'prompt',message:`bash-${mode}: read only the isolated fixture file with cat.`});
  for(let i=0;i<600 && !events.some(e=>e.type==='agent_end');i++){
   if(events.some(e=>e.method==='select'))throw Error('Unexpected human prompt: '+JSON.stringify(events.find(e=>e.method==='select')));
   await new Promise(r=>setTimeout(r,25));
  }
  assert.ok(events.some(e=>e.type==='agent_end'),'run completed');
  const context=(await req('/api/sessions/'+id+'/context')).context;
  const rows=context.permissionAudit??[],tool=rows.filter(r=>r.entry.kind==='tool'),gates=rows.filter(r=>r.entry.kind==='gate');
  assert.equal(tool.length,1);
  assert.equal(tool[0].entry.final.result,mode==='cache'?'allow':'deny');
  assert.equal(events.filter(e=>e.method==='select').length,0);
  const calls=reviews()-before;
  if(mode==='cache'){
   assert.equal(calls,1,'one model review for all gates');
   assert.ok(gates.length>=3,'path, external-directory and Bash gates were audited');
   assert.ok(JSON.stringify(context.messages).includes('CONTEXT_CACHE_FIXTURE_READ'),'command actually executed');
  }else assert.ok(!JSON.stringify(context.messages).includes('CONTEXT_FIXTURE_MUST_NOT_BE_READ'),'denied command did not read the fixture');
  report.push({mode,pass:true,sessionId:id,reviewerCalls:calls,gateCount:gates.length,audit:rows});
  console.log(JSON.stringify({mode,pass:true,reviewerCalls:calls,gateCount:gates.length}));
 }finally{controller.abort();await reader;}
}
fs.writeFileSync(output,JSON.stringify({createdAt:new Date().toISOString(),report},null,2)+'\n');
