import { createRequire } from 'node:module'; import fs from 'node:fs'; import { createHash } from 'node:crypto'; import { execSync } from 'node:child_process';
const req = createRequire('/home/box/MERYANG/agent-room-integration/package.json');
const { Client } = req('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = req('@modelcontextprotocol/sdk/client/streamableHttp.js');
const B='http://127.0.0.1:3300';
const env = Object.fromEntries(fs.readFileSync('server.env','utf8').split('\n').filter(l=>l.includes('=')).map(l=>[l.slice(0,l.indexOf('=')),l.slice(l.indexOf('=')+1)]));
const adm = Object.fromEntries(fs.readFileSync('admin.txt','utf8').trim().split('\n').map(l=>l.split('=')));
const results=[]; const rec=(id,ok,info='')=>{results.push({id,ok,info});console.log(`${ok?'PASS':'FAIL'} ${id} ${info}`);};
const rc = (...a) => execSync(`redis-cli -p 6390 ${a.map(x=>`'${String(x).replace(/'/g,"'\\''")}'`).join(' ')}`).toString().trim();
let cookie=''; async function web(path, body){ const r=await fetch(B+path,{method:'POST',headers:{'content-type':'application/json',cookie},body:JSON.stringify(body)}); for(const sc of r.headers.getSetCookie()){ if(sc.startsWith('ar_session=')) cookie=sc.split(';')[0]; } const t=await r.text(); try{return {s:r.status,j:JSON.parse(t)};}catch{return {s:r.status,j:t};} }
const DEV_TOKEN='local-dev-token-'+Date.now(); rc('SET',`device-cred:${createHash('sha256').update(DEV_TOKEN).digest('hex')}`,'dev-local-1');
async function wake(body, token=DEV_TOKEN){ const r=await fetch(B+'/api/wake',{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${token}`},body:JSON.stringify(body)}); return {s:r.status,j:await r.json()}; }
await web('/api/account/login',{username:adm.ADMIN_USER,password:adm.ADMIN_PASS});
let r = await web('/api/web/room-create',{topic:'wake e2e',displayName:'Host'}); const code=r.j.code, hostKey=r.j.hostKey;
const inv = async role => (await web('/api/room',{action:'createAgentInvite',code,hostKey,role})).j?.invite?.inviteCode;
const mcp=new Client({name:'wake-e2e',version:'0'}); await mcp.connect(new StreamableHTTPClientTransport(new URL(B+'/mcp')));
const pj=v=>JSON.parse(v.content[0].text); const tool=async(n,a)=>pj(await mcp.callTool({name:n,arguments:a}));
let j = await tool('room_join',{code,name:'Waker',inviteCode:await inv('coder')}); let seatKey=j.seatKey, cursor=j.cursor, name=j.name??'Waker';
rec('4.unauth-wake-401', (await wake({action:'poll'},'bogus')).s===401);
r = await wake({action:'register',code,name,seatKey,cursor}); const seatId=r.j.seatId; rec('4.register', r.s===200&&!!seatId, JSON.stringify(r.j));
j = await tool('room_sleep',{code,name,seatKey,cursor}); rec('4.room_sleep-handoff', j.slept===true && rc('GET',`seat-handoff:${r.j.roomInstanceId}:${seatId}`).includes(`"cursor":${cursor}`), JSON.stringify(j));
const t0=Date.now(); await web('/api/web/chat-send',{code,text:`@${name} please run the checks`});
const evKeys = rc('--scan','--pattern',`wake-evt:wk:*:${seatId}`).split('\n').filter(Boolean); rec('4.send-creates-durable-event', evKeys.length===1, `${evKeys.join(',')} (${Date.now()-t0}ms)`);
r = await wake({action:'poll'}); const seat=r.j.seats.find(s=>s.seatId===seatId); rec('4.poll-pending', seat?.pending?.length===1, JSON.stringify(seat?.pending?.map(e=>e.eventId)));
const ev1 = seat.pending[0].eventId;
r = await wake({action:'claim',eventIds:[ev1]}); const run=r.j.wakeRunId, claimId=r.j.claims?.[0]?.claimId, readFrom=r.j.readFrom; rec('4.claim', r.s===200&&!!claimId&&typeof readFrom==='number', JSON.stringify(r.j));
r = await wake({action:'claim',eventIds:[ev1]}); rec('4.double-claim-rejected', r.s!==200 || r.j.claims?.[0]?.error, JSON.stringify(r.j));
r = await wake({action:'progress',claims:[{claimId,status:'resume_started'}]}); rec('4.progress-started', r.s===200 && r.j.updated?.[0]?.state, JSON.stringify(r.j));
r = await wake({action:'renew',claimIds:[claimId]}); rec('4.renew', r.s===200 && r.j.renewed?.length===1, JSON.stringify(r.j).slice(0,120));
// impersonation: wrong seatKey managed read must not ack
await tool('room_listen',{code,name,since:readFrom,timeoutMs:0,managed:{seatKey:'wrong',wakeRunId:run}});
rec('4.wrong-seatkey-no-ack', !/SUCCEEDED/.test(rc('GET',`wake-evt:${ev1}`)), JSON.parse(rc('GET',`wake-evt:${ev1}`)).state);
// mock agent: verified read
j = await tool('room_listen',{code,name,since:readFrom,timeoutMs:0,managed:{seatKey,wakeRunId:run}});
const st1 = JSON.parse(rc('GET',`wake-evt:${ev1}`)).state; rec('4.verified-read-SUCCEEDED', st1==='SUCCEEDED', `state=${st1} cursor=${j.cursor}`);
cursor = j.cursor;
// failure keeps event
await web('/api/web/chat-send',{code,text:`@${name} second job`});
r = await wake({action:'poll'}); let ev2=r.j.seats.find(s=>s.seatId===seatId)?.pending?.[0]?.eventId;
r = await wake({action:'claim',eventIds:[ev2]}); let c2=r.j.claims?.[0]?.claimId;
r = await wake({action:'progress',claims:[{claimId:c2,status:'resume_failed'}]}); const st2=JSON.parse(rc('GET',`wake-evt:${ev2}`)||'{}'); rec('4.resume-failed-keeps-event', !!st2.state && st2.state!=='SUCCEEDED', `state=${st2.state} attempts=${st2.attempts}`);
// sleep-instant race: agent read up to cursor, @ arrives, agent sleeps with stale cursor
j = await tool('room_listen',{code,name,since:cursor,timeoutMs:0,managed:{seatKey}}); cursor=j.cursor; // acks ev2 too if still active
const raceSend = await web('/api/web/chat-send',{code,text:`@${name} sent at the instant of sleep`});
j = await tool('room_sleep',{code,name,seatKey,cursor}); rec('4.sleep-with-stale-cursor-accepted', j.slept===true, JSON.stringify(j));
r = await wake({action:'poll'}); const pend3 = r.j.seats.find(s=>s.seatId===seatId)?.pending??[]; rec('4.instant-of-sleep-@-not-missed', pend3.length>=1, JSON.stringify(pend3.map(e=>e.eventId)));
if (pend3[0]) { r = await wake({action:'claim',eventIds:[pend3[0].eventId]}); rec('4.readFrom<=trigger', r.j.readFrom<=cursor, `readFrom=${r.j.readFrom} cursorAtSleep=${cursor}`);
  const rr = await tool('room_listen',{code,name,since:r.j.readFrom,timeoutMs:0,managed:{seatKey,wakeRunId:r.j.wakeRunId}}); rec('4.race-trigger-delivered', rr.messages?.some(m=>/instant of sleep/.test(m.text)) && /SUCCEEDED/.test(rc('GET',`wake-evt:${pend3[0].eventId}`)), ''); }
// scan fallback: write a message bypassing the send hook (direct redis), then poll
const cnt=Number(rc('GET',`room-msg-count:${code}`)); const msg=JSON.stringify({id:Date.now(),type:'msg',name:'Host',client:'web',text:`@${name} direct write`,time:Date.now()});
rc('RPUSH',`room-msgs:${code}`,msg); rc('INCR',`room-msg-count:${code}`);
r = await wake({action:'poll'}); const pend4 = r.j.seats.find(s=>s.seatId===seatId)?.pending??[]; rec('4.scan-fallback-catches-direct-write', pend4.some(e=>e.eventId.includes(`:${cnt}:`)), JSON.stringify(pend4.map(e=>e.eventId)));
// key rotation -> rebind_required
j = await tool('room_join',{code,name,seatKey}); const newKey=j.seatKey;
r = await wake({action:'poll'}); const s5=r.j.seats.find(s=>s.seatId===seatId); rec('4.seatkey-rotation-invalidates', newKey!==seatKey ? s5?.status==='rebind_required' : true, `rotated=${newKey!==seatKey} status=${s5?.status}`);
r = await wake({action:'register',code,name,seatKey:newKey}); rec('4.rebind-with-new-key', r.s===200 && r.j.seatId===seatId, JSON.stringify(r.j));
// seat removal
const rm = await web('/api/web/host',{code,op:'remove',name,client:'cc'}); console.log('remove', rm.s, JSON.stringify(rm.j).slice(0,200)); r = await wake({action:'poll'}); const s6=r.j.seats.find(s=>s.seatId===seatId);
rec('4.seat-removal-invalidates', !s6 || s6.status!=='active', `status=${s6?.status??'gone'}`);
await mcp.close(); fs.writeFileSync('results-wake.json',JSON.stringify(results,null,1)); console.log(`\n${results.filter(x=>x.ok).length}/${results.length} passed`);
