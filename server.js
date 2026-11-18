// YGO 2.0 server — Express + SQLite, with ocgcore (WebAssembly) as the rules engine.
// Accounts · avatars · .ydk import · deck builder (classic / modern) · duel vs bot · quick match · invites.
import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { db, now } from './db.js';
import { attachUser, requireUser, csrfGuard, hashPassword, checkPassword, validateCredentials, startSession, endSession, throttle } from './auth.js';
import { searchCards } from './engine.js';
import * as Cards from './cards.js';
import * as Decks from './decks.js';
import * as Lobby from './lobby.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const app = express();
app.disable('x-powered-by');
if (process.env.TRUST_PROXY) app.set('trust proxy', 1);
app.set('view engine', 'ejs'); app.set('views', path.join(__dirname, 'views'));
app.use((req, res, next) => { res.set({ 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'same-origin' }); next(); });
app.use('/images', express.static(path.join(__dirname, 'views', 'images')));
app.use('/static', express.static(path.join(__dirname, 'public')));
app.use(express.json({ limit: '300kb' }));
app.use(attachUser);
app.use('/api', csrfGuard);

const wrap = fn => async (req, res, next) => { try { await fn(req, res, next); } catch (e) { next(e); } };
const fail = (res, error, status = 400) => res.status(status).json({ error });
const noStore = (req, res, next) => { res.set('Cache-Control', 'no-store'); next(); };

// ================================================================== pages
const safeNext = n => (typeof n === 'string' && /^\/[A-Za-z0-9/_\-?=&.%]*$/.test(n) && !n.startsWith('//') ? n : '/');
const page = (view, name) => (req, res) => res.render(view, { page: name, next: safeNext(req.query.next) });
app.get('/', page('menu', 'home'));
app.get('/login', (req, res) => req.user ? res.redirect(safeNext(req.query.next)) : res.render('login', { page: 'login', next: safeNext(req.query.next), tab: 'login' }));
app.get('/register', (req, res) => req.user ? res.redirect('/') : res.render('login', { page: 'login', next: safeNext(req.query.next), tab: 'register' }));
app.get('/profile', requireUser, page('profile', 'profile'));
app.get('/decks', requireUser, page('decks', 'decks'));
app.get('/upload', (req, res) => res.redirect('/decks#upload'));
app.get('/builder', requireUser, page('builder', 'builder'));
app.get('/duel', requireUser, page('duel-setup', 'duel'));
app.get('/duel/play', requireUser, page('duel', 'play'));
app.get('/invite/:code', (req, res) => req.user ? res.redirect('/duel?invite=' + encodeURIComponent(req.params.code)) : res.redirect('/login?next=' + encodeURIComponent('/invite/' + req.params.code)));

// ================================================================== auth + profile
app.post('/api/auth/register', wrap((req, res) => {
  const { username, password } = req.body || {}; const bad = validateCredentials(username, password); if (bad) return fail(res, bad);
  if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) return fail(res, 'That username is taken.', 409);
  const id = Number(db.prepare('INSERT INTO users (username, pass, created_at) VALUES (?,?,?)').run(username, hashPassword(password), now()).lastInsertRowid);
  Decks.seedStarterDecks(id); startSession(res, id); res.json({ ok: true });
}));
app.post('/api/auth/login', wrap((req, res) => {
  const { username, password } = req.body || {}, k = throttle.key(req, username);
  if (throttle.blocked(k)) return fail(res, 'Too many attempts. Wait a minute and try again.', 429);
  const u = typeof username === 'string' && typeof password === 'string' ? db.prepare('SELECT id, pass FROM users WHERE username = ?').get(username) : null;
  if (!u || !checkPassword(password, u.pass)) { throttle.fail(k); return fail(res, 'Wrong username or password.', 401); }
  throttle.ok(k); startSession(res, u.id); res.json({ ok: true });
}));
app.post('/api/auth/logout', wrap((req, res) => { if (req.user) Lobby.leaveQueue(req.user.id); endSession(req, res); res.json({ ok: true }); }));
app.get('/api/me', requireUser, noStore, (req, res) => res.json({ user: req.user }));
app.patch('/api/me', requireUser, wrap((req, res) => {
  const b = req.body || {}, avatar = Decks.Inv.cleanAvatar(b.avatar), frame = Decks.Inv.cleanFrame(b.frame);
  db.prepare('UPDATE users SET avatar = ?, frame = ? WHERE id = ?').run(avatar, frame, req.user.id); res.json({ ok: true, avatar, frame });
}));
app.get('/api/avatars', (req, res) => res.json({ avatars: Decks.Inv.avatars(), frames: Decks.Inv.frames() }));

