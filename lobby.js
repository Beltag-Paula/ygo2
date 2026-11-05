// lobby.js — who is online, quick match, invites, and the registry of running duels (human vs human, human vs bot).
import crypto from 'node:crypto';
import { db, now } from './db.js';
import { Match } from './match.js';
import { Bot } from './bot.js';
import { getDeck, forMatch, check, BOTS, Inv } from './decks.js';

const ONLINE_MS = 25_000;          // a client polls every few seconds; silent for longer = offline
const AFK_FORFEIT_MS = 90_000;     // a human who stops answering mid-duel forfeits
const INVITE_MS = 24 * 3600_000;

const seen = new Map();                         // userId -> last poll time
export const touch = uid => { seen.set(uid, now()); };
export const isOnline = uid => now() - (seen.get(uid) || 0) < ONLINE_MS;

// ---- running duels ------------------------------------------------------------------------------
// duels: userId -> { rec, seat }.  rec = { match, mode, users:[uid|null, uid|null], bot, started, recorded, last:[t,t] }
const duels = new Map();
export const duelOf = uid => duels.get(uid) || null;
export const inDuel = uid => { const d = duels.get(uid); return !!d && !d.rec.match.over; };
export function touchSeat(uid) { const d = duels.get(uid); if (d) d.rec.last[d.seat] = now(); }

const queue = { classic: null, modern: null };
export const inQueue = uid => Object.values(queue).some(w => w && w.uid === uid);
export function leaveQueue(uid) { for (const k of Object.keys(queue)) if (queue[k] && queue[k].uid === uid) queue[k] = null; }

function player(user, deck) {
  const { main, extra } = forMatch(deck);
  return { uid: user.id, name: user.username, deckName: deck.name, avatar: Inv.cleanAvatar(user.avatar) || Inv.cleanAvatar(deck.avatar) || null, frame: Inv.cleanFrame(user.frame) || Inv.cleanFrame(deck.frame) || null, main, extra };
}
function launch(pair, mode, botInfo) {
  const order = Math.random() < 0.5 ? pair : [pair[1], pair[0]];
  const match = new Match(order, { rules: mode });
  const rec = { match, mode, users: order.map(p => p.uid ?? null), bot: botInfo || null, started: now(), recorded: false, last: [now(), now()] };
  order.forEach((p, seat) => { if (p.uid != null) duels.set(p.uid, { rec, seat }); });
  if (botInfo) { const seat = order.findIndex(p => p.uid == null); rec.botCtl = new Bot(match, seat, { mode, persona: botInfo.key }); rec.botCtl.run(); }
  return rec;
}
function validateFor(uid, deckId, mode) {
  const d = getDeck(uid, deckId); if (!d) return { error: 'Choose one of your decks first.' };
  if (d.mode !== mode && !(d.mode === 'classic' && mode === 'modern')) return { error: `"${d.name}" is a ${d.mode} deck — it can't be used in ${mode} mode.` };
  const c = check(d, mode); if (!c.valid) return { error: `"${d.name}" isn't a legal ${mode} deck: ${c.errors[0]}` };
  return { deck: d };
}
const busy = uid => inDuel(uid) ? 'You are already in a duel.' : null;

// ---- start paths --------------------------------------------------------------------------------
export function startBot(user, deckId, mode, botKey) {
  if (busy(user.id)) return { error: busy(user.id) };
  const v = validateFor(user.id, deckId, mode); if (v.error) return v;
  const bot = BOTS.find(b => b.key === botKey && (mode === 'modern' || b.mode === 'classic')) || BOTS.find(b => mode === 'modern' || b.mode === 'classic');
  if (!bot) return { error: 'No bot deck is available for that mode.' };
  leaveQueue(user.id);
  const { main, extra } = forMatch(bot.deck);
  launch([player(user, v.deck), { uid: null, name: bot.name + ' (CPU)', deckName: bot.deckName, avatar: bot.portrait, frame: bot.frame, main, extra }], mode, { key: bot.key, name: bot.name });
  return { status: 'started' };
}

