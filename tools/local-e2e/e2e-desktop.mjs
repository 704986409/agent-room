// Desktop client e2e against local env (:3300 / Redis 6390). Mock agent CLI only.
import fs from 'node:fs'; import { spawn, execSync } from 'node:child_process';
const B = 'http://127.0.0.1:3300'; const L = '/home/box/MERYANG/localtest';
const DAEMON = '/home/box/MERYANG/agent-room-desktop/desktop/daemon-dist/agent-room-daemon.mjs';
const HOME = `${L}/dhome`; fs.rmSync(HOME, { recursive: true, force: true }); fs.mkdirSync(HOME, { recursive: true });
fs.rmSync(`${L}/mock-codex2.log`, { force: true });
const adm = Object.fromEntries(fs.readFileSync(`${L}/admin.txt`, 'utf8').trim().split('\n').map(l => l.split('=')));
const rc = (...a) => execSync(`redis-cli -p 6390 ${a.map(x => `'${x}'`).join(' ')}`).toString().trim();
const sleep = ms => new Promise(r => setTimeout(r, ms));
let cookie = '';
async function web(p, b, method = 'POST') { const r = await fetch(B + p, { method, headers: { 'content-type': 'application/json', origin: B, cookie }, body: method === 'GET' ? undefined : JSON.stringify(b ?? {}) }); for (const sc of r.headers.getSetCookie()) if (sc.startsWith('ar_session=')) cookie = sc.split(';')[0]; return { status: r.status, ...(await r.json().catch(() => ({}))) }; }
const results = []; const check = (name, ok, extra = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${name} ${extra}`); };
const env = { ...process.env, HOME, PATH: `${L}/mockbin2:${process.env.PATH}`, AGENT_ROOM_SERVER: B };
delete env.AGENT_ROOM_DEVICE_TOKEN;
let dlog = '';
function serve() {
  const d = spawn('node', [DAEMON, 'serve', '--server', B], { env });
  d.stdout.on('data', x => dlog += x); d.stderr.on('data', x => dlog += x);
  return new Promise((res, rej) => { const t = setInterval(() => { const m = /control: (\S+)/.exec(dlog.split('\n').filter(l => l.startsWith('control:')).pop() ?? ''); if (m) { clearInterval(t); res({ d, url: m[1] }); } }, 100); setTimeout(() => rej(new Error('no control url\n' + dlog)), 10000); });
}
async function ctl(base, path, body) { const u = new URL(base); const tok = u.searchParams.get('t'); const r = await fetch(`${u.origin}${path}`, { method: body ? 'POST' : 'GET', headers: { 'x-agent-room-control': tok, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, ...(await r.json().catch(() => ({}))) }; }
async function waitEvent(seatId, n) { for (let i = 0; i < 70; i++) { await sleep(1000); const keys = rc('--scan', '--pattern', `wake-evt:wk:*:${seatId}`).split('\n').filter(Boolean); const ok = keys.filter(k => JSON.parse(rc('GET', k)).state === 'SUCCEEDED').length; if (ok >= n) return true; } return false; }

await web('/api/account/login', { username: adm.ADMIN_USER, password: adm.ADMIN_PASS });
let { d, url } = await serve();
check('1.daemon-serves-control-page-unpaired', (await fetch(url)).status === 200, url.replace(/t=.*/, 't=***'));
check('1b.control-rejects-no-token', (await fetch(new URL(url).origin + '/api/status')).status === 401);
check('1c.control-rejects-foreign-origin', (await fetch(url.replace('/?', '/api/status?'), { headers: { origin: 'https://evil.example' } })).status === 403);
const ps = await web('/api/device/pair-start');
check('2.pair-start', ps.status === 201 && !!ps.pairingCode);
const pr = await ctl(url, '/api/pair', { pairingCode: ps.pairingCode });
check('2b.pair-complete-via-settings', pr.ok === true, pr.deviceId ?? JSON.stringify(pr));
check('2c.pairing-code-one-time', (await fetch(B + '/api/device/pair-complete', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pairingCode: ps.pairingCode, deviceName: 'x', platform: 'y' }) })).status === 400);
const devs = await web('/api/account/devices', null, 'GET');
const dev = devs.devices?.find(x => x.deviceId === pr.deviceId);
check('3.my-devices-lists-hostname-os', !!dev && dev.hostname === execSync('hostname').toString().trim(), dev ? `${dev.name} · ${dev.platform}` : JSON.stringify(devs));
const stateRaw = fs.readFileSync(`${HOME}/.local/state/agent-room/daemon.json`, 'utf8');
const credFiles = execSync(`find ${HOME} -type f -printf '%m %p\\n'`).toString();
check('3b.no-secret-in-state-file', !/ard_/.test(stateRaw), credFiles.trim().replace(/\n/g, ' | '));

const room = await web('/api/web/room-create', { topic: 'desktop e2e', displayName: 'Host' }); const code = room.code;
const ic = (await web('/api/room', { action: 'createAgentInvite', code, hostKey: room.hostKey, role: 'coder' })).invite.inviteCode;
const st = await ctl(url, '/api/agents', { code, inviteCode: ic, name: 'Desk', adapterId: 'codex', model: 'gpt-6-luna', cwd: '/tmp' });
const seat = st.seat;
check('4.first-launch-session-pid-cwd', !!seat?.sessionId && !!seat?.pid && seat.cwd === '/tmp', JSON.stringify(seat ?? st));
check('4b.model-allowlist-enforced', (await ctl(url, '/api/agents', { code, inviteCode: ic, name: 'Bad', adapterId: 'cursor-agent', model: 'claude-opus-5', cwd: '/tmp' })).status >= 400);
await sleep(2500);
const ml = fs.existsSync(`${L}/mock-codex2.log`) ? fs.readFileSync(`${L}/mock-codex2.log`, 'utf8') : '';
check('4c.seatKey-via-env-not-prompt', /seatKeyEnv=yes promptHasKey=false/.test(ml) && /managed=1/.test(ml));
check('4d.state-file-has-seat-no-seatKey', (() => { const s = JSON.parse(fs.readFileSync(`${HOME}/.local/state/agent-room/daemon.json`, 'utf8')); return s.seats?.some(x => x.seatId === seat.seatId && x.sessionId === seat.sessionId) && !JSON.stringify(s).includes('seatKey'); })());

const t0 = Date.now();
await web('/api/web/chat-send', { code, text: `@Desk please reply` });
check('5.mention-wakes-daemon-resume', await waitEvent(seat.seatId, 1), `${Date.now() - t0}ms`);
const msgs = rc('LRANGE', `room-msgs:${code}`, '0', '-1');
check('5b.agent-replied-same-session', msgs.includes(`mock agent: done (${seat.sessionId})`));

d.kill('SIGTERM'); await sleep(1500); dlog = '';
({ d, url } = await serve());
const s2 = await ctl(url, '/api/status');
check('6.restart-recovery-state', JSON.stringify(s2).includes(seat.sessionId), JSON.stringify(s2.seats?.map(x => [x.status, x.sessionId])));
await web('/api/web/chat-send', { code, text: `@Desk again after restart` });
{ const ok6 = await waitEvent(seat.seatId, 2); check('6b.wake-after-restart', ok6, ok6 ? '' : fs.readdirSync(`${HOME}/.local/state/agent-room`).join(',') + ' ' + JSON.stringify((await ctl(url, '/api/status')).seats?.map(x => [x.status, x.pid]))); }

const rv = await web('/api/account/devices/revoke', { deviceId: pr.deviceId });
check('7.revoke-device', rv.ok === true);
await sleep(7000);
const s3 = await ctl(url, '/api/status');
check('7b.daemon-sees-revocation', /revoked|unauthorized|unpaired/i.test(JSON.stringify(s3)), JSON.stringify(s3).slice(0, 300));
const binding = rc('--scan', '--pattern', `wake-bind*${seat.seatId}*`).split('\n').filter(Boolean)[0];
check('7c.binding-revoked', binding ? /revoked/.test(rc('GET', binding)) : false, binding);
d.kill('SIGTERM');
fs.writeFileSync(`${L}/e2e-desktop.daemon.log`, dlog);
console.log(`${results.filter(Boolean).length}/${results.length} passed`); setTimeout(() => process.exit(0), 500);
