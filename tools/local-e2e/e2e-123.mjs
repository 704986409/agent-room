import { createRequire } from 'node:module';
const req = createRequire('/home/box/MERYANG/agent-room-integration/package.json');
const { Client } = req('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = req('@modelcontextprotocol/sdk/client/streamableHttp.js');
const B = 'http://127.0.0.1:3300';
const env = Object.fromEntries((await import('node:fs')).readFileSync('/home/box/MERYANG/localtest/server.env','utf8').split('\n').filter(l=>l.includes('=')&&!l.startsWith('#')).map(l=>[l.slice(0,l.indexOf('=')),l.slice(l.indexOf('=')+1)]));
const adm = Object.fromEntries((await import('node:fs')).readFileSync('/home/box/MERYANG/localtest/admin.txt','utf8').trim().split('\n').map(l=>l.split('=')));
const results = []; const rec = (id, ok, info='') => { results.push({id, ok, info}); console.log(`${ok?'PASS':'FAIL'} ${id} ${info}`); };
class Jar { constructor(){this.c={};} hdr(){return Object.entries(this.c).map(([k,v])=>`${k}=${v}`).join('; ');} take(res){ for (const sc of res.headers.getSetCookie?.()??[]) { const [kv]=sc.split(';'); const i=kv.indexOf('='); const k=kv.slice(0,i), v=kv.slice(i+1); if (/Max-Age=0/.test(sc)) delete this.c[k]; else this.c[k]=v; } } }
async function call(jar, method, path, body, extra={}) {
  const res = await fetch(B+path, { method, headers: { 'content-type':'application/json', ...(jar?{cookie:jar.hdr()}:{}), ...extra }, body: body===undefined?undefined:JSON.stringify(body) });
  jar?.take(res); let j=null; const t=await res.text(); try{j=JSON.parse(t);}catch{j=t;} return { s: res.status, j, h: res.headers };
}
const proxy = (jar, cmd, pipe=false) => call(jar, 'POST', pipe?'/redis/pipeline':'/redis', cmd, { authorization: `Bearer ${env.WEB_PROXY_TOKEN}` });
const sfx = Date.now().toString(36);
// ---- 1 accounts
const admin = new Jar();
let r = await call(admin,'POST','/api/account/login',{username:adm.ADMIN_USER,password:adm.ADMIN_PASS});
rec('1.admin-login', r.s===200 && !!admin.c.ar_session, `status ${r.s}`);
const sc = r.h.getSetCookie?.()[0]??''; rec('1.cookie-flags', /HttpOnly/.test(sc)&&/Secure/.test(sc)&&/SameSite=Lax/.test(sc)&&/Max-Age=1296000/.test(sc), sc.replace(/ar_session=[^;]+/,'ar_session=…'));
const uname = 'alice'+sfx, upw='Pw-'+sfx+'-xyz123';
r = await call(admin,'POST','/api/admin/users',{username:uname,password:upw});
const uid = r.j?.user?.id; rec('1.create-user', (r.s===200||r.s===201) && !!uid, `status ${r.s}`);
const alice = new Jar(); r = await call(alice,'POST','/api/account/login',{username:uname,password:upw}); rec('1.user-login', r.s===200, `status ${r.s}`);
r = await call(alice,'GET','/api/admin/users'); rec('1.non-admin-blocked', r.s===403, `status ${r.s}`);
r = await call(null,'GET','/api/account/me'); rec('1.unauth-me-401', r.s===401, `status ${r.s}`);
r = await call(admin,'GET','/api/admin/users/sessions?userId='+uid); const sessN = (r.j?.sessions??[]).length; rec('1.admin-list-sessions', r.s===200 && sessN>=1, `n=${sessN}`);
r = await call(admin,'POST','/api/admin/users/revoke-sessions',{userId:uid}); r = await call(alice,'GET','/api/account/me'); rec('1.admin-revoke-sessions', r.s===401, `me after revoke ${r.s}`);
await call(alice,'POST','/api/account/login',{username:uname,password:upw});
r = await call(alice,'GET','/api/account/sessions'); const myS = r.j?.sessions??[]; const cur = myS.find(s=>s.current)??myS[0];
r = await call(alice,'POST','/api/account/sessions/revoke',{sessionId:cur?.id}); const r2 = await call(alice,'GET','/api/account/me'); rec('1.self-revoke-session', r.s===200 && r2.s===401, `${r.s}/${r2.s}`);
r = await call(admin,'POST','/api/admin/users/reset-password',{userId:uid,password:upw+'N'}); const rOld = await call(new Jar(),'POST','/api/account/login',{username:uname,password:upw}); const rNew = await call(alice,'POST','/api/account/login',{username:uname,password:upw+'N'});
rec('1.reset-password', r.s===200 && rOld.s===401 && rNew.s===200, `${r.s} old=${rOld.s} new=${rNew.s}`);
r = await call(admin,'POST','/api/admin/users/disable',{userId:uid}); const rme = await call(alice,'GET','/api/account/me'); const rl = await call(new Jar(),'POST','/api/account/login',{username:uname,password:upw+'N'});
rec('1.disable-user', r.s===200 && rme.s===401 && rl.s!==200, `${r.s} me=${rme.s} login=${rl.s}`);
await call(admin,'POST','/api/admin/users/enable',{userId:uid});
const codes=[]; for (let i=0;i<7;i++){ const x=await call(null,'POST','/api/account/login',{username:uname,password:'wrong'}); codes.push(x.s);} rec('1.rate-limit-username', codes.includes(429), codes.join(','));
// sliding expiry: inspect the stored session
const bob='bob'+sfx; await call(admin,'POST','/api/admin/users',{username:bob,password:upw}); const bj=new Jar(); await call(bj,'POST','/api/account/login',{username:bob,password:upw});
globalThis.__bobJar = bj;
// ---- 2 rooms
r = await call(null,'POST','/api/web/room-create',{topic:'x'}); rec('2.room-create-requires-login', r.s===401, `status ${r.s}`);
const host = new Jar(); await call(host,'POST','/api/account/login',{username:bob,password:upw});
r = await call(host,'POST','/api/web/room-create',{topic:'E2E '+sfx, displayName:'Bob'}); const code = r.j?.code ?? r.j?.room?.code; const hostKey = r.j?.hostKey; rec('2.human-room-create', (r.s===200||r.s===201)&&!!code, `status ${r.s} code=${code}`);
const mcp = new Client({name:'e2e',version:'0'}); await mcp.connect(new StreamableHTTPClientTransport(new URL(B+'/mcp')));
const tools=(await mcp.listTools()).tools.map(t=>t.name); const cr = await mcp.callTool({name:'room_create',arguments:{topic:'t',name:'Agent'}});
rec('2.mcp-room_create-rejected', !tools.includes('room_create') && cr.isError===true && /signed-in user/.test(cr.content?.[0]?.text??''), `listed=${tools.includes('room_create')}`);
const pj = v => JSON.parse(v.content[0].text);
const inv = async () => (await call(host,'POST','/api/room',{action:'createAgentInvite',code,hostKey,role:'coder'})).j?.invite?.inviteCode;
const ic1 = await inv(); rec('2.agent-invite-code', !!ic1, String(ic1).slice(0,8));
let j = pj(await mcp.callTool({name:'room_join',arguments:{code,name:'Coder',inviteCode:ic1}})); const seatKey=j.seatKey; rec('2.agent-join-cursor-absolute', typeof j.cursor==='number', `cursor=${j.cursor}`);
let total=0; for (let i=0;i<1060;i++){ const x = await call(host,'POST','/api/web/chat-send',{code,text:`m${i}`}); if (x.s!==200) { rec('2.bulk-send', false, `i=${i} status ${x.s} ${JSON.stringify(x.j)}`); break; } total++; }
const llen = Number((await call(null,'POST','/x',undefined)).s && 0);
const cnt = Number((await proxy(host,['GET',`room-msg-count:${code}`])).j?.result); j = pj(await mcp.callTool({name:'room_join',arguments:{code,name:'Coder',seatKey}}));
rec('2.retention-cursor-after-1060', j.cursor===Number((await proxy(host,['GET',`room-msg-count:${code}`])).j?.result) && j.cursor>1060, `cursor=${j.cursor} count(before rejoin)=${cnt}`);
const ll = Number((await proxy(host,['LLEN',`room-msgs:${code}`])).j?.result); rec('2.retention-cap-1000', ll===1000, `llen=${ll}`);
globalThis.__seatKey2 = j.seatKey;
(await import('node:fs')).writeFileSync('/home/box/MERYANG/localtest/ctx.json', JSON.stringify({code,hostKey,hostCookie:host.hdr()}));
// ---- 3 invites
r = await call(host,'POST','/api/web/invite',{code}); const tok = r.j?.token; rec('3.invite-create', r.s===201&&!!tok, `status ${r.s}`);
const guest = new Jar(); r = await call(guest,'POST','/api/web/invite-accept',{token:tok,displayName:'Gina'});
const gc=(r.h.getSetCookie?.()??[]).find(c=>c.startsWith('ar_guest'))??''; rec('3.guest-token', r.s===200 && r.j?.role==='guest' && /Max-Age=86400/.test(gc), `status ${r.s} ${gc.replace(/=[^;]+/,'=…')}`);
r = await call(guest,'POST','/api/web/chat-send',{code,text:'hi from guest'}); rec('3.guest-chat-send', r.s===200, `status ${r.s}`);
r = await call(guest,'POST','/api/web/host',{code,op:'end'}); rec('3.guest-host-op-403', r.s===403, `status ${r.s}`);
r = await call(guest,'POST','/api/web/invite',{code}); rec('3.guest-invite-403', r.s===403, `status ${r.s}`);
r = await proxy(guest,['SET',`room:${code}`,'x']); rec('3.proxy-rejects-SET', r.s===403, `status ${r.s}`);
r = await proxy(guest,['EVAL','return 1','0']); rec('3.proxy-rejects-EVAL', r.s===403, `status ${r.s}`);
r = await proxy(guest,[['GET',`room:${code}`],['DEL',`room:${code}`]],true); rec('3.proxy-rejects-pipeline-write', r.s===403, `status ${r.s}`);
r = await proxy(guest,['GET',`room:${code}`]); rec('3.proxy-read-with-guest-token', r.s===200 && !!r.j?.result, `status ${r.s}`);
r = await proxy(null,['GET',`room:${code}`]); rec('3.proxy-read-without-token-rejected', r.s===401||r.s===403, `status ${r.s}`);
r = await proxy(null,['LRANGE',`room-msgs:${code}`,'0','1']); rec('3.proxy-lrange-without-token-rejected', r.s===401||r.s===403, `status ${r.s}`);
r = await proxy(guest,['GET',`session:abc`]); rec('3.proxy-sensitive-prefix-rejected', r.s===403, `status ${r.s}`);
r = await call(null,'POST','/api/web/chat-send',{code,text:'anon'}); rec('3.anon-write-401', r.s===401, `status ${r.s}`);
// ---- 5 tasks
const icR = (await call(host,'POST','/api/room',{action:'createAgentInvite',code,hostKey,role:'reviewer'})).j?.invite?.inviteCode; const rv = pj(await mcp.callTool({name:'room_join',arguments:{code,name:'Reviewer',inviteCode:icR}})); const rvKey = rv.seatKey;
r = await call(host,'POST','/api/web/task',{code,op:'create',title:'E2E task',owner:'Coder',ownerClient:'cc',verifier:'Reviewer',verifierClient:'cc',dod:'done'});
const taskId = r.j?.task?.id; rec('5.task-create-real-redis', r.s===200 && !!taskId, `status ${r.s} ${r.s!==200?JSON.stringify(r.j):''}`);
const cl = await mcp.callTool({name:'room_task',arguments:{code,name:'Coder',seatKey:globalThis.__seatKey2??seatKey,action:'claim',id:taskId}}).catch(e=>({isError:true,content:[{text:String(e)}]}));
rec('5.agent-claim', !cl.isError && !/"error"/.test(cl.content?.[0]?.text??''), (cl.content?.[0]?.text??'').slice(0,120));
const sb = await mcp.callTool({name:'room_task',arguments:{code,name:'Coder',seatKey:globalThis.__seatKey2??seatKey,action:'submit',id:taskId,fileListing:'a.txt',fileExcerpt:'b',checks:'c'}}).catch(e=>({isError:true,content:[{text:String(e)}]}));
rec('5.agent-submit', !sb.isError && !/"error"/.test(sb.content?.[0]?.text??''), (sb.content?.[0]?.text??'').slice(0,160));
const vf = await mcp.callTool({name:'room_task',arguments:{code,name:'Reviewer',seatKey:rvKey,action:'verify',id:taskId,verdict:'done',note:'ok'}}); rec('5.agent-verify-done', !/"error"/.test(vf.content?.[0]?.text??''), (vf.content?.[0]?.text??'').slice(0,100));
r = await call(host,'POST','/api/web/task',{code,op:'create',title:'E2E task 2',owner:'Coder',ownerClient:'cc',dod:'x'}); const t2=r.j?.task?.id; r = await call(host,'POST','/api/web/task',{code,op:'cancel',id:t2,reason:'e2e'}); rec('5.web-cancel', r.s===200 && r.j?.task?.state==='cancelled', `status ${r.s} state=${r.j?.task?.state}`);
r = await proxy(host,['GET',`task-board:${code}`]); rec('5.board-persisted', r.s===200 && String(r.j?.result).includes(taskId), `status ${r.s}`);
r = await call(guest,'POST','/api/web/task',{code,op:'verify',id:taskId,verdict:'done'}); rec('5.guest-verify-403', r.s===403, `status ${r.s}`);
await mcp.close();
(await import('node:fs')).writeFileSync('/home/box/MERYANG/localtest/results-123.json', JSON.stringify({code, results}, null, 1));
console.log(`\n${results.filter(x=>x.ok).length}/${results.length} passed`);