export function joinQueue(user, deckId, mode) {
  if (busy(user.id)) return { error: busy(user.id) };
  const v = validateFor(user.id, deckId, mode); if (v.error) return v;
  leaveQueue(user.id);
  const me = player(user, v.deck), w = queue[mode];
  if (w && w.uid !== user.id && isOnline(w.uid) && !inDuel(w.uid)) { queue[mode] = null; launch([w.p, me], mode); return { status: 'started' }; }
  queue[mode] = { uid: user.id, p: me }; return { status: 'waiting' };
}

// ---- who is online ------------------------------------------------------------------------------
export function onlineUsers(exceptId) {
  const out = [];
  for (const [uid, t] of seen) if (uid !== exceptId && now() - t < ONLINE_MS) { const u = db.prepare('SELECT id, username, avatar, frame, pvp_wins, pvp_losses FROM users WHERE id = ?').get(uid); if (u) out.push({ ...u, status: inDuel(uid) ? 'dueling' : inQueue(uid) ? 'searching' : 'online' }); }
  return out.sort((a, b) => a.username.localeCompare(b.username));
}

// ---- invites ------------------------------------------------------------------------------------
const code = () => crypto.randomBytes(6).toString('base64url');
const row = id => db.prepare('SELECT i.*, f.username AS from_name, f.avatar AS from_avatar, f.frame AS from_frame, t.username AS to_name FROM invites i JOIN users f ON f.id = i.from_id LEFT JOIN users t ON t.id = i.to_id WHERE i.id = ?').get(id);

export function createInvite(user, { to, mode, deckId, link }) {
  mode = mode === 'modern' ? 'modern' : 'classic';
  const v = validateFor(user.id, deckId, mode); if (v.error) return v;
  let toId = null;
  if (!link) { const t = db.prepare('SELECT id FROM users WHERE username = ? OR id = ?').get(String(to || ''), Number(to) || -1); if (!t) return { error: 'No such player.' }; if (t.id === user.id) return { error: "You can't invite yourself." }; toId = t.id; }
  db.prepare("UPDATE invites SET status = 'cancelled' WHERE from_id = ? AND status = 'pending' AND IFNULL(to_id,0) = IFNULL(?,0)").run(user.id, toId);
  const id = Number(db.prepare('INSERT INTO invites (code, from_id, to_id, deck_id, mode, created_at, expires_at) VALUES (?,?,?,?,?,?,?)').run(code(), user.id, toId, v.deck.id, mode, now(), now() + INVITE_MS).lastInsertRowid);
  return { invite: pub(row(id)) };
}
const pub = r => r && ({ id: r.id, code: r.code, from: { id: r.from_id, name: r.from_name, avatar: r.from_avatar, frame: r.from_frame }, to: r.to_id ? { id: r.to_id, name: r.to_name } : null, mode: r.mode, status: r.status, expiresAt: r.expires_at, fromOnline: isOnline(r.from_id) });

export const incoming = uid => db.prepare("SELECT id FROM invites WHERE to_id = ? AND status = 'pending' AND expires_at > ? ORDER BY id DESC LIMIT 20").all(uid, now()).map(r => pub(row(r.id)));
export const outgoing = uid => db.prepare("SELECT id FROM invites WHERE from_id = ? AND status = 'pending' AND expires_at > ? ORDER BY id DESC LIMIT 20").all(uid, now()).map(r => pub(row(r.id)));
export const inviteByCode = c => { const r = db.prepare('SELECT id FROM invites WHERE code = ?').get(String(c)); return r ? pub(row(r.id)) : null; };

