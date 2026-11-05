// match.js — one two-player duel on the WASM rules engine, exposed in the shape the duel client expects:
// a JSON "view" per player, an ordered list of animation "events", and prompts. Rules live ONLY in ocgcore + CardScripts.
import fs from 'node:fs'; import path from 'node:path';
import { SCRIPTS, info, cname, descText, E, lenp, rd, getLen, put, loadScript, queryLoc, lps, PHASES, searchCards } from './engine.js';
import { parsePrompt, encode, i32 } from './prompts.js';

const LOC = { DECK: 1, HAND: 2, MZ: 4, SZ: 8, GRAVE: 16, BANISH: 32, EXTRA: 64 };
const LN = { 1: 'deck', 2: 'hand', 4: 'monster', 8: 'spellTrap', 16: 'graveyard', 32: 'banished', 64: 'extraDeck' };
const QLOCS = [LOC.HAND, LOC.MZ, LOC.SZ, LOC.GRAVE, LOC.BANISH, LOC.EXTRA];
const PHASE_KEY = { Draw: 'draw', Standby: 'standby', 'Main 1': 'm1', Battle: 'battle', 'Main 2': 'm2', End: 'end' };
const RACE = { 1: 'Warrior', 2: 'Spellcaster', 4: 'Fairy', 8: 'Fiend', 16: 'Zombie', 32: 'Machine', 64: 'Aqua', 128: 'Pyro', 256: 'Rock', 512: 'Winged Beast', 1024: 'Plant', 2048: 'Insect', 4096: 'Thunder', 8192: 'Dragon', 16384: 'Beast', 32768: 'Beast-Warrior', 65536: 'Dinosaur', 131072: 'Fish', 262144: 'Sea Serpent', 524288: 'Reptile', 1048576: 'Psychic', 2097152: 'Divine-Beast', 4194304: 'Creator God', 8388608: 'Wyrm', 16777216: 'Cyberse', 33554432: 'Illusion' };
const ATTR = { 1: 'EARTH', 2: 'WATER', 4: 'FIRE', 8: 'WIND', 16: 'LIGHT', 32: 'DARK', 64: 'DIVINE' };
const sleep = ms => new Promise(r => setTimeout(r, ms));

function typeStr(t) { if (t & 2) return 'Spell Card'; if (t & 4) return 'Trap Card'; const p = [];
  if (t & 0x4000000) p.push('Link'); else if (t & 0x800000) p.push('XYZ'); else if (t & 0x2000) p.push('Synchro'); else if (t & 0x40) p.push('Fusion'); else if (t & 0x80) p.push('Ritual');
  if (t & 0x1000000) p.push('Pendulum'); if (t & 0x1000) p.push('Tuner'); p.push(t & 0x20 ? 'Effect' : 'Normal'); p.push('Monster'); return p.join(' '); }
const frameOf = t => t & 2 ? 'spell' : t & 4 ? 'trap' : t & 0x4000000 ? 'link' : t & 0x800000 ? 'xyz' : t & 0x2000 ? 'synchro' : t & 0x40 ? 'fusion' : t & 0x80 ? 'ritual' : t & 0x20 ? 'effect' : 'normal';
const raceName = r => { r = Number(r); for (const k of Object.keys(RACE)) if (r & Number(k)) return RACE[k]; return null; };
const posName = p => (p & 0xc) ? 'defense' : 'attack';
const keyOf = (con, loc, seq) => con + ':' + loc + ':' + seq;
const shuffled = process.env.NOSHUFFLE ? (a => a) : (a => { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; });
const U = (b, o) => b.readUInt32LE(o);
const locInfo = (b, o) => ({ con: b[o], loc: b[o + 1], seq: U(b, o + 2), pos: U(b, o + 6) });

export class Match {
  constructor(players, opts = {}) { // players[seat] = { name, deckName, avatar, frame, main:[codes], extra:[codes] }
    this.summoning = null; this.undoOK = false; this.rules = opts.rules === 'modern' ? 'modern' : 'classic'; this.pl = players; this.turn = 0; this.tp = 0; this.phase = ''; this.over = false; this.winner = null; this.pending = null; this.logs = [];
    this.lp = [8000, 8000]; this.chain = []; this.atk = null; this.auto = null; this.stuck = 0; this.lastSummon = null; this.firstSeat = 0;
    this.seat = [0, 1].map(() => ({ ent: [], nextUid: 1, outbox: [], wake: null, dest: new Map() }));
    this.duel = E.ygo_create((Math.random() * 2 ** 32) >>> 0, (Math.random() * 2 ** 32) >>> 0, 8000, 5, 1, this.rules === 'modern' ? 0x2E800 : 0x28800, 0); // modern: full Master Rule 5 with the two Extra Monster Zones; classic: the traditional board without them
    if (!this.duel) throw new Error('Duel creation failed');
    for (const s of ['constant.lua', 'utility.lua']) loadScript(this.duel, fs.readFileSync(path.join(SCRIPTS, s)), s);
    for (let t = 0; t < 2; t++) { shuffled(players[t].main).forEach((c, i) => E.ygo_new_card(this.duel, c, t, 0, t, 0x01, i, 0x8)); players[t].extra.forEach((c, i) => E.ygo_new_card(this.duel, c, t, 0, t, 0x40, i, 0x8)); }
    for (const c of opts.setup || (process.env.YGO_TEST_SETUP ? JSON.parse(process.env.YGO_TEST_SETUP) : [])) E.ygo_new_card(this.duel, c.code, c.p, 0, c.p, c.loc, c.seq, c.pos); // test hook: start with cards already on the field
    E.ygo_start(this.duel);
    this.pre = [{ type: 'duelStart' }]; this._log('=== DUEL START ==='); this._run(null);
  }
  destroy() { try { E.ygo_destroy(this.duel); } catch (e) { /* already gone */ } this.over = true; }
  side(p, v) { return p === v ? 'you' : 'opp'; }
  _log(t) { this.logs.push(t); if (this.logs.length > 80) this.logs.shift(); }

