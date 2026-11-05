// cards.js — which cards exist, which are allowed in Classic, and a searchable index for the deck builder.
//   Modern  = every card in BabelCDB/cards.cdb (what the rules engine knows).
//   Classic = the card pool of the original simulator (TCG releases 2002-03 .. 2008-07, data/classic_pool.json).
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { db as cdb, info, SCRIPTS } from './engine.js';

export const EXTRA_T = 0x40 | 0x2000 | 0x800000 | 0x4000000; // Fusion | Synchro | Xyz | Link
const CLASSIC = new Set(JSON.parse(fs.readFileSync(new URL('./data/classic_pool.json', import.meta.url))).ids);

const ATTR = { 1: 'EARTH', 2: 'WATER', 4: 'FIRE', 8: 'WIND', 16: 'LIGHT', 32: 'DARK', 64: 'DIVINE' };
const RACE = { 1: 'Warrior', 2: 'Spellcaster', 4: 'Fairy', 8: 'Fiend', 16: 'Zombie', 32: 'Machine', 64: 'Aqua', 128: 'Pyro', 256: 'Rock', 512: 'Winged Beast', 1024: 'Plant', 2048: 'Insect', 4096: 'Thunder', 8192: 'Dragon', 16384: 'Beast', 32768: 'Beast-Warrior', 65536: 'Dinosaur', 131072: 'Fish', 262144: 'Sea Serpent', 524288: 'Reptile', 1048576: 'Psychic', 2097152: 'Divine-Beast', 4194304: 'Creator God', 8388608: 'Wyrm', 16777216: 'Cyberse', 33554432: 'Illusion' };
const FRAMES = ['normal', 'effect', 'ritual', 'fusion', 'synchro', 'xyz', 'pendulum', 'link', 'spell', 'trap'];
const attrBit = Object.fromEntries(Object.entries(ATTR).map(([k, v]) => [v, +k]));
const raceBit = Object.fromEntries(Object.entries(RACE).map(([k, v]) => [v, +k]));

export const frameOf = t => t & 2 ? 'spell' : t & 4 ? 'trap' : t & 0x4000000 ? 'link' : t & 0x800000 ? 'xyz' : t & 0x2000 ? 'synchro' : t & 0x40 ? 'fusion' : t & 0x80 ? 'ritual' : t & 0x1000000 ? 'pendulum' : t & 0x20 ? 'effect' : 'normal';
function typeStr(t) {
  if (t & 2) return t & 0x80000 ? 'Field Spell' : t & 0x10000 ? 'Quick-Play Spell' : t & 0x20000 ? 'Continuous Spell' : t & 0x40000 ? 'Equip Spell' : t & 0x80 ? 'Ritual Spell' : 'Normal Spell';
  if (t & 4) return t & 0x20000 ? 'Continuous Trap' : t & 0x100000 ? 'Counter Trap' : 'Normal Trap';
  const p = [];
  if (t & 0x4000000) p.push('Link'); else if (t & 0x800000) p.push('Xyz'); else if (t & 0x2000) p.push('Synchro'); else if (t & 0x40) p.push('Fusion'); else if (t & 0x80) p.push('Ritual');
  if (t & 0x1000000) p.push('Pendulum'); if (t & 0x1000) p.push('Tuner'); p.push(t & 0x20 ? 'Effect' : 'Normal'); p.push('Monster'); return p.join(' ');
}
const scriptCache = new Map();
export function hasScript(id) {
  if (!scriptCache.has(id)) scriptCache.set(id, ['official', 'unofficial', ''].some(d => fs.existsSync(path.join(SCRIPTS, d, `c${id}.lua`))));
  return scriptCache.get(id);
}

// ---- in-memory search index ---------------------------------------------------------------------
const idx = new DatabaseSync(':memory:');
idx.exec(`CREATE TABLE c (id INTEGER PRIMARY KEY, alias INT, type INT, atk INT, def INT, lvl INT, race INT, attr INT, name TEXT, desc TEXT, classic INT, script INT);
          CREATE INDEX c_name ON c(name);`);
{
  const rows = cdb.prepare(`SELECT d.id, d.alias, d.type, d.atk, d.def, d.level, d.race, d.attribute, t.name, t.desc
    FROM datas d JOIN texts t ON t.id = d.id WHERE (d.type & 0x4000) = 0 AND t.name IS NOT NULL AND t.name != ''
      AND NOT (d.alias != 0 AND abs(d.alias - d.id) < 10)`).all();   // no tokens, no alternate-artwork duplicates
  const ins = idx.prepare('INSERT INTO c VALUES (?,?,?,?,?,?,?,?,?,?,?,?)');
  idx.exec('BEGIN');
  for (const r of rows) ins.run(r.id, r.alias, r.type, r.atk, r.def, r.level & 0xff, Number(r.race), r.attribute, r.name, r.desc || '', CLASSIC.has(r.id) ? 1 : 0, (r.type & 0x11) === 0x11 || hasScript(r.id) ? 1 : 0);
  idx.exec('COMMIT');
}

/** Is this passcode (or the card it is an alternate artwork of) allowed in the given mode? */
export function allowed(id, mode) {
  const c = info(id); if (!c) return false;
  if (c.type & 0x4000) return false;                    // tokens are not deck cards
  return mode === 'modern' ? true : CLASSIC.has(id) || (c.alias && CLASSIC.has(c.alias));
}
export const known = id => !!info(id) && !(info(id).type & 0x4000);
export const isExtra = id => !!(info(id)?.type & EXTRA_T);
/** Alternate artworks count as the same card for the 3-copy limit. */
export const canon = id => { const c = info(id); return c && c.alias && Math.abs(c.alias - id) < 10 ? c.alias : id; };
export const nameOf = id => info(id)?.name || '#' + id;

