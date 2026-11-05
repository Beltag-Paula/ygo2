import fs from 'node:fs'; import path from 'node:path'; import { WASI } from 'node:wasi'; import { DatabaseSync } from 'node:sqlite';
export const SCRIPTS = process.env.SCRIPTS || './CardScripts', CDB = process.env.CDB || './BabelCDB/cards.cdb';
const db = new DatabaseSync(CDB, { readOnly: true });
const qCard = db.prepare(`select d.id,d.alias,d.type,d.atk,d.def,d.level,d.race,d.attribute,
  d.setcode&65535 s0,(d.setcode>>16)&65535 s1,(d.setcode>>32)&65535 s2,(d.setcode>>48)&65535 s3,
  t.name,t.desc,t.str1,t.str2,t.str3,t.str4,t.str5,t.str6,t.str7,t.str8,t.str9,t.str10,t.str11,t.str12,t.str13,t.str14,t.str15,t.str16
  from datas d left join texts t on t.id=d.id where d.id=?`);
const cache = new Map(); const info = c => { if (!cache.has(c)) cache.set(c, qCard.get(c) || null); return cache.get(c); };
const MSG = {1:'RETRY',2:'HINT',4:'START',5:'WIN',10:'BATTLECMD',11:'IDLECMD',12:'EFFECTYN',13:'YESNO',14:'OPTION',15:'CARD',16:'CHAIN',18:'PLACE',19:'POSITION',20:'TRIBUTE',21:'SORT_CHAIN',22:'COUNTER',23:'SUM',24:'DISFIELD',25:'SORT_CARD',26:'UNSELECT',40:'NEW_TURN',41:'NEW_PHASE',60:'SUMMONING',62:'SPSUMMONING',64:'FLIPSUMMONING',70:'CHAINING',90:'DRAW',91:'DAMAGE',92:'RECOVER',94:'LPUPDATE',100:'PAY_LPCOST',110:'ATTACK',111:'BATTLE',140:'ANNOUNCE_RACE',141:'ANNOUNCE_ATTRIB',142:'ANNOUNCE_CARD',143:'ANNOUNCE_NUMBER',130:'TOSS_COIN',131:'TOSS_DICE'};
const PHASES = {1:'Draw',2:'Standby',4:'Main 1',8:'Battle',16:'Battle',32:'Battle',64:'Battle',128:'Battle',256:'Main 2',512:'End'};
const cname = c => info(c)?.name || ('#' + c);
function descText(d, code) { d = Number(d); if (d >= 10000) { const r = info(d >>> 4); const s = r && r['str' + ((d & 15) + 1)]; if (s) return s; } return 'Activate ' + (code ? cname(code) : 'effect'); }

// ---------- wasm core ----------
const wasi = new WASI({ version: 'preview1' }); let inst, mem; const dec = new TextDecoder();
const cstr = p => { const b = new Uint8Array(mem.buffer); let e = p; while (b[e]) e++; return dec.decode(b.subarray(p, e)); };
const findScript = n => { n = n.replace(/^\.?\/?(script\/)?/, ''); for (const d of ['', 'official/', 'unofficial/']) { const f = path.join(SCRIPTS, d, n); if (fs.existsSync(f)) return f; } return null; };
const put = bytes => { const p = E.ygo_alloc(bytes.length + 1); const m = new Uint8Array(mem.buffer); m.set(bytes, p); m[p + bytes.length] = 0; return p; };
const loadScript = (duel, buf, name) => { const p = put(buf), n = put(Buffer.from(name)); const r = E.ygo_load_script(duel, p, buf.length, n); E.ygo_free(p); E.ygo_free(n); return r; };
const host = {
  read_card(code, out) { const c = info(code); if (!c) return; const o = new Uint32Array(mem.buffer, out, 40); const race = BigInt(c.race);
    o[1] = c.alias; o[2] = c.type; o[3] = c.level & 0xffff; o[4] = c.attribute; o[5] = Number(race & 0xffffffffn); o[6] = Number(race >> 32n);
    const link = c.type & 0x4000000; o[7] = c.atk; o[8] = link ? 0 : c.def; o[9] = (c.level >> 24) & 0xff; o[10] = (c.level >> 16) & 0xff; o[11] = link ? c.def : 0;
    o[12] = c.s0; o[13] = c.s1; o[14] = c.s2; o[15] = c.s3; },
  read_script(duel, namePtr) { const n = cstr(namePtr), f = findScript(n); return f ? loadScript(duel, fs.readFileSync(f), n) : 0; },
  log(s, t) { console.log('[core]', t, cstr(s)); },
};
const mod = await WebAssembly.compile(fs.readFileSync('ocgcore.wasm'));
inst = await WebAssembly.instantiate(mod, { wasi_snapshot_preview1: wasi.wasiImport, host }); mem = inst.exports.memory; wasi.initialize(inst);
const E = inst.exports;
const lenp = E.ygo_alloc(4);
const rd = (p, n) => Buffer.from(new Uint8Array(mem.buffer, p, n)); // copy
const getLen = () => new Uint32Array(mem.buffer, lenp, 1)[0];