  // ---------------------------------------------------------------- engine pump
  _setResp(buf) { const p = put(buf); E.ygo_set_response(this.duel, p, buf.length); E.ygo_free(p); }
  _pump(raw) { let prompt = null, retry = false;
    for (let guard = 0; guard < 4000 && !this.over; guard++) {
      const st = E.ygo_process(this.duel); const mp = E.ygo_get_message(this.duel, lenp); const len = getLen(); const buf = len ? rd(mp, len) : Buffer.alloc(0);
      for (let o = 0; o < buf.length;) { const plen = buf.readUInt32LE(o), id = buf[o + 4], body = buf.subarray(o + 5, o + 4 + plen); o += 4 + plen;
        const rec = { id, body }; raw.push(rec);
        if (id === 40) { this.lastSummon = null; this.turn++; this.tp = body[0]; rec.turn = this.turn; rec.tp = this.tp; }
        else if (id === 41) { this.lastSummon = null; this.phase = PHASE_KEY[PHASES[body.readUInt16LE(0)]] || this.phase; rec.phase = this.phase; rec.tp = this.tp; }
        else if (id === 5) { this.over = true; this.winner = body[0]; }
        else if (id === 91) { rec.from = this.lp[body[0]]; this.lp[body[0]] = Math.max(0, rec.from - U(body, 1)); rec.to = this.lp[body[0]]; }
        else if (id === 92) { rec.from = this.lp[body[0]]; this.lp[body[0]] = rec.from + U(body, 1); rec.to = this.lp[body[0]]; }
        else if (id === 100) { rec.from = this.lp[body[0]]; this.lp[body[0]] = Math.max(0, rec.from - U(body, 1)); rec.to = this.lp[body[0]]; }
        else if (id === 94) { rec.from = this.lp[body[0]]; this.lp[body[0]] = U(body, 1); rec.to = this.lp[body[0]]; }
        else if (id === 110) { this.atk = rec; } else if (id === 111) { this.atk = null; }
        else if (id === 60 || id === 62 || id === 64) { this.lastSummon = rec; }
        else if (id === 70) { this.chain.push(rec); rec.index = this.chain.length; } else if (id === 73) { rec.index = this.chain.length; this.chain.pop(); } else if (id === 74) { this.chain = []; }
        else if (id === 21 || id === 25) { this._setResp(Buffer.from([0xff])); }
        else if (id === 1) retry = true;
        else if ((id >= 10 && id <= 26) || (id >= 140 && id <= 143)) { const P = parsePrompt(id, body); prompt = P || { kind: 'UNSUPPORTED', id, name: String(id), player: body[0] }; if (prompt.kind === 'IDLECMD' || prompt.kind === 'BATTLECMD') this.lastSummon = null; if (prompt.kind === 'UNSELECT') { if (!prompt.picked.length) this.undoOK = !!prompt.cancel; } else this.undoOK = false; }
      }
      if (st === 0) { this.over = true; break; }
      if (st === 1) break; }
    if (!prompt && retry && this.pending) { prompt = this.pending; prompt.retry = true; }
    return prompt; }

  _run(resp) { const raw = []; if (resp) this._setResp(resp); let prompt = null;
    for (let i = 0; i < 80; i++) { prompt = this._pump(raw); this.pending = prompt; if (this.over || !prompt) break; const a = this._auto(prompt); if (!a) break; this._setResp(a); }
    this.auto = null; if (!this.pending || !['UNSELECT', 'CARD', 'TRIBUTE'].includes(this.pending.kind)) this.summoning = null; this._finalize(raw); }