// ================================================================== cards
const modeOf = v => v === 'modern' ? 'modern' : 'classic';
app.get('/api/cards/meta', (req, res) => res.json({ ...Cards.meta(), owners: Object.entries(Decks.Inv.OWNERS).map(([id, o]) => ({ id, name: o.name, portrait: o.portrait })) }));
app.get('/api/cards/search', (req, res) => { const q = String(req.query.q || '').slice(0, 60); res.json({ cards: q.length < 2 ? [] : searchCards(q) }); });  // "declare a card" prompts
app.get('/api/cards', (req, res) => res.json(Cards.search(req.query, modeOf(req.query.mode))));

// ================================================================== decks (per user)
const detail = d => {
  const group = ids => { const m = new Map(); for (const i of ids) { const c = Cards.briefById(i); if (!c) continue; const e = m.get(Cards.canon(i)) || { ...c, copies: 0, script: { status: c.script, kinds: [] } }; e.copies++; m.set(Cards.canon(i), e); } return [...m.values()]; };
  return { ...Decks.listDecks(d.user_id).find(x => x.id === d.id), main: group(d.main), extra: group(d.extra), side: group(d.side), warnings: [] };
};
const saveMsg = (uid, id, what) => { const s = Decks.listDecks(uid).find(d => d.id === id); return { id, warnings: [...(s.errors || []), ...(s.warnings || [])], message: s.valid ? `Deck ${what}.` : 'Deck saved as a draft — it is not legal yet.' }; };
app.get('/api/decks', requireUser, noStore, (req, res) => res.json({ decks: Decks.listDecks(req.user.id) }));
app.post('/api/decks/import', requireUser, wrap((req, res) => {
  const b = req.body || {};
  try {
    const r = Decks.importYdk(req.user.id, b.text, { name: String(b.name || '').trim() || undefined, mode: b.mode });
    const bits = []; if (r.skipped.length) bits.push(`${r.skipped.length} unknown card(s) skipped`); if (r.dropped.length) bits.push(`${r.dropped.length} card(s) not allowed in Classic left out`);
    if (!r.deck.valid) bits.push('not legal yet: ' + r.deck.errors[0]);
    res.json({ ...r, message: `Imported as a ${r.mode} deck` + (bits.length ? ' — ' + bits.join('; ').replace(/\.+$/, '') + '.' : '.') });
  } catch (e) { res.status(e.status || 500).json({ error: e.message, skipped: e.skipped || [] }); }
}));
app.post('/api/decks/custom', requireUser, wrap((req, res) => { try { res.json(saveMsg(req.user.id, Decks.saveDeck(req.user.id, null, req.body || {}), 'created')); } catch (e) { fail(res, e.message, e.status || 500); } }));
app.get('/api/decks/:id/ids', requireUser, (req, res) => { const d = Decks.getDeck(req.user.id, req.params.id); if (!d) return fail(res, 'Deck not found', 404); res.json({ id: d.id, name: d.name, mode: d.mode, owner: d.owner, avatar: d.avatar, frame: d.frame, builtin: false, main: d.main, extra: d.extra, side: d.side }); });
app.get('/api/decks/:id/export', requireUser, (req, res) => { const x = Decks.exportYdk(req.user.id, req.params.id); if (!x) return fail(res, 'Deck not found', 404); res.type('text/plain').set('Content-Disposition', `attachment; filename="${x.name.replace(/[^\w.-]+/g, '_')}.ydk"`).send(x.text); });
app.get('/api/decks/:id', requireUser, (req, res) => { const d = Decks.getDeck(req.user.id, req.params.id); if (!d) return fail(res, 'Deck not found', 404); res.json(detail({ ...d, user_id: req.user.id })); });
app.put('/api/decks/:id', requireUser, wrap((req, res) => { const id = Decks.saveDeck(req.user.id, req.params.id, req.body || {}); if (!id) return fail(res, 'Deck not found', 404); res.json(saveMsg(req.user.id, id, 'saved')); }));
app.patch('/api/decks/:id', requireUser, (req, res) => Decks.renameDeck(req.user.id, req.params.id, (req.body || {}).name) ? res.json({ ok: true }) : fail(res, 'Deck not found', 404));
app.delete('/api/decks/:id', requireUser, (req, res) => Decks.deleteDeck(req.user.id, req.params.id) ? res.json({ ok: true }) : fail(res, 'Deck not found', 404));

