// decks.js — .ydk import/export, validation per mode (classic / modern) and per-user deck storage in SQLite.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { db, now, tx } from './db.js';
import { info } from './engine.js';
import { allowed, known, isExtra, canon, nameOf, briefById, hasScript, idByName } from './cards.js';

const require = createRequire(import.meta.url);
const Inv = require('./DeckInventory.cjs');          // avatars / frames / duelist portraits (kept from the old repos)
export { Inv };

export const LIMITS = { mainMin: 40, mainMax: 60, extraMax: 15, sideMax: 15, copies: 3 };
const ids = a => (Array.isArray(a) ? a : []).map(Number).filter(n => Number.isInteger(n) && n > 0 && n < 4294967296);

/** .ydk text -> { main, extra, side } passcode arrays (what ygoprodeck.com exports). */
export function parseYdk(text) {
  const out = { main: [], extra: [], side: [] }; let sec = 'main';
  for (const raw of String(text || '').slice(0, 200_000).split(/\r?\n/)) {
    const l = raw.trim(); if (!l) continue;
    if (/^#main/i.test(l)) sec = 'main'; else if (/^#extra/i.test(l)) sec = 'extra'; else if (/^!side/i.test(l)) sec = 'side';
    else if (/^\d{1,10}$/.test(l)) out[sec].push(Number(l));
  }
  return out;
}
export const toYdk = d => `#created by YGO 2.0\n#main\n${d.main.join('\n')}\n#extra\n${d.extra.join('\n')}\n!side\n${d.side.join('\n')}\n`;

/** Check a deck against a mode. Returns { errors:[], warnings:[], valid }. */
export function check(d, mode) {
  const errors = [], warnings = [];
  const all = [...d.main, ...d.extra, ...d.side];
  const unknown = all.filter(i => !known(i)); if (unknown.length) errors.push(`${unknown.length} card(s) the engine doesn't know (${[...new Set(unknown)].slice(0, 5).join(', ')}).`);
  if (mode === 'classic') {
    const bad = [...new Set(all.filter(i => known(i) && !allowed(i, 'classic')))];
    if (bad.length) errors.push(`Not allowed in Classic: ${bad.slice(0, 5).map(nameOf).join(', ')}${bad.length > 5 ? ` and ${bad.length - 5} more` : ''}.`);
  }
  if (d.main.length < LIMITS.mainMin) errors.push(`Main Deck needs at least ${LIMITS.mainMin} cards (has ${d.main.length}).`);
  if (d.main.length > LIMITS.mainMax) errors.push(`Main Deck can have at most ${LIMITS.mainMax} cards (has ${d.main.length}).`);
  if (d.extra.length > LIMITS.extraMax) errors.push(`Extra Deck can have at most ${LIMITS.extraMax} cards (has ${d.extra.length}).`);
  if (d.side.length > LIMITS.sideMax) errors.push(`Side Deck can have at most ${LIMITS.sideMax} cards (has ${d.side.length}).`);
  if (d.main.some(i => known(i) && isExtra(i)) || d.extra.some(i => known(i) && !isExtra(i))) errors.push('Some cards are in the wrong deck (Extra Deck monsters belong in the Extra Deck).');
  const n = new Map(); for (const i of all) n.set(canon(i), (n.get(canon(i)) || 0) + 1);
  const over = [...n].filter(([, c]) => c > LIMITS.copies).map(([i]) => nameOf(i)); if (over.length) errors.push(`More than ${LIMITS.copies} copies of: ${over.slice(0, 5).join(', ')}.`);
  const stubs = new Set([...d.main, ...d.extra].filter(i => known(i) && !hasScript(i) && !((info(i).type & 0x11) === 0x11)).map(nameOf));
  if (stubs.size) warnings.push(`${stubs.size} card(s) have no script in the engine and will play as plain cards.`);
  return { errors, warnings, valid: errors.length === 0 };
}

/** Put every card in the right zone and drop what the engine doesn't know (used on import). */
export function normalize(raw) {
  const skipped = [], main = [], extra = [], side = [];
  for (const i of ids([...(raw.main || []), ...(raw.extra || [])])) { if (!known(i)) { skipped.push(i); continue; } (isExtra(i) ? extra : main).push(i); }
  for (const i of ids(raw.side)) { if (!known(i)) skipped.push(i); else side.push(i); }
  return { deck: { main, extra, side }, skipped };
}

/** 'auto' picks Classic when every card is in the classic pool, otherwise Modern. */
export function pickMode(deck, wanted) {
  if (wanted === 'classic' || wanted === 'modern') return wanted;
  return [...deck.main, ...deck.extra, ...deck.side].every(i => allowed(i, 'classic')) ? 'classic' : 'modern';
}

// ---- storage ------------------------------------------------------------------------------------
const cleanName = s => String(s || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 60);
const parse = r => ({ ...r, main: JSON.parse(r.main), extra: JSON.parse(r.extra), side: JSON.parse(r.side) });

export function summary(r) {
  const d = parse(r), brief = [...new Set(d.main)].map(briefById).filter(Boolean);
  const cov = (() => { const u = [...new Set([...d.main, ...d.extra])]; return u.length ? Math.round(100 * u.filter(i => known(i) && (hasScript(i) || (info(i).type & 0x11) === 0x11)).length / u.length) : 0; })();
  const cover = brief.filter(b => b.kind === 'monster').sort((a, b) => (b.atk || 0) - (a.atk || 0))[0] || brief[0];
  const mon = d.main.filter(i => info(i)?.type & 1).length, sp = d.main.filter(i => info(i)?.type & 2).length;
  const c = check(d, r.mode);
  return { id: r.id, name: r.name, mode: r.mode, valid: c.valid, errors: c.errors, warnings: c.warnings, broken: !c.valid,
    counts: { main: d.main.length, extra: d.extra.length, side: d.side.length, monsters: mon, spells: sp, traps: d.main.length - mon - sp },
    cover: cover ? { image: '/pics/c/' + cover.id + '.jpg' } : { image: '' }, script: { pct: cov },
    portrait: r.avatar || (r.owner && Inv.OWNERS[r.owner]?.portrait) || null, frame: r.frame || (r.owner && Inv.OWNER_FRAMES[r.owner]) || null,
    ownerName: r.owner && Inv.OWNERS[r.owner] ? Inv.OWNERS[r.owner].name : null, owner: r.owner || null, avatar: r.avatar || null, builtin: false };
}

const q = {
  list: db.prepare('SELECT * FROM decks WHERE user_id = ? ORDER BY updated_at DESC, id DESC'),
  get: db.prepare('SELECT * FROM decks WHERE id = ? AND user_id = ?'),
  ins: db.prepare('INSERT INTO decks (user_id,name,mode,main,extra,side,owner,avatar,frame,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)'),
  upd: db.prepare('UPDATE decks SET name=?, mode=?, main=?, extra=?, side=?, owner=?, avatar=?, frame=?, updated_at=? WHERE id=? AND user_id=?'),
  del: db.prepare('DELETE FROM decks WHERE id = ? AND user_id = ?'),
  count: db.prepare('SELECT COUNT(*) n FROM decks WHERE user_id = ?')
};
export const MAX_DECKS = 60;

export const listDecks = uid => q.list.all(uid).map(summary);
export const getDeck = (uid, id) => { const r = q.get.get(Number(id), uid); return r ? parse(r) : null; };

export function saveDeck(uid, id, b) {
  const { deck } = normalize(b), mode = b.mode === 'modern' ? 'modern' : 'classic';
  const owner = Inv.OWNERS[b.owner] ? b.owner : null, avatar = Inv.cleanAvatar(b.avatar), frame = Inv.cleanFrame(b.frame), name = cleanName(b.name) || 'New Deck';
  const t = now();
  if (id) {
    const r = q.upd.run(name, mode, JSON.stringify(deck.main), JSON.stringify(deck.extra), JSON.stringify(deck.side), owner, avatar, frame, t, Number(id), uid);
    if (!r.changes) return null; return Number(id);
  }
  if (q.count.get(uid).n >= MAX_DECKS) throw Object.assign(new Error(`You can keep at most ${MAX_DECKS} decks.`), { status: 400 });
  return Number(q.ins.run(uid, name, mode, JSON.stringify(deck.main), JSON.stringify(deck.extra), JSON.stringify(deck.side), owner, avatar, frame, t, t).lastInsertRowid);
}
export const renameDeck = (uid, id, name) => q.get.get(Number(id), uid) && !!db.prepare('UPDATE decks SET name=?, updated_at=? WHERE id=? AND user_id=?').run(cleanName(name) || 'Deck', now(), Number(id), uid).changes;
export const deleteDeck = (uid, id) => !!q.del.run(Number(id), uid).changes;

/** Import a .ydk. Never throws on odd cards: reports what was skipped and what the deck still needs. */
export function importYdk(uid, text, { name, mode } = {}) {
  const parsed = parseYdk(text), { deck, skipped } = normalize(parsed);
  if (!deck.main.length && !deck.extra.length) throw Object.assign(new Error('That .ydk has no cards the engine knows.'), { status: 400, skipped });
  const m = pickMode(deck, mode);
  let dropped = [];
  if (m === 'classic' && mode === 'classic') {       // an explicit Classic import keeps only what Classic allows
    const keep = i => allowed(i, 'classic'); dropped = [...deck.main, ...deck.extra, ...deck.side].filter(i => !keep(i));
    deck.main = deck.main.filter(keep); deck.extra = deck.extra.filter(keep); deck.side = deck.side.filter(keep);
  }
  const id = saveDeck(uid, null, { ...deck, name: name || 'Imported deck', mode: m });
  const sum = summary(q.get.get(id, uid));
  return { id, mode: m, deck: sum, skipped: [...new Set(skipped)], dropped: [...new Set(dropped)].map(i => ({ id: i, name: nameOf(i) })) };
}

export function exportYdk(uid, id) { const d = getDeck(uid, id); return d ? { name: d.name, text: toYdk(d) } : null; }

// ---- the six duelist decks of the original repos: starter decks for new accounts + bot opponents -----------------
const DIR = path.join(path.dirname(new URL(import.meta.url).pathname), 'deck_inventory');
// Jaden has no deck file in the old repos, so his Elemental HERO deck is assembled here from card names (all in the classic pool).
const HERO_DECK = { main: { 'Elemental HERO Avian': 3, 'Elemental HERO Burstinatrix': 3, 'Elemental HERO Clayman': 3, 'Elemental HERO Sparkman': 2, 'Elemental HERO Bubbleman': 3, 'Elemental HERO Wildheart': 1, 'Elemental HERO Stratos': 1, 'Elemental HERO Neos': 1, 'Winged Kuriboh': 2, 'Hero Kid': 1,
    'Polymerization': 3, 'Miracle Fusion': 1, 'Fusion Gate': 1, 'Hero Signal': 1, 'Pot of Greed': 1, 'Reinforcement of the Army': 1, 'Mystical Space Typhoon': 2, 'Heavy Storm': 1, 'Monster Reborn': 1, 'Mirror Force': 1, 'Bottomless Trap Hole': 1, 'Torrential Tribute': 1, 'Scapegoat': 1, 'Call of the Haunted': 1, 'Dust Tornado': 1, 'Foolish Burial': 1, 'Graceful Charity': 1 },
  extra: ['Elemental HERO Flame Wingman', 'Elemental HERO Thunder Giant', 'Elemental HERO Wildedge', 'Elemental HERO Mudballman', 'Elemental HERO Wild Wingman', 'Elemental HERO Necroid Shaman', 'Elemental HERO Mariner', 'Elemental HERO Tempest', 'Elemental HERO Shining Flare Wingman', 'Elemental HERO Rampart Blaster'] };
function heroDeck() {
  const main = []; for (const [n, k] of Object.entries(HERO_DECK.main)) { const id = idByName(n); if (id) for (let i = 0; i < k; i++) main.push(id); }
  return { main, extra: HERO_DECK.extra.map(n => idByName(n)).filter(Boolean), side: [] };
}
export const BOTS = ['yugi', 'kaiba', 'joey', 'mai', 'jesse', 'jaden'].map(key => {
  try {
    let deck;
    if (key === 'jaden') deck = heroDeck();
    else { const j = JSON.parse(fs.readFileSync(path.join(DIR, key + '.json'), 'utf8')); deck = normalize({ main: (j.mainDeck || []).map(c => c.id), extra: (j.extraDeck || []).map(c => c.id), side: (j.sideDeck || []).map(c => c.id) }).deck; }
    return { key, name: Inv.OWNERS[key].name, deckName: Inv.OWNERS[key].name + "'s Deck", portrait: Inv.OWNERS[key].portrait, frame: Inv.OWNER_FRAMES[key], deck, mode: pickMode(deck, 'auto') };
  } catch { return null; }
}).filter(Boolean);

export function seedStarterDecks(uid) {
  tx(() => { for (const b of BOTS) saveDeck(uid, null, { ...b.deck, name: b.deckName, mode: b.mode, owner: b.key }); });
}

/** What the engine needs for a match: arrays of passcodes. */
export const forMatch = d => ({ main: d.main.filter(known).slice(0, 60), extra: d.extra.filter(known).slice(0, 15) });