  // choose answers for engine prompts that the client's flow already answered (tributes, attack target, picked cards) or that need no human input
  _auto(P) { const a = this.auto;
    if (P.kind === 'CHAIN' && !P.chains.length && !P.forced) return i32(-1); // nothing to chain: the engine asks anyway, a player should never see it
    if (P.kind === 'PLACE' || P.kind === 'DISFIELD') {
      const free = []; const own = P.player;
      for (let pl = 0; pl < 2; pl++) for (const [loc, base] of [[4, 0], [8, 8]]) for (let q = 0; q < 7; q++) if (!(P.flag & (1 << (16 * pl + base + q)))) free.push([pl, loc, q]);
      if (free.length !== 1) return null; // more than one legal zone: the player picks the zone (Master Rule 5: Extra Monster Zone usable for synchro/fusion/xyz/link)
      return Buffer.from([free[0][0] === 0 ? own : 1 - own, free[0][1], free[0][2]]); }
    if (!a || a.seat !== P.player) return null;
    const idxOfUid = u => { const e = this._entByUid(P.player, u); if (!e) return -1; return (P.cards || []).findIndex(c => c.con === e.con && c.loc === e.loc && c.seq === e.seq); };
    if (P.kind === 'UNSELECT' && a.undo) { if (P.picked.length) return encode(P, { idx: P.cards.length }); a.undo = false; if (P.cancel) return encode(P, { finish: true }); return null; }
    if (P.kind === 'TRIBUTE' && a.tributes) { const sel = []; for (const z of a.tributes) { const i = P.cards.findIndex(c => c.con === P.player && c.loc === LOC.MZ && c.seq === z); if (i >= 0 && !sel.includes(i)) sel.push(i); }
      for (let i = 0; sel.length < P.min && i < P.cards.length; i++) if (!sel.includes(i)) sel.push(i); a.tributes = null;
      return encode(P, { sel: sel.slice(0, P.max) }); }
    if (P.kind === 'CARD' && a.target) { const i = idxOfUid(a.target); a.target = null; if (i >= 0) return encode(P, { sel: [i] }); }
    if ((P.kind === 'CARD') && a.picks) { const sel = a.picks.map(idxOfUid).filter(i => i >= 0); a.picks = null; return encode(P, { sel }); }
    if (P.kind === 'UNSELECT' && a.picks) { while (a.picks.length) { const u = a.picks.shift(); const i = P.cards.findIndex(c => { const e = this._entByUid(P.player, u); return e && c.con === e.con && c.loc === e.loc && c.seq === e.seq; }); if (i >= 0) return encode(P, { idx: i }); }
      a.picks = null; if (P.finish) return encode(P, { finish: true }); }    return null; }

  // ---------------------------------------------------------------- snapshots and card identity
  _snap() { const out = [];
    for (const con of [0, 1]) for (const loc of QLOCS) { const cs = queryLoc(this.duel, con, loc);
      cs.forEach((c, seq) => { if (c) out.push({ con, loc, seq, code: c.code || 0, pos: c.pos || 0, type: c.type || 0, level: c.level, rank: c.rank, atk: c.atk, def: c.def, link: c.link, marker: c.marker, xyz: c.xyz, lscale: c.lscale, rscale: c.rscale }); }); }
    for (const con of [0, 1]) this.deckCount = (this.deckCount || [0, 0]), this.deckCount[con] = E.ygo_query_count(this.duel, con, LOC.DECK);
    return out; }
  _vcode(v, e) { if (e.loc === LOC.HAND || e.loc === LOC.EXTRA) return e.con === v ? e.code : 0; if ((e.loc === LOC.MZ || e.loc === LOC.SZ || e.loc === LOC.BANISH) && (e.pos & 0xa)) return e.con === v ? e.code : 0; return e.code; }
  _reconcile(v, snap) { const S = this.seat[v], old = S.ent.slice(), used = new Set(), out = snap.map(e => ({ ...e, vcode: this._vcode(v, e), uid: null }));
    const take = (n, pred, prefer) => { let best = -1, bs = 1e9; old.forEach((o, i) => { if (used.has(i) || !pred(o)) return; const s = prefer(o); if (s < bs) { bs = s; best = i; } }); if (best >= 0) { used.add(best); n.uid = old[best].uid; } };
    for (const n of out) take(n, o => o.con === n.con && o.loc === n.loc && o.seq === n.seq && (o.vcode === n.vcode || !o.vcode || !n.vcode), () => 0);
    for (const n of out) if (!n.uid) take(n, o => o.vcode === n.vcode && n.vcode, o => (o.con === n.con ? 0 : 100) + (o.loc === n.loc ? 0 : 10) + Math.abs(o.seq - n.seq) / 100);
    for (const n of out) if (!n.uid && !n.vcode) take(n, o => !o.vcode, o => (o.con === n.con ? 0 : 100) + (o.loc === n.loc ? 0 : 10));
    for (const n of out) if (!n.uid && n.vcode) take(n, o => !o.vcode && o.con === n.con, o => (o.loc === n.loc ? 0 : 10));
    for (const n of out) if (!n.uid) n.uid = 'c' + (S.nextUid++);
    S.prev = old; S.ent = out; return out; }
  _entByUid(v, uid) { return this.seat[v].ent.find(e => e.uid === uid) || null; }
  _entAt(v, con, loc, seq, list) { return (list || this.seat[v].ent).find(e => e.con === con && e.loc === loc && e.seq === seq) || null; }