export function brief(r) {   // r: a row from the index
  const mon = !!(r.type & 1), link = !!(r.type & 0x4000000);
  const status = !(r.script) ? 'stub' : (r.type & 0x11) === 0x11 ? 'vanilla' : 'scripted';
  return { id: r.id, name: r.name, type: typeStr(r.type), kind: mon ? 'monster' : r.type & 2 ? 'spell' : 'trap', frame: frameOf(r.type),
    attr: mon ? ATTR[r.attr] || null : null, race: mon ? RACE[r.race] || RACE[Number(r.race) & -Number(r.race)] || null : null, level: mon && !link ? r.lvl : null,
    atk: mon ? r.atk : null, def: mon && !link ? r.def : null, desc: r.desc, image: '/pics/s/' + r.id + '.jpg', big: '/pics/' + r.id + '.jpg',
    script: status, extra: !!(r.type & EXTRA_T), classic: !!r.classic };
}
export function briefById(id) {
  const r = idx.prepare('SELECT * FROM c WHERE id = ?').get(id) || (() => { const c = info(id); if (!c) return null;
    return { id, alias: c.alias, type: c.type, atk: c.atk, def: c.def, lvl: c.level & 0xff, race: c.race, attr: c.attribute, name: c.name, desc: c.desc || '', classic: allowed(id, 'classic') ? 1 : 0, script: hasScript(id) ? 1 : 0 }; })();
  return r ? brief(r) : null;
}

export function meta() { return { attrs: Object.values(ATTR), races: Object.values(RACE), frames: FRAMES }; }

const FRAME_SQL = {
  normal: '(type & 1) AND (type & 0x10) AND NOT (type & 0x1000000)', effect: '(type & 0x21) = 0x21 AND NOT (type & (0x40|0x80|0x2000|0x800000|0x4000000|0x1000000))',
  ritual: '(type & 1) AND (type & 0x80)', fusion: '(type & 0x40) AND (type & 1)', synchro: '(type & 0x2000)', xyz: '(type & 0x800000)',
  pendulum: '(type & 0x1000000)', link: '(type & 0x4000000)', spell: '(type & 2)', trap: '(type & 4)' };

export function search(f = {}, mode = 'modern') {
  const w = [], a = [];
  if (mode === 'classic') w.push('classic = 1');
  if (f.ids) { const ids = String(f.ids).split(',').map(Number).filter(Number.isInteger).slice(0, 200); w.push(`id IN (${ids.map(() => '?').join(',') || 'NULL'})`); a.push(...ids); }
  const q = String(f.q || '').trim().slice(0, 80);
  if (q) { if (/^\d{4,10}$/.test(q)) { w.push('(id = ? OR alias = ?)'); a.push(+q, +q); } else { w.push('(name LIKE ? OR desc LIKE ?)'); a.push('%' + q + '%', '%' + q + '%'); } }
  if (f.kind === 'monster') w.push('(type & 1)'); else if (f.kind === 'spell') w.push('(type & 2)'); else if (f.kind === 'trap') w.push('(type & 4)');
  if (attrBit[f.attr]) { w.push('attr = ?'); a.push(attrBit[f.attr]); }
  if (raceBit[f.race]) { w.push('(race & ?) != 0 AND (type & 1)'); a.push(raceBit[f.race]); }
  if (FRAME_SQL[f.frame]) w.push(FRAME_SQL[f.frame]);
  if (+f.lv > 0 && +f.lv <= 13) { w.push('lvl = ? AND (type & 1) AND NOT (type & 0x4000000)'); a.push(+f.lv); }
  if (f.script === 'scripted') w.push('script = 1 AND NOT ((type & 0x11) = 0x11)'); else if (f.script === 'vanilla') w.push('(type & 0x11) = 0x11');
  else if (f.script === 'stub') w.push('script = 0'); else if (f.script === 'playable') w.push('script = 1');
  const order = { atk: 'atk DESC', def: 'def DESC', level: 'lvl DESC', newest: 'id DESC' }[f.sort] || 'name COLLATE NOCASE';
  const where = w.length ? 'WHERE ' + w.join(' AND ') : '';
  const limit = Math.min(Math.max(+f.limit || 60, 1), 100), offset = Math.max(+f.offset || 0, 0);
  const total = idx.prepare(`SELECT COUNT(*) n FROM c ${where}`).get(...a).n;
  const rows = idx.prepare(`SELECT * FROM c ${where} ORDER BY ${q && !/^\d+$/.test(q) ? '(name LIKE ?) DESC, ' : ''}${order} LIMIT ? OFFSET ?`).all(...a, ...(q && !/^\d+$/.test(q) ? [q + '%'] : []), limit, offset);
  return { total, cards: rows.map(brief) };
}

/** A random declarable card for the bot ("declare a card" prompts). */
export function randomCard(mode = 'classic') {
  const r = idx.prepare(`SELECT id FROM c WHERE (type & 1) AND ${mode === 'classic' ? 'classic = 1' : '1'} ORDER BY random() LIMIT 1`).get(); return r?.id || 89631139;
}
/** Exact-name lookup (used to assemble decks from card names). */
export function idByName(name, mode = 'classic') {
  const r = idx.prepare(`SELECT id FROM c WHERE name = ? COLLATE NOCASE ${mode === 'classic' ? 'AND classic = 1' : ''} LIMIT 1`).get(name); return r ? r.id : null;
}
export const classicCount = CLASSIC.size;