// ================================================================== scan a physical deck: photo -> OCR (Python) -> card list
// The Python scanner (ocr/scan.py) reads card NAMES + a few words of effect text and matches them to the card database.
// Node just hands it the photo and returns its report; the browser lets the player fix mistakes, then imports the deck.
// Python for the scanner: PYTHON_BIN if set, else the project's own ocr/.venv (made by uv/venv), else the system python3.
const venvPy = [path.join(__dirname, 'ocr', '.venv', 'bin', 'python'), path.join(__dirname, 'ocr', '.venv', 'Scripts', 'python.exe')].find(f => fs.existsSync(f));
const PY = process.env.PYTHON_BIN || venvPy || 'python3', SCAN = path.join(__dirname, 'ocr', 'scan.py');
const SCAN_TIMEOUT_MS = +process.env.SCAN_TIMEOUT_MS || 300_000;
let scanQueue = Promise.resolve(), scanWaiting = 0, scanOk = { at: 0, ok: false };
const sniff = b => b.length > 12 && ((b[0] === 0xff && b[1] === 0xd8) ? 'jpg' : (b[0] === 0x89 && b.toString('latin1', 1, 4) === 'PNG') ? 'png' : (b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') ? 'webp' : null);
function run(cmd, args, timeoutMs) {
  return new Promise(resolve => {
    let out = '', err = '', done = false;
    const c = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const fin = r => { if (!done) { done = true; clearTimeout(t); resolve(r); } };
    const t = setTimeout(() => { c.kill('SIGKILL'); fin({ code: -1, out, err: err + '\ntimeout' }); }, timeoutMs);
    c.stdout.on('data', d => { if (out.length < 20e6) out += d; }); c.stderr.on('data', d => { err = (err + d).slice(-4000); });
    c.on('error', e => fin({ code: -2, out, err: String(e.code || e.message) })); c.on('close', code => fin({ code, out, err }));
  });
}
async function scanAvailable() {
  if (Date.now() - scanOk.at < 60_000) return scanOk.ok;
  const r = await run(PY, ['-c', 'import rapidocr_onnxruntime, cv2, rapidfuzz, numpy, PIL'], 30_000);
  if (r.code !== 0 && scanOk.ok !== false) console.warn(`[scan] photo scanning unavailable with "${PY}": ${(r.err.trim().split('\n').pop() || 'python not found')} — see ocr/README.md ("Python version")`);
  scanOk = { at: Date.now(), ok: r.code === 0 }; return scanOk.ok;
}
app.get('/api/decks/scan/status', requireUser, wrap(async (req, res) => res.json({ available: await scanAvailable() })));
// Scans take 30-100 s on a small CPU, longer than many proxies hold a request open (Cloudflare: 100 s). So the upload returns a
// job id at once and the page polls GET /api/decks/scan/:id until the job is done.
const scanJobs = new Map();                                    // id -> { user, state: queued|running|done|error, result?, error?, at }
setInterval(() => { for (const [k, j] of scanJobs) if (Date.now() - j.at > 15 * 60_000) scanJobs.delete(k); }, 60_000).unref();
async function runScan(job, body, ext) {
  const id = crypto.randomBytes(8).toString('hex'), img = path.join(os.tmpdir(), `ygo-scan-${id}.${ext}`), ann = path.join(os.tmpdir(), `ygo-scan-${id}-marked.jpg`);
  job.state = 'running';
  try {
    fs.writeFileSync(img, body);
    const r = await run(PY, [SCAN, img, '--stdout-json', '--annotate', ann], SCAN_TIMEOUT_MS);
    let j = null; try { j = JSON.parse(r.out); } catch { /* not JSON */ }
    if (!j || !j.ok) {
      const miss = /ModuleNotFoundError|ENOENT/.test(r.err + (j && j.error || '')); console.error('[scan]', r.code, r.err.slice(-500));
      job.state = 'error'; job.error = miss ? 'Photo scanning is not installed on this server.' : (j && j.error) || (r.err.includes('timeout') ? 'The scan took too long. Try a smaller photo with fewer cards.' : 'The scan failed.'); return;
    }
    for (const c of j.cards) { c.classic = Cards.allowed(c.id, 'classic'); c.image = '/pics/s/' + c.id + '.jpg'; }
    j.annotated = fs.existsSync(ann) ? 'data:image/jpeg;base64,' + fs.readFileSync(ann).toString('base64') : null;
    job.state = 'done'; job.result = j;
  } catch (e) { console.error('[scan]', e); job.state = 'error'; job.error = 'The scan failed.'; }
  finally { job.at = Date.now(); for (const f of [img, ann]) fs.rm(f, { force: true }, () => {}); }
}
app.post('/api/decks/scan', requireUser, express.raw({ type: ['image/jpeg', 'image/png', 'image/webp'], limit: '12mb' }), wrap(async (req, res) => {
  const body = req.body, ext = Buffer.isBuffer(body) ? sniff(body) : null;
  if (!ext) return fail(res, 'Send one JPEG, PNG or WebP photo as the request body (max 12 MB).');
  if (!(await scanAvailable())) return fail(res, 'Photo scanning is not installed on this server (needs Python 3.9-3.12 and: pip install -r ocr/requirements.txt; see ocr/README.md).', 503);
  const mine = [...scanJobs.values()].filter(j => j.user === req.user.id && (j.state === 'queued' || j.state === 'running')).length;
  if (mine >= 2 || [...scanJobs.values()].filter(j => j.state === 'queued').length >= 6) return fail(res, 'The scanner is busy with other photos. Try again in a minute.', 429);
  const id = crypto.randomBytes(12).toString('hex'), job = { user: req.user.id, state: 'queued', at: Date.now() };
  scanJobs.set(id, job);
  scanQueue = scanQueue.then(() => runScan(job, body, ext));   // one scan at a time: OCR uses all of the CPU
  res.status(202).json({ id });
}));
app.get('/api/decks/scan/:id', requireUser, noStore, (req, res) => {
  const j = scanJobs.get(req.params.id); if (!j || j.user !== req.user.id) return fail(res, 'Scan not found (results are kept for 15 minutes).', 404);
  const ahead = j.state === 'queued' ? [...scanJobs.values()].filter(o => o !== j && (o.state === 'queued' || o.state === 'running') && o.at <= j.at).length : 0;
  res.json({ state: j.state, ahead, error: j.error, result: j.state === 'done' ? j.result : undefined });
});

// ================================================================== lobby: presence, quick match, bot, invites
app.get('/api/bots', requireUser, (req, res) => res.json({ bots: Decks.BOTS.map(b => ({ key: b.key, name: b.name, deckName: b.deckName, portrait: b.portrait, frame: b.frame, mode: b.mode })) }));
const duelStatus = uid => Lobby.inDuel(uid) ? 'started' : Lobby.inQueue(uid) ? 'waiting' : 'idle';
app.get('/api/lobby/poll', requireUser, noStore, (req, res) => {
  Lobby.touch(req.user.id);
  res.json({ status: duelStatus(req.user.id), online: Lobby.onlineUsers(req.user.id), incoming: Lobby.incoming(req.user.id), outgoing: Lobby.outgoing(req.user.id) });
});
app.get('/api/duel/lobby', requireUser, noStore, (req, res) => { Lobby.touch(req.user.id); const d = Lobby.duelOf(req.user.id); res.json({ status: duelStatus(req.user.id), mode: d ? d.rec.mode : undefined }); });
app.post('/api/duel/bot', requireUser, wrap((req, res) => { const b = req.body || {}; Lobby.touch(req.user.id); const r = Lobby.startBot(req.user, b.deckId, modeOf(b.mode), b.bot); r.error ? fail(res, r.error) : res.json(r); }));
app.post('/api/duel/join', requireUser, wrap((req, res) => { const b = req.body || {}; Lobby.touch(req.user.id); const r = Lobby.joinQueue(req.user, b.deckId ?? b.playerDeck, modeOf(b.mode)); r.error ? fail(res, r.error) : res.json(r); }));
app.post('/api/duel/leave', requireUser, (req, res) => { Lobby.leaveQueue(req.user.id); res.json({ ok: true }); });
app.post('/api/invites', requireUser, wrap((req, res) => { const b = req.body || {}; const r = Lobby.createInvite(req.user, { to: b.to, mode: b.mode, deckId: b.deckId, link: !!b.link }); r.error ? fail(res, r.error) : res.json(r); }));
app.get('/api/invites/code/:code', requireUser, (req, res) => { const i = Lobby.inviteByCode(req.params.code); i && i.status === 'pending' && i.expiresAt > now() ? res.json({ invite: i }) : fail(res, 'That invitation is no longer available.', 404); });
app.post('/api/invites/:id/accept', requireUser, wrap((req, res) => { Lobby.touch(req.user.id); const r = Lobby.acceptInvite(req.user, Number(req.params.id), (req.body || {}).deckId); r.error ? fail(res, r.error, 409) : res.json(r); }));
app.post('/api/invites/:id/decline', requireUser, (req, res) => { const r = Lobby.closeInvite(req.user, Number(req.params.id), 'declined'); r.error ? fail(res, r.error) : res.json(r); });
app.post('/api/invites/:id/cancel', requireUser, (req, res) => { const r = Lobby.closeInvite(req.user, Number(req.params.id), 'cancelled'); r.error ? fail(res, r.error) : res.json(r); });

// ================================================================== the duel itself (same client protocol as before)
app.get('/api/duel/state', requireUser, noStore, (req, res) => { const d = Lobby.duelOf(req.user.id); if (!d) return fail(res, 'No duel in progress', 404); Lobby.touch(req.user.id); Lobby.touchSeat(req.user.id); res.json(d.rec.match.act(d.seat, 'state')); });
app.post('/api/duel/act', requireUser, wrap(async (req, res) => {
  const d = Lobby.duelOf(req.user.id); if (!d) return fail(res, 'No duel in progress', 404);
  Lobby.touch(req.user.id); Lobby.touchSeat(req.user.id);
  const { type, ...payload } = req.body || {}; res.json(await d.rec.match.act(d.seat, String(type || ''), payload));
}));

// ================================================================== card art (fetched by passcode, cached in ./pics)
const ART = process.env.ART_BASE || 'https://images.ygoprodeck.com/images'; const inflight = new Map();
const KINDS = { '': ['cards', 'pics'], c: ['cards_cropped', 'pics/cropped'], s: ['cards_small', 'pics/small'] };
async function artFile(kind, id) {
  const [remote, dirName] = KINDS[kind], dir = path.join(__dirname, dirName), f = path.join(dir, id + '.jpg'); if (fs.existsSync(f)) return f;
  if (!inflight.has(f)) inflight.set(f, (async () => { try { const r = await fetch(`${ART}/${remote}/${id}.jpg`, { signal: AbortSignal.timeout(10000), headers: { 'user-agent': 'ygo-2-0/2.0' } });
    if (!r.ok) return null; fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(f, Buffer.from(await r.arrayBuffer())); return f; } catch { return null; } finally { inflight.delete(f); } })());
  return inflight.get(f);
}
const sendArt = kind => async (req, res) => { const m = /^(\d{1,10})\.jpg$/.exec(req.params.file); const f = m && await artFile(kind, m[1]); if (!f) return res.sendStatus(404); res.set('cache-control', 'max-age=604800').type('jpg').send(fs.readFileSync(f)); };
app.get('/pics/c/:file', sendArt('c')); app.get('/pics/s/:file', sendArt('s')); app.get('/pics/:file', sendArt(''));

app.use((err, req, res, next) => { console.error(err); res.status(err.status || 500); if (req.path.startsWith('/api')) res.json({ error: err.message }); else res.send('Something went wrong.'); });
process.on('unhandledRejection', e => console.error('[unhandledRejection]', e));
app.listen(PORT, () => console.log(`\nYGO 2.0 → http://localhost:${PORT}/   (classic pool: ${Cards.classicCount} cards, ${Decks.BOTS.length} bot duelists)\n`));