  // ---------------------------------------------------------------- events + log for one viewer
  _events(v, raw) { const ev = [...(this.pre || [])].map(e => e.type === 'duelStart' ? { type: 'duelStart', first: this.firstSeat === v ? 'you' : 'opp' } : e); const S = this.seat[v], pv = S.prev || [], now = S.ent;
    const nm = p => this.pl[p].name, sd = p => this.side(p, v), L = t => { if (v === 0) this._log(t); };
    const byPrev = (con, loc, seq, code) => pv.find(e => e.con === con && e.loc === loc && e.seq === seq) || pv.find(e => e.con === con && e.loc === loc && (e.vcode === code || !e.vcode)) || null;
    const uidNow = (con, loc, seq, code) => (this._entAt(v, con, loc, seq, now) || this._entAt(v, con, loc, seq, pv) || {}).uid || null;
    for (const r of raw) { const b = r.body;
      switch (r.id) {
        case 40: ev.push({ type: 'turn', side: sd(r.tp), turn: r.turn }); L('=== TURN ' + r.turn + ' (' + nm(r.tp) + ') ==='); break;
        case 41: ev.push({ type: 'phase', phase: r.phase, side: sd(r.tp) }); L(({ draw: 'DRAW PHASE', standby: 'STANDBY PHASE', m1: 'MAIN 1', battle: 'BATTLE PHASE', m2: 'MAIN 2', end: 'END PHASE' }[r.phase] || r.phase) + ' (' + nm(r.tp) + ')'); break;
        case 90: { const n = U(b, 1); for (let i = 0; i < n; i++) ev.push({ type: 'move', id: null, from: 'deck', to: 'hand', toSide: sd(b[0]) }); L(nm(b[0]) + ' draws ' + n + (n > 1 ? ' cards' : ' card')); break; }
        case 50: { const code = U(b, 0), p = locInfo(b, 4), c = locInfo(b, 14), reason = U(b, 24); const pe = byPrev(p.con, p.loc, p.seq, code);
          ev.push({ type: 'move', id: pe ? pe.uid : null, from: p.loc === LOC.SZ && p.seq === 5 ? 'field' : LN[p.loc], to: LN[c.loc], destroyed: !!(reason & 1) && (c.loc === LOC.GRAVE || c.loc === LOC.BANISH), toSide: sd(c.con), fromSide: sd(p.con) });
          if ((reason & 1) && c.loc === LOC.GRAVE && code) L(cname(code) + ' is destroyed'); break; }
        case 60: case 62: { const code = U(b, 0), l = locInfo(b, 4); ev.push({ type: 'field', kind: 'summon', id: uidNow(l.con, l.loc, l.seq, code), ownerSide: sd(l.con), name: cname(code), image: '/pics/' + code + '.jpg' }); L(nm(l.con) + (r.id === 60 ? ' summons ' : ' Special Summons ') + cname(code)); break; }
        case 64: { const code = U(b, 0), l = locInfo(b, 4); ev.push({ type: 'field', kind: 'flip', id: uidNow(l.con, l.loc, l.seq, code), ownerSide: sd(l.con), name: cname(code) }); L(nm(l.con) + ' flip summons ' + cname(code)); break; }
        case 54: { const code = U(b, 0), l = locInfo(b, 4); ev.push({ type: 'field', kind: l.loc === LOC.MZ ? 'set-monster' : 'set-spelltrap', id: uidNow(l.con, l.loc, l.seq, code), ownerSide: sd(l.con) }); L(nm(l.con) + ' sets a card'); break; }
        case 70: { const code = U(b, 0), l = locInfo(b, 4), tp = b[14]; const t = (info(code) || {}).type || 0; const idx = r.index || 1;
          if (t & 6) ev.push({ type: 'field', kind: t & 2 ? 'spell-activate' : 'trap-activate', id: uidNow(l.con, l.loc, l.seq, code), ownerSide: sd(tp), name: cname(code), image: '/pics/' + code + '.jpg' });
          ev.push({ type: 'chain', action: 'add', index: idx, name: cname(code), ownerSide: sd(tp) }); L(nm(tp) + ' activates ' + cname(code)); break; }
        case 73: ev.push({ type: 'chain', action: 'resolve', index: r.index || 1 }); break;
        case 110: { const a = locInfo(b, 0), t = locInfo(b, 10), code = (this._entAt(v, a.con, a.loc, a.seq, now) || {}).vcode;
          ev.push({ type: 'attack', attacker: uidNow(a.con, a.loc, a.seq), target: t.loc ? uidNow(t.con, t.loc, t.seq) : null, attackerSide: sd(a.con) }); L(nm(a.con) + (t.loc ? ' attacks' : ' attacks directly')); break; }
        case 91: case 92: case 94: case 100: if (r.from !== r.to) { ev.push({ type: 'lp', side: sd(b[0]), from: r.from, to: r.to }); if (r.id === 91) L(nm(b[0]) + ' takes ' + (r.from - r.to) + ' damage'); if (r.id === 92) L(nm(b[0]) + ' recovers ' + (r.to - r.from) + ' LP'); } break;
        case 5: ev.push({ type: 'gameover', winner: sd(b[0]) }); L(nm(b[0]) + ' wins the duel'); break;
      } }
    return ev; }