export function acceptInvite(user, inviteId, deckId) {
  const r = row(inviteId); if (!r || r.status !== 'pending' || r.expires_at < now()) return { error: 'That invitation is no longer available.' };
  if (r.to_id && r.to_id !== user.id) return { error: 'That invitation is for someone else.' };
  if (r.from_id === user.id) return { error: "You can't accept your own invitation." };
  if (busy(user.id)) return { error: busy(user.id) };
  const mine = validateFor(user.id, deckId, r.mode); if (mine.error) return mine;
  if (!isOnline(r.from_id)) return { error: `${r.from_name} is offline right now. Try again when they are online — the invitation stays open for 24 hours.` };
  if (inDuel(r.from_id)) return { error: `${r.from_name} is in another duel.` };
  const theirs = validateFor(r.from_id, r.deck_id, r.mode); if (theirs.error) return { error: `${r.from_name}'s deck is no longer available.` };
  const sender = db.prepare('SELECT id, username, avatar, frame FROM users WHERE id = ?').get(r.from_id);
  db.prepare("UPDATE invites SET status = 'accepted' WHERE id = ?").run(r.id);
  leaveQueue(user.id); leaveQueue(r.from_id);
  launch([player(sender, theirs.deck), player(user, mine.deck)], r.mode);
  return { status: 'started' };
}
export function closeInvite(user, inviteId, status) {   // 'declined' (by recipient) | 'cancelled' (by sender)
  const r = row(inviteId); if (!r || r.status !== 'pending') return { error: 'Not found.' };
  if (!((status === 'declined' && r.to_id === user.id) || (status === 'cancelled' && r.from_id === user.id))) return { error: 'Not allowed.' };
  db.prepare('UPDATE invites SET status = ? WHERE id = ?').run(status, r.id); return { ok: true };
}

// ---- housekeeping: record results, forfeit AFK humans, free engine memory ----------------------------
function record(rec) {
  rec.recorded = true; const m = rec.match, [a, b] = rec.users, win = m.winner == null ? null : rec.users[m.winner] ?? null;
  db.prepare('INSERT INTO matches (p1, p2, bot, mode, winner, turns, started_at, ended_at) VALUES (?,?,?,?,?,?,?,?)').run(a, b, rec.bot ? rec.bot.name : null, rec.mode, win, m.turn, rec.started, now());
  const col = (uid, won) => db.prepare(`UPDATE users SET ${rec.bot ? 'bot' : 'pvp'}_${won ? 'wins' : 'losses'} = ${rec.bot ? 'bot' : 'pvp'}_${won ? 'wins' : 'losses'} + 1 WHERE id = ?`).run(uid);
  for (const [seat, uid] of rec.users.entries()) if (uid != null && m.winner != null) col(uid, m.winner === seat);
}
setInterval(() => {
  const seenRec = new Set();
  for (const [uid, d] of duels) { const rec = d.rec; if (seenRec.has(rec)) continue; seenRec.add(rec);
    const m = rec.match;
    if (m.over && !rec.recorded) { try { record(rec); } catch (e) { console.error('[record]', e.message); } rec.endedAt = now(); rec.botCtl?.stop(); }
    else if (!m.over) {
      rec.users.forEach((u, seat) => { if (u != null && now() - rec.last[seat] > AFK_FORFEIT_MS && !isOnline(u)) { try { m.act(seat, 'surrender'); } catch { /* match already gone */ } } });
      if (rec.bot && rec.users.every(u => u == null || !isOnline(u)) && now() - Math.max(...rec.last) > 600_000) { m.destroy(); rec.botCtl?.stop(); }
    }
    if (m.over && rec.endedAt && now() - rec.endedAt > 600_000) { m.destroy(); for (const [k, v] of duels) if (v.rec === rec) duels.delete(k); }
  }
  for (const k of Object.keys(queue)) if (queue[k] && (!isOnline(queue[k].uid) || inDuel(queue[k].uid))) queue[k] = null;
  db.prepare("UPDATE invites SET status = 'cancelled' WHERE status = 'pending' AND expires_at < ?").run(now());
}, 5000).unref();