// ---------- query / state ----------
const LOCS = { deck: 0x01, hand: 0x02, mz: 0x04, sz: 0x08, grave: 0x10, banish: 0x20, extra: 0x40 };
const QF = 0x1 | 0x2 | 0x8 | 0x10 | 0x20 | 0x40 | 0x100 | 0x200 | 0x10000 | 0x200000 | 0x400000 | 0x800000; // code pos type lvl rank attr atk def overlay lscale rscale link
function queryLoc(duel, con, loc) {
  const p = E.ygo_query_loc(duel, lenp, QF, con, loc); const b = rd(p, getLen()); const cards = []; let o = 4;
  while (o < b.length) { const sz = b.readUInt16LE(o); if (!sz) { o += 2; cards.push(null); continue; } const c = {};
    for (;;) { const s = b.readUInt16LE(o), f = b.readUInt32LE(o + 2), v = o + 6; if (f === 0x80000000) { o += s + 2; break; }
      if (f === 1) c.code = b.readUInt32LE(v); else if (f === 2) c.pos = b.readUInt32LE(v); else if (f === 8) c.type = b.readUInt32LE(v);
      else if (f === 0x10) c.level = b.readUInt32LE(v) & 0xff; else if (f === 0x20) c.rank = b.readUInt32LE(v); else if (f === 0x40) c.attr = b.readUInt32LE(v);
      else if (f === 0x100) c.atk = b.readInt32LE(v); else if (f === 0x200) c.def = b.readInt32LE(v);
      else if (f === 0x10000) { const n = b.readUInt32LE(v); c.xyz = n; } else if (f === 0x200000) c.lscale = b.readUInt32LE(v); else if (f === 0x400000) c.rscale = b.readUInt32LE(v); else if (f === 0x800000) { c.link = b.readUInt32LE(v); c.marker = b.readUInt32LE(v + 4); }
      o += s + 2; }
    cards.push(c); }
  return cards;
}
function lps(duel) { const p = E.ygo_query_field(duel, lenp); const b = rd(p, getLen()); let o = 4; const lp = [];
  for (let pl = 0; pl < 2; pl++) { lp.push(b.readUInt32LE(o)); o += 4; for (let i = 0; i < 7; i++) { if (b[o]) o += 6; else o += 1; } for (let i = 0; i < 8; i++) { if (b[o]) o += 6; else o += 1; } o += 24; }
  return lp; }
export { db, info, cname, descText, MSG, PHASES, E, lenp, rd, getLen, put, loadScript, queryLoc, lps, LOCS };
export const searchCards = q => db.prepare("select d.id, t.name from datas d join texts t on t.id = d.id where t.name like ? order by (t.name like ?) desc, t.name limit 40").all('%' + q + '%', q + '%');
