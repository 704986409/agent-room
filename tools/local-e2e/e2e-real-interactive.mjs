// ONE real interactive probe: agy gemini-3.8-flash-high on DISPLAY (Xvfb).
import fs from 'node:fs';
import { spawn, execSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const B = 'http://127.0.0.1:3300';
const L = '/home/box/MERYANG/localtest';
const DAEMON = '/home/box/MERYANG/agent-room-integration/desktop/daemon-dist/agent-room-daemon.mjs';
const R = `${L}/real-interactive`;
const REPORT = `${R}/report.json`;
fs.rmSync(R, { recursive: true, force: true });
fs.mkdirSync(R, { recursive: true });
fs.mkdirSync(`${R}/shots`, { recursive: true });

const adm = Object.fromEntries(fs.readFileSync(`${L}/admin.txt`, 'utf8').trim().split('\n').map(l => l.split('=')));
const rc = (...a) => execSync(`redis-cli -p 6390 ${a.map(x => `'${String(x).replace(/'/g, `'\\''`)}'`).join(' ')}`).toString().trim();
const sleep = ms => new Promise(r => setTimeout(r, ms));
const steps = [];
const note = (name, ok, extra = {}) => {
  const row = { name, ok: !!ok, at: new Date().toISOString(), ...extra };
  steps.push(row);
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`, extra.detail ?? '');
  return !!ok;
};

let cookie = '';
async function web(p, b, method = 'POST') {
  const r = await fetch(B + p, {
    method,
    headers: { 'content-type': 'application/json', origin: B, cookie },
    body: method === 'GET' ? undefined : JSON.stringify(b ?? {}),
  });
  for (const sc of r.headers.getSetCookie()) if (sc.startsWith('ar_session=')) cookie = sc.split(';')[0];
  return { status: r.status, ...(await r.json().catch(() => ({}))) };
}

function shot(name) {
  try {
    execSync(`python3 -c "from PIL import ImageGrab; ImageGrab.grab(xdisplay=':2').save('${R}/shots/${name}.png')"`, { timeout: 10000 });
    return `${R}/shots/${name}.png`;
  } catch (e) {
    return `shot-failed: ${e.message}`;
  }
}

function cliConfigHash() {
  try { return createHash('sha256').update(fs.readFileSync('/home/box/.cursor/cli-config.json')).digest('hex'); }
  catch { return 'missing'; }
}

const env = {
  ...process.env,
  DISPLAY: ':2',
  WAYLAND_DISPLAY: '',
  AGENT_ROOM_CONFIG_DIR: `${R}/config`,
  AGENT_ROOM_STATE_DIR: `${R}/state`,
  AGENT_ROOM_SERVER: B,
  AGENT_ROOM_AGY_MODE: 'auto', // interactive TUI, auto-approve tools on Xvfb
  // Keep real HOME so agy OAuth + MCP config apply
};

let dlog = '';
const d = spawn('node', [DAEMON, 'serve', '--server', B], { env });
d.stdout.on('data', x => { dlog += x; process.stdout.write(`[daemon] ${x}`); });
d.stderr.on('data', x => { dlog += x; process.stderr.write(`[daemon-err] ${x}`); });

const t0 = Date.now();
while (!/control: /.test(dlog) && Date.now() - t0 < 15000) await sleep(100);
const m = /control: (\S+)/.exec(dlog);
if (!m) {
  note('daemon-control', false, { detail: dlog.slice(-500) });
  fs.writeFileSync(REPORT, JSON.stringify({ steps, dlog }, null, 2));
  d.kill('SIGTERM');
  process.exit(1);
}
const url = new URL(m[1]);
const tok = url.searchParams.get('t');
note('daemon-control', true, { detail: url.origin, ms: Date.now() - t0 });

const ctl = async (p, body) => {
  const r = await fetch(url.origin + p, {
    method: body ? 'POST' : 'GET',
    headers: { 'x-agent-room-control': tok, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, ...(await r.json().catch(() => ({}))) };
};

const cfgHash0 = cliConfigHash();
const login = await web('/api/account/login', { username: adm.ADMIN_USER, password: adm.ADMIN_PASS });
note('admin-login', login.status === 200 && !!login.user, { detail: login.user?.username ?? login.error });

const ps = await web('/api/device/pair-start');
note('pair-start', ps.status === 201 && !!ps.pairingCode);
const pr = await ctl('/api/pair', { pairingCode: ps.pairingCode });
note('pair-complete', pr.ok === true, { detail: pr.deviceId });

const room = await web('/api/web/room-create', { topic: 'real interactive agy probe', displayName: 'Host' });
const code = room.code;
note('room-create', !!code, { detail: code });
const ic = (await web('/api/room', { action: 'createAgentInvite', code, hostKey: room.hostKey, role: 'coder' })).invite?.inviteCode;
note('agent-invite', !!ic);

const cwd = `${R}/workdir`;
fs.mkdirSync(cwd, { recursive: true });
execSync('git init -q', { cwd });

const tStart = Date.now();
const st = await ctl('/api/agents', {
  code,
  inviteCode: ic,
  name: 'Agy',
  adapterId: 'agy',
  model: 'gemini-3.8-flash-high',
  cwd,
});
const seat = st.seat;
note('start-agent', !!seat?.sessionId && !!seat?.pid, {
  detail: JSON.stringify(seat ?? st).slice(0, 400),
  ms: Date.now() - tStart,
});
const shotLaunch = shot('01-after-launch');
note('screenshot-launch', !String(shotLaunch).startsWith('shot-failed'), { detail: shotLaunch });

// Expect a terminal or agy process
await sleep(2000);
let term = '';
try { term = execSync("pgrep -af 'xfce4-terminal|agy.*gemini-3.8-flash-high|agy -i' || true").toString().trim(); } catch {}
note('interactive-process-visible', /xfce4-terminal|agy/.test(term), { detail: term.split('\n').slice(0, 5).join(' | ').slice(0, 400) });

// Wait for first-run to settle (join already done by daemon; agent may post online / sleep)
for (let i = 0; i < 45; i++) {
  await sleep(2000);
  if (cliConfigHash() !== cfgHash0) {
    note('cli-config-untouched', false, { detail: 'cli-config.json changed — killing agents' });
    try { execSync("pkill -f 'agy.*gemini-3.8|xfce4-terminal.*Agent Room' || true"); } catch {}
    break;
  }
  const status = await ctl('/api/status');
  const seatStatus = status.seats?.find(s => s.seatId === seat?.seatId)?.status;
  if (seatStatus === 'idle') break;
}
shot('02-after-first-run');

const tWake = Date.now();
await web('/api/web/chat-send', { code, text: '@Agy 请只回复一个词：收到' });
note('chat-mention', true);

let wakeOk = false;
let wakeState = 'none';
for (let i = 0; i < 90; i++) {
  await sleep(2000);
  if (cliConfigHash() !== cfgHash0) {
    note('cli-config-untouched', false, { detail: 'changed during wake' });
    try { execSync("pkill -f 'agy.*gemini-3.8|xfce4-terminal.*Agent Room' || true"); } catch {}
    break;
  }
  const keys = rc('--scan', '--pattern', `wake-evt:wk:*:${seat.seatId}`).split('\n').filter(Boolean);
  for (const k of keys) {
    const ev = JSON.parse(rc('GET', k));
    wakeState = ev.state;
    if (ev.state === 'SUCCEEDED' || ev.state === 'FAILED') { wakeOk = ev.state === 'SUCCEEDED'; break; }
  }
  if (wakeOk || wakeState === 'FAILED') break;
  if (i % 5 === 0) shot(`03-wake-${i}`);
}
note('wake-succeeded', wakeOk, { detail: wakeState, ms: Date.now() - tWake });
shot('04-after-wake');

let reply = '';
for (let i = 0; i < 30; i++) {
  await sleep(1000);
  const msgs = rc('LRANGE', `room-msgs:${code}`, '0', '-1');
  const lines = msgs.split('\n').map(x => { try { return JSON.parse(x); } catch { return null; } }).filter(Boolean);
  const fromAgy = lines.filter(m => m.name === 'Agy' || /收到|ok|OK/i.test(String(m.text)));
  reply = fromAgy.map(m => `${m.name}: ${String(m.text).slice(0, 120)}`).join(' || ');
  if (fromAgy.some(m => /收到/.test(String(m.text)))) break;
  if (fromAgy.length >= 2) break; // online + reply
}
note('agent-replied', /收到/.test(reply), { detail: reply.slice(0, 300) });

const handoff = rc('GET', `seat-handoff:${seat.roomInstanceId}:${seat.seatId}`);
note('room-sleep-handoff', !!handoff, { detail: handoff?.slice?.(0, 120) ?? handoff });

note('cli-config-untouched', cliConfigHash() === cfgHash0, { detail: cfgHash0.slice(0, 12) });

const passed = steps.filter(s => s.ok).length;
const failed = steps.filter(s => !s.ok).length;
console.log(`\n${passed}/${steps.length} steps passed (${failed} failed)`);
fs.writeFileSync(REPORT, JSON.stringify({ cli: 'agy', model: 'gemini-3.8-flash-high', code, seat, steps, reply, dlogTail: dlog.slice(-2000) }, null, 2));
fs.writeFileSync(`${R}/daemon.out`, dlog);
d.kill('SIGTERM');
await sleep(1500);
// Leave terminal/agy for screenshot inspection briefly then kill
try { execSync("pkill -f 'xfce4-terminal.*Agent Room|agy -i' || true"); } catch {}
process.exit(failed ? 1 : 0);