  // ---------------------------------------------------------------- views
  _cardView(v, e, reveal) { const o = { uid: e.uid, faceUp: !(e.pos & 0xa) || e.loc === LOC.HAND || e.loc === LOC.GRAVE || e.loc === LOC.EXTRA, pos: e.loc === LOC.MZ ? posName(e.pos) : null };
    if (e.loc === LOC.HAND || e.loc === LOC.EXTRA || e.loc === LOC.GRAVE || e.loc === LOC.BANISH) o.faceUp = e.loc === LOC.BANISH ? !(e.pos & 0xa) : (e.loc === LOC.HAND || e.loc === LOC.EXTRA ? e.con === v : true);
    if (!reveal || !e.code) return o; const i = info(e.code) || {}, t = e.type || i.type || 0, mon = !!(t & 1);
    Object.assign(o, { id: e.code, name: i.name || ('#' + e.code), image: '/pics/' + e.code + '.jpg', art: '/pics/c/' + e.code + '.jpg', type: typeStr(t), frame: frameOf(t), race: mon ? raceName(i.race) : null, attr: mon ? ATTR[i.attribute] || null : null,
      level: mon ? (t & 0x800000 ? e.rank : t & 0x4000000 ? null : (e.level || (i.level & 0xff))) : null, desc: i.desc || '', fx: [], isMonster: mon });
    if (e.xyz) o.overlay = e.xyz; if (t & 0x4000000) { o.linkRating = e.link; o.marker = e.marker; } if (t & 0x1000000) { o.lscale = e.lscale; o.rscale = e.rscale; }
    if (mon) { const link = t & 0x4000000; o.baseAtk = i.atk; o.baseDef = link ? null : i.def; if (e.loc === LOC.MZ) { o.atk = e.atk; o.def = link ? null : e.def; } else { o.atk = o.baseAtk; o.def = o.baseDef; } }
    return o; }
  _acts(v) { const P = this.pending, map = new Map(); if (!P || P.player !== v || this.over) return map; const add = (e, k, val) => { const key = keyOf(e.con, e.loc, e.seq); if (!map.has(key)) map.set(key, {}); const m = map.get(key); if (k === 'eng') (m.eng = m.eng || []).push(val); else m[k] = val; };
    const mine = this.seat[v].ent.filter(e => e.con === v && e.loc === LOC.MZ).map(e => e.uid);
    if (P.kind === 'IDLECMD') {
      for (const [i, e] of P.summon.entries()) { const l = (info(e.code) || {}).level & 0xff; add(e, 'summon', { tributes: l >= 7 ? 2 : l >= 5 ? 1 : 0, candidates: mine, forced: null, alt: [], idx: i }); }
      for (const [i, e] of P.mset.entries()) { const l = (info(e.code) || {}).level & 0xff; add(e, 'set', { tributes: l >= 7 ? 2 : l >= 5 ? 1 : 0, candidates: mine, forced: null, idx: i }); }
      P.sset.forEach(e => add(e, 'setSpellTrap', true)); P.repos.forEach(e => add(e, 'position', true));
      P.spsummon.forEach((e, i) => add(e, 'eng', { cmd: 'spsummon', idx: i, label: 'Special Summon' }));
      P.activate.forEach((e, i) => add(e, 'eng', { cmd: 'activate', idx: i, label: 'Activate: ' + e.desc })); }
    if (P.kind === 'BATTLECMD') {
      const foes = this.seat[v].ent.filter(e => e.con !== v && e.loc === LOC.MZ).map(e => e.uid);
      P.attack.forEach((e, i) => add(e, 'attack', { targets: e.direct && !foes.length ? [] : foes, direct: !!e.direct || !foes.length, idx: i }));
      P.activate.forEach((e, i) => add(e, 'eng', { cmd: 'activate', idx: i, label: 'Activate: ' + e.desc })); }
    return map; }
  _playerView(v, con) { const isYou = con === v, ent = this.seat[v].ent, acts = this._acts(v), P = this.pl[con];
    const at = (loc, seq) => ent.find(e => e.con === con && e.loc === loc && e.seq === seq);
    const mk = e => { if (!e) return null; const reveal = isYou || !!e.vcode; const c = this._cardView(v, e, reveal); if (isYou) c.act = acts.get(keyOf(e.con, e.loc, e.seq)) || {}; return c; };
    const list = loc => ent.filter(e => e.con === con && e.loc === loc).sort((a, b) => a.seq - b.seq);
    const view = { name: P.name, lp: this.lp[con], avatar: P.avatar || null, frame: P.frame || null, deckName: P.deckName || '',
      counts: { deck: this.deckCount[con], extra: list(LOC.EXTRA).length, gy: list(LOC.GRAVE).length, banished: list(LOC.BANISH).length, hand: list(LOC.HAND).length },
      monsters: [0, 1, 2, 3, 4].map(i => mk(at(LOC.MZ, i))), spellTrap: [0, 1, 2, 3, 4].map(i => mk(at(LOC.SZ, i))), field: mk(at(LOC.SZ, 5)),
      graveyard: list(LOC.GRAVE).map(e => this._cardView(v, e, true)), banished: list(LOC.BANISH).map(e => this._cardView(v, e, !!e.vcode || isYou)), hand: list(LOC.HAND).map(mk) };
    if (isYou) { view.extra = list(LOC.EXTRA).map(e => { const c = this._cardView(v, e, true); c.act = acts.get(keyOf(e.con, e.loc, e.seq)) || {}; return c; }); view.normalSummoned = false; }
    return view; }
  _emz(v) { const ent = this.seat[v].ent, acts = this._acts(v), find = (con, seq) => ent.find(e => e.con === con && e.loc === LOC.MZ && e.seq === seq);
    const mk = e => { if (!e) return null; const c = this._cardView(v, e, e.con === v || !!e.vcode); c.side = e.con === v ? 'you' : 'opp'; if (e.con === v) c.act = acts.get(keyOf(e.con, e.loc, e.seq)) || {}; return c; };
    return [mk(find(v, 5) || find(1 - v, 6)), mk(find(v, 6) || find(1 - v, 5))]; } // left / right physical zone as this player sees the mat
  _chainView(v) { return this.chain.map((r, i) => { const code = U(r.body, 0), l = locInfo(r.body, 4), e = this._entAt(v, l.con, l.loc, l.seq); return { n: i + 1, uid: e ? e.uid : null, name: cname(code), side: this.side(r.body[14], v), negated: false }; }); }
  _promptView(v) { const P = this.pending; if (!P || this.over || P.player !== v || P.kind === 'IDLECMD' || P.kind === 'BATTLECMD') return null;
    const ent = this.seat[v].ent, uidOf = c => { const e = this._entAt(v, c.con, c.loc, c.seq); return e ? e.uid : null; };
    const cv = (c, i) => { const e = this._entAt(v, c.con, c.loc, c.seq); const base = e ? this._cardView(v, e, !!e.vcode || e.con === v) : { uid: 'p' + i, faceUp: true };
      if (!base.name && c.code && (c.con === v || !e)) Object.assign(base, { id: c.code, name: cname(c.code), image: '/pics/' + c.code + '.jpg', type: typeStr((info(c.code) || {}).type || 0), desc: (info(c.code) || {}).desc || '', frame: frameOf((info(c.code) || {}).type || 0) });
      base.uid = base.uid || 'p' + i; base.zone = LN[c.loc]; return base; };
    const opt = c => { const e = this._entAt(v, c.con, c.loc, c.seq); return { uid: e ? e.uid : null, name: cname(c.code) + (c.desc && !/^Activate /.test(c.desc) ? ' — ' + c.desc : ''), from: LN[c.loc] === 'hand' ? 'hand' : LN[c.loc] === 'monster' ? 'monster' : 'spellTrap', quick: false, target: null }; };
    P.map = P.map || {};
    switch (P.kind) {
      case 'CHAIN': { const options = P.chains.map(opt); const base = { options, forced: !!P.forced };
        if (this.atk) { const a = locInfo(this.atk.body, 0), t = locInfo(this.atk.body, 10); return { type: 'battleResponse', attacker: (this._entAt(v, a.con, a.loc, a.seq) || {}).uid || null, target: t.loc ? (this._entAt(v, t.con, t.loc, t.seq) || {}).uid || null : null, handOptions: [], ...base }; }
        if (this.lastSummon && this.chain.length === 0 && this.lastSummon.id !== 70) { const l = locInfo(this.lastSummon.body, 4); return { type: 'summonResponse', summoned: (this._entAt(v, l.con, l.loc, l.seq) || {}).uid || null, ...base }; }
        const top = this.chain[this.chain.length - 1]; return { type: 'chain', links: this._chainView(v), lastName: top ? cname(U(top.body, 0)) : '', ...base }; }
      case 'PLACE': case 'DISFIELD': { const zones = []; for (let pl = 0; pl < 2; pl++) for (const [base, kind, n] of [[0, 'monster', 7], [8, 'spellTrap', 6]]) for (let q = 0; q < n; q++) if (!(P.flag & (1 << (16 * pl + base + q)))) zones.push({ side: pl === 0 ? 'you' : 'opp', kind, seq: q });
        return { type: 'place', prompt: P.kind === 'PLACE' ? 'Choose a zone' : 'Choose a zone to disable', zones }; }
      case 'YESNO': return { type: 'option', prompt: P.desc, options: [{ id: '1', label: 'Yes' }, { id: '0', label: 'No' }], cards: [] };
      case 'EFFECTYN': return { type: 'option', prompt: P.card.name + ' — ' + P.desc, options: [{ id: '1', label: 'Yes' }, { id: '0', label: 'No' }], cards: [] };
      case 'OPTION': return { type: 'option', prompt: 'Choose an option', options: P.options.map((o, i) => ({ id: String(i), label: o })), cards: [] };
      case 'POSITION': return { type: 'option', prompt: 'Choose a position for ' + P.card.name, options: [[1, 'Face-up Attack'], [4, 'Face-up Defense'], [2, 'Face-down Attack'], [8, 'Face-down Defense']].filter(([m]) => P.positions & m).map(([m, l]) => ({ id: String(m), label: l })), cards: [] };
      case 'ANNOUNCE_NUMBER': return { type: 'option', prompt: 'Declare a number', options: P.values.map((n, i) => ({ id: String(i), label: String(n) })), cards: [] };
      case 'ANNOUNCE_RACE': return { type: 'option', prompt: 'Declare a Type', options: Object.keys(RACE).map(Number).filter(m => Math.floor(P.available / m) % 2 === 1).map(m => ({ id: String(m), label: RACE[m] })), cards: [] };
      case 'ANNOUNCE_ATTRIB': return { type: 'option', prompt: 'Declare an Attribute', options: Object.keys(ATTR).map(Number).filter(m => Math.floor(P.available / m) % 2 === 1).map(m => ({ id: String(m), label: ATTR[m] })), cards: [] };
      case 'ANNOUNCE_CARD': return { type: 'search', prompt: P.retry ? 'That card cannot be declared — try another' : 'Declare a card' };
      case 'CARD': case 'TRIBUTE': case 'UNSELECT': { const cards = P.cards; const onField = cards.length && cards.every(c => c.loc === LOC.MZ || c.loc === LOC.SZ);
        const min = P.kind === 'UNSELECT' ? Math.max(0, P.min - P.picked.length) : P.min, max = P.kind === 'UNSELECT' ? Math.max(1, P.max - P.picked.length) : P.max, optional = !!(P.cancel || P.finish || (P.kind === 'UNSELECT' && this.undoOK)), cancelLabel = this.summoning ? 'Cancel summon' : undefined;
        const sm = this.summoning, have = P.kind === 'UNSELECT' ? P.picked.length : 0, more = min === 0 && P.kind === 'UNSELECT' ? ' (or press Confirm)' : '';
        const what = !sm ? null : ({ synchro: have === 0 ? 'Synchro Summon: select the Tuner' : 'Synchro Summon: select a non-Tuner material', xyz: 'Xyz Summon: select the materials', fusion: 'Fusion Summon: select the materials', link: 'Link Summon: select the materials', ritual: 'Ritual Summon: select the materials' }[sm.frame] || null);
        const text = (what ? what + more : 'Select ' + (min === max ? min : min + '–' + max) + ' card' + (max > 1 ? 's' : ''));
        if (onField) return { type: 'fieldChoice', prompt: text, min, max, optional, cancelLabel, uids: cards.map(uidOf) };
        return { type: 'choice', prompt: what ? text : 'Select cards', min, max, optional, cancelLabel, cards: cards.map(cv) }; }
      default: return { type: 'option', prompt: 'The engine asked for something this client cannot show yet (' + (P.name || P.kind) + ').', options: [{ id: 'skip', label: 'Skip' }], cards: [] }; } }
  view(v) { const idle = this.pending && this.pending.player === v && (this.pending.kind === 'IDLECMD' || this.pending.kind === 'BATTLECMD'), P = this.pending;
    const you = this._playerView(v, v), opp = this._playerView(v, 1 - v), prompt = this._promptView(v), canAct = !!idle && this.tp === v; const phaseButtons = [];
    if (canAct) { if (P.kind === 'IDLECMD') { if (P.bp) phaseButtons.push({ id: 'battle', label: 'Battle Phase' }); if (P.ep) phaseButtons.push({ id: 'end', label: 'End Turn' }); } else { if (P.m2) phaseButtons.push({ id: 'm2', label: 'Main Phase 2' }); if (P.ep) phaseButtons.push({ id: 'end', label: 'End Turn' }); } }
    const a = this.atk && locInfo(this.atk.body, 0), t = this.atk && locInfo(this.atk.body, 10);
    return { rules: this.rules, emz: this.rules === 'modern' ? this._emz(v) : undefined, turn: this.turn, phase: this.phase || 'draw', turnOf: this.tp === v ? 'you' : 'opp', first: this.firstSeat === v ? 'you' : 'opp', gameOver: this.over, winner: this.over && this.winner != null ? this.side(this.winner, v) : null,
      you, opp, prompt, canAct, phaseButtons, chain: this._chainView(v), botBusy: !this.over && !(P && P.player === v), log: this.logs.slice(-40),
      pendingAttack: a ? { attacker: (this._entAt(v, a.con, a.loc, a.seq) || {}).uid || null, target: t && t.loc ? (this._entAt(v, t.con, t.loc, t.seq) || {}).uid || null : null } : null }; }

