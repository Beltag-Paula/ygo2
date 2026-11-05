// End-to-end test: boots the real server on a temp database, then exercises accounts, decks, classic/modern rules,
// a full duel against the bot, an invitation duel between two players, and quick match.   Run: npm test
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { Bot } from '../bot.js';

const PORT = process.env.TEST_PORT || 3391, BASE = `http://localhost:${PORT}`, DB = `/tmp/ygo-e2e-${process.pid}.db`;
const server = spawn('node', ['server.js'], { env: { ...process.env, PORT, DB_PATH: DB }, stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise((res, rej) => { server.stdout.on('data', d => String(d).includes('YGO 2.0') && res()); server.on('exit', c => rej(new Error('server exited ' + c))); setTimeout(() => rej(new Error('server start timeout')), 30000); });

let pass = 0, failN = 0;
const ok = (c, m) => { c ? pass++ : failN++; console.log((c ? '  ✔ ' : '  ✘ ') + m); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

class Client {
  constructor(name) { this.name = name; this.cookie = ''; }
  async call(method, url, body, headers = { 'x-requested-with': 'ygo' }) {
    const r = await fetch(BASE + url, { method, redirect: 'manual', headers: { 'content-type': 'application/json', cookie: this.cookie, ...headers }, body: body ? JSON.stringify(body) : undefined });
    const sc = r.headers.getSetCookie?.() || []; for (const c of sc) { const kv = c.split(';')[0]; if (kv.endsWith('=')) this.cookie = ''; else this.cookie = kv; }
    let j = null; try { j = await r.json(); } catch { /* not json */ } return { s: r.status, j };
  }
  get = u => this.call('GET', u); post = (u, b) => this.call('POST', u, b || {});
}

console.log('\nAccounts');
const alice = new Client('alice'), bob = new Client('bob');
ok((await alice.post('/api/auth/register', { username: 'al', password: 'longenough1' })).s === 400, 'rejects a too-short username');
ok((await alice.post('/api/auth/register', { username: 'alice', password: 'short' })).s === 400, 'rejects a short password');
ok((await alice.post('/api/auth/register', { username: 'alice', password: 'correct horse' })).s === 200, 'registers alice');
ok((await bob.post('/api/auth/register', { username: 'bob', password: 'battery staple' })).s === 200, 'registers bob');
ok((await new Client('x').post('/api/auth/register', { username: 'ALICE', password: 'correct horse' })).s === 409, 'usernames are unique (case-insensitive)');
ok((await new Client('x').post('/api/auth/login', { username: 'alice', password: 'nope nope nope' })).s === 401, 'wrong password is refused');
ok((await new Client('x').call('POST', '/api/auth/login', { username: 'alice', password: 'correct horse' }, {})).s === 403, 'API writes without the CSRF header are refused');
ok((await new Client('x').get('/api/decks')).s === 401, 'decks need a login');
ok((await alice.get('/api/me')).j.user.username === 'alice', 'session cookie works');

console.log('\nDecks');
const decks = (await alice.get('/api/decks')).j.decks;
ok(decks.length >= 5 && decks.every(d => d.valid && d.mode === 'classic'), `new account gets ${decks.length} legal classic starter decks`);
const pool = (await alice.get('/api/cards?mode=classic&sort=newest&limit=40')).j.cards.filter(c => !c.extra).slice(0, 14).map(c => c.id);
const ydkClassic = '#main\n' + Array(42).fill(0).map((_, i) => pool[Math.floor(i / 3)]).join('\n') + '\n#extra\n!side\n';
const imp1 = await alice.post('/api/decks/import', { text: ydkClassic, name: 'Imported classic' });
ok(imp1.s === 200 && imp1.j.mode === 'classic' && imp1.j.deck.valid, 'imports a ygoprodeck-style .ydk as a legal Classic deck');
const link = (await alice.get('/api/cards?frame=link&mode=modern&limit=1')).j.cards[0];
ok((await alice.get('/api/cards?frame=link&mode=classic&limit=1')).j.total === 0 && link, 'Classic card pool contains no Link monsters, Modern does');
const imp2 = await alice.post('/api/decks/import', { text: '#main\n' + Array(40).fill(link.id).join('\n') + '\n', name: 'Modern import' });
ok(imp2.j.mode === 'modern', 'a .ydk with post-2008 cards is imported as Modern automatically');
const imp3 = await alice.post('/api/decks/import', { text: '#main\n46986414\n#extra\n' + link.id + '\n', name: 'Forced classic', mode: 'classic' });
ok(imp3.j.dropped.length === 1, 'forcing Classic leaves out cards that are not allowed');
const custom = await alice.post('/api/decks/custom', { name: 'Draft', mode: 'classic', main: [46986414], extra: [], side: [] });
ok(custom.s === 200 && /draft/i.test(custom.j.message), 'builder saves an incomplete deck as a draft');
const draftId = custom.j.id;
ok((await alice.post('/api/duel/bot', { deckId: draftId, mode: 'classic' })).s === 400, 'an illegal deck cannot start a duel');
ok((await alice.post('/api/duel/bot', { deckId: imp2.j.id, mode: 'classic' })).s === 400, 'a Modern deck cannot be used in Classic mode');
ok((await bob.get('/api/decks/' + imp1.j.id)).s === 404, "players cannot see each other's decks");

console.log('\nDuel vs bot (full game driven by the same bot brain, over HTTP)');
const humanLoop = async (c, secs) => {
  const proxy = { over: false, seat: 0,
    async state() { const r = await c.get('/api/duel/state'); if (r.s !== 200) { proxy.over = true; return { view: { gameOver: true } }; } if (r.j.view.gameOver) proxy.over = true; return r.j; },
    async act(seat, type, payload) { const r = await c.post('/api/duel/act', { type, ...payload }); return r.j; } };
  const b = new Bot(proxy, 0, { delay: [5, 15] }); const t = setTimeout(() => b.stop(), secs * 1000); await b.run(); clearTimeout(t); return b;
};
const sr = await alice.post('/api/duel/bot', { deckId: decks[0].id, mode: 'classic', bot: 'kaiba' });
ok(sr.s === 200 && sr.j.status === 'started', 'starts a duel against Kaiba (CPU)');
let st = (await alice.get('/api/duel/state')).j.view;
ok(st.opp.name.includes('CPU') && st.you.name === 'alice', 'view shows the right duelists');
await humanLoop(alice, +process.env.DUEL_SECS || 35);
st = (await alice.get('/api/duel/state')).j.view;
ok(st.turn >= 4 || st.gameOver, `duel progressed (turn ${st.turn}${st.gameOver ? ', finished: ' + st.winner : ''}, LP ${st.you.lp}/${st.opp.lp})`);
if (!st.gameOver) await alice.post('/api/duel/act', { type: 'surrender' });
await sleep(5500);
const me = (await alice.get('/api/me')).j.user; ok(me.bot_wins + me.bot_losses === 1, 'result recorded in the database (vs-bot stats)');

console.log('\nInvites (alice → bob)');
const dB = (await bob.get('/api/decks')).j.decks[0], dA = decks[1];
await alice.get('/api/lobby/poll'); const pb = (await bob.get('/api/lobby/poll')).j;
ok(pb.online.some(u => u.username === 'alice'), 'bob sees alice online');
ok((await alice.post('/api/invites', { to: 'nobody', mode: 'classic', deckId: dA.id })).s === 400, 'inviting an unknown player fails');
const inv = await alice.post('/api/invites', { to: 'bob', mode: 'classic', deckId: dA.id });
ok(inv.s === 200, 'alice invites bob');
const pb2 = (await bob.get('/api/lobby/poll')).j; ok(pb2.incoming.length === 1 && pb2.incoming[0].from.name === 'alice', 'bob receives the invitation');
ok((await alice.post(`/api/invites/${inv.j.invite.id}/accept`, { deckId: dA.id })).s === 409, 'alice cannot accept her own invite');
const acc = await bob.post(`/api/invites/${inv.j.invite.id}/accept`, { deckId: dB.id });
ok(acc.s === 200 && acc.j.status === 'started', 'bob accepts and the duel starts');
const sa = (await alice.get('/api/duel/state')).j.view, sb = (await bob.get('/api/duel/state')).j.view;
ok(sa.opp.name === 'bob' && sb.opp.name === 'alice', 'both players are seated against each other');
const lobA = (await alice.get('/api/lobby/poll')).j; ok(lobA.status === 'started', "alice's lobby tells her client to open the duel");
await alice.post('/api/duel/act', { type: 'surrender' }); await sleep(5500);
const bobU = (await bob.get('/api/me')).j.user; ok(bobU.pvp_wins === 1, 'PvP win recorded for bob');

console.log('\nOffline invite + link invite');
const carol = new Client('carol'); await carol.post('/api/auth/register', { username: 'carol', password: 'carol carol' });
const cdeck = (await carol.get('/api/decks')).j.decks[0];
const erin = new Client('erin'); await erin.post('/api/auth/register', { username: 'erin', password: 'erin erin erin' });   // never polls -> offline
const edeck = (await erin.get('/api/decks')).j.decks[0];
const inv3 = await erin.post('/api/invites', { to: 'carol', mode: 'classic', deckId: edeck.id });
ok(inv3.s === 200 && inv3.j.invite.status === 'pending', 'a player can be invited at any time; the invitation waits for them');
await carol.get('/api/lobby/poll');
ok((await carol.get('/api/lobby/poll')).j.incoming.some(i => i.from.name === 'erin'), 'carol sees the pending invitation when she is online');
const off = await carol.post(`/api/invites/${inv3.j.invite.id}/accept`, { deckId: cdeck.id });
ok(off.s === 409 && /offline/.test(off.j.error), 'accepting while the sender is offline is refused with an explanation');
await alice.get('/api/lobby/poll');
const lk = await alice.post('/api/invites', { link: true, mode: 'classic', deckId: dA.id });
ok(lk.s === 200 && lk.j.invite.code, 'creates a shareable invite link');
ok((await carol.get('/api/invites/code/' + lk.j.invite.code)).s === 200, 'the link resolves for another player');
const ca = await carol.post(`/api/invites/${lk.j.invite.id}/accept`, { deckId: cdeck.id }); if (ca.s !== 200) console.log('    ->', ca.s, JSON.stringify(ca.j));
ok(ca.s === 200, 'carol accepts through the link');
await carol.post('/api/duel/act', { type: 'surrender' });

console.log('\nQuick match');
const dave = new Client('dave'); await dave.post('/api/auth/register', { username: 'dave', password: 'dave dave dave' }); const ddeck = (await dave.get('/api/decks')).j.decks[0];
await sleep(300); await bob.get('/api/lobby/poll'); await dave.get('/api/lobby/poll');
ok((await bob.post('/api/duel/join', { deckId: dB.id, mode: 'classic' })).j.status === 'waiting', 'first player waits in the queue');
ok((await dave.post('/api/duel/join', { deckId: ddeck.id, mode: 'classic' })).j.status === 'started', 'second player is matched immediately');
ok((await bob.get('/api/duel/lobby')).j.status === 'started', 'the waiting player is told the duel started');

console.log(`\n${pass} passed, ${failN} failed`);
server.kill(); for (const f of [DB, DB + '-wal', DB + '-shm']) fs.rmSync(f, { force: true });
process.exit(failN ? 1 : 0);