  _finalize(raw) { const snap = this._snap(); for (const v of [0, 1]) { this._reconcile(v, snap); const events = this._events(v, raw); this.seat[v].outbox.push({ events, view: this.view(v) }); if (this.seat[v].wake) { const w = this.seat[v].wake; this.seat[v].wake = null; w(); } } this.pre = null; }

  // ---------------------------------------------------------------- client API
  _reply(v, ok, message) { const S = this.seat[v]; if (S.outbox.length) { const all = S.outbox.splice(0); return { ok, message: ok ? null : message, view: all[all.length - 1].view, events: all.flatMap(b => b.events) }; } return { ok, message: ok ? null : message, view: this.view(v), events: [] }; }
  state(v) { return this._reply(v, true); }
  async step(v) { const S = this.seat[v]; if (!S.outbox.length && !this.over) await new Promise(r => { S.wake = r; setTimeout(r, 450); }); return this._reply(v, true); }
  act(v, type, p = {}) { if (type === 'state') return this.state(v); if (type === 'step') return this.step(v);
    if (this.over) return this._reply(v, false, 'The duel is over.');
    if (type === 'surrender') { this.over = true; this.winner = 1 - v; this._finalize([{ id: 5, body: Buffer.from([1 - v, 0]) }]); return this._reply(v, true); }
    const P = this.pending; if (!P || P.player !== v) return this._reply(v, false, "It's not your decision right now.");
    const ent = this.seat[v].ent, E0 = p.uid ? ent.find(e => e.uid === p.uid) : null, sameLoc = (a, e) => e && a.con === e.con && a.loc === e.loc && a.seq === e.seq;
    const respond = (buf, auto) => { this.auto = auto ? { seat: v, ...auto } : null; this._run(buf); return this._reply(v, true); };
    const bad = m => this._reply(v, false, m);
    const mapAct = ['spell', 'activateSet', 'monsterEffect', 'quick', 'handEffect', 'handCard', 'gemini', 'activate'];
    if (P.kind === 'IDLECMD') {
      if (type === 'summon' || type === 'set') { const list = type === 'summon' ? P.summon : P.mset, i = list.findIndex(e => sameLoc(e, E0)); if (i < 0) return bad("That monster can't be summoned right now."); return respond(encode(P, { cmd: type === 'summon' ? 'summon' : 'mset', idx: i }), { tributes: (p.tributes || []).map(Number) }); }
      if (type === 'setSpellTrap') { const i = P.sset.findIndex(e => sameLoc(e, E0)); if (i < 0) return bad("That card can't be Set right now."); return respond(encode(P, { cmd: 'sset', idx: i })); }
      if (type === 'position') { const i = P.repos.findIndex(e => sameLoc(e, E0)); if (i < 0) return bad("That monster can't change position."); return respond(encode(P, { cmd: 'repos', idx: i })); }
      if ((type === 'engine') && E0 && E0.loc === LOC.EXTRA) this.summoning = { frame: frameOf(E0.type || (info(E0.code) || {}).type || 0), name: cname(E0.code) };
      if (type === 'engine' || mapAct.includes(type)) { const cmd = p.cmd || 'activate'; const list = cmd === 'spsummon' ? P.spsummon : P.activate; const hits = list.map((e, i) => [e, i]).filter(([e]) => sameLoc(e, E0)); const h = p.idx != null ? hits.find(([, i]) => i === p.idx) : hits[0]; if (!h) return bad("That effect can't be activated right now."); return respond(encode(P, { cmd, idx: h[1] })); }
      if (type === 'gotoPhase' && p.phase === 'battle') return respond(encode(P, { cmd: 'bp' }));
      if (type === 'endTurn' || type === 'nextPhase') return respond(encode(P, { cmd: 'ep' }));
      if (type === 'gotoPhase' && p.phase === 'end') return respond(encode(P, { cmd: 'ep' })); }
    if (P.kind === 'BATTLECMD') {
      if (type === 'attack') { const i = P.attack.findIndex(e => sameLoc(e, E0)); if (i < 0) return bad("That monster can't attack."); return respond(encode(P, { cmd: 'attack', idx: i }), p.target ? { target: p.target } : null); }
      if (type === 'engine' || mapAct.includes(type)) { const hits = P.activate.map((e, i) => [e, i]).filter(([e]) => sameLoc(e, E0)); const h = p.idx != null ? hits.find(([, i]) => i === p.idx) : hits[0]; if (!h) return bad("That effect can't be activated right now."); return respond(encode(P, { cmd: 'activate', idx: h[1] })); }
      if (type === 'gotoPhase' && p.phase === 'm2') return respond(encode(P, { cmd: 'm2' }));
      if (type === 'endTurn' || type === 'nextPhase' || (type === 'gotoPhase' && p.phase === 'end')) return respond(encode(P, { cmd: 'ep' })); }
    if (P.kind === 'CHAIN') {
      if (type === 'passResponse') return respond(i32(-1));
      if (mapAct.includes(type) || type === 'engine') { const hits = P.chains.map((c, i) => [c, i]).filter(([c]) => sameLoc(c, E0)); const h = p.idx != null ? hits.find(([, i]) => i === p.idx) : hits[0]; if (!h) return bad("That effect can't be chained right now."); return respond(i32(h[1])); } }
    if (type === 'option') { const id = String(p.id);
      if (P.kind === 'YESNO' || P.kind === 'EFFECTYN') return respond(encode(P, { yes: id === '1' }));
      if (P.kind === 'OPTION' || P.kind === 'ANNOUNCE_NUMBER') return respond(encode(P, { idx: Number(id) }));
      if (P.kind === 'POSITION') return respond(encode(P, { pos: Number(id) }));
      if (P.kind === 'ANNOUNCE_RACE' || P.kind === 'ANNOUNCE_ATTRIB') return respond(encode(P, { mask: Number(id) }));
      return respond(i32(-1)); }
    if (type === 'place' && (P.kind === 'PLACE' || P.kind === 'DISFIELD')) return respond(encode(P, { player: p.side === 'you' ? v : 1 - v, loc: p.kind === 'monster' ? 4 : 8, seq: Number(p.seq) }));
    if (type === 'announceCard' && P.kind === 'ANNOUNCE_CARD') return respond(encode(P, { code: Number(p.code) }));
    if (type === 'choice' || type === 'cancelChoice') {
      const uids = p.uids || [], idxOf = u => { const e = ent.find(x => x.uid === u); const i = e ? P.cards.findIndex(c => c.con === e.con && c.loc === e.loc && c.seq === e.seq) : -1; return i >= 0 ? i : (String(u).startsWith('p') ? Number(String(u).slice(1)) : -1); };
      if (type === 'cancelChoice') {
        const no = () => bad("This selection can't be cancelled.");
        if (P.kind === 'UNSELECT') { if (!P.picked.length) return P.cancel ? respond(encode(P, { finish: true })) : no(); if (!this.undoOK) return no(); return respond(encode(P, { idx: P.cards.length }), { undo: true }); } // finish and cancel are the same answer in the engine, so un-pick everything first
        return P.cancel ? respond(encode(P, { cancel: true })) : no(); }
      if (P.kind === 'CARD' || P.kind === 'TRIBUTE') { const sel = uids.map(idxOf).filter(i => i >= 0); return respond(encode(P, { sel })); }
      if (P.kind === 'UNSELECT') { if (!uids.length) { if (!(P.finish || P.cancel)) return bad('Select ' + (P.min || 1) + ' card(s) to continue (or Skip when the prompt allows it).'); return respond(encode(P, { finish: true })); }
        const idx = idxOf(uids[0]); if (idx < 0) return bad("That card isn't part of this selection prompt — pick one of the highlighted cards."); return respond(encode(P, { idx }), { picks: uids.slice(1) }); } }
    return bad('That action is not available right now.'); }
}
