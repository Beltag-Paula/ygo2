import { MSG, cname, descText } from './engine.js';
class Buf { constructor(b) { this.b = b; this.o = 0; } u8() { return this.b[this.o++]; } u32() { const v = this.b.readUInt32LE(this.o); this.o += 4; return v; } u64() { const v = this.b.readBigUInt64LE(this.o); this.o += 8; return Number(v); } loc() { return { con: this.u8(), loc: this.u8(), seq: this.u32(), pos: this.u32() }; } }
function cardList(r, withLoc) { const n = r.u32(), a = []; for (let i = 0; i < n; i++) { const code = r.u32(); const c = { code, name: cname(code) }; if (withLoc) Object.assign(c, r.loc()); a.push(c); } return a; }
function parsePrompt(id, b) { const r = new Buf(b); const pl = r.u8(); const P = { kind: MSG[id], player: pl };
  const small = (extra) => { const n = r.u32(), a = []; for (let i = 0; i < n; i++) { const code = r.u32(), con = r.u8(), loc = r.u8(), seq = extra === 'u32' ? r.u32() : r.u8(); a.push({ code, name: cname(code), con, loc, seq }); } return a; };
  const act = () => { const n = r.u32(), a = []; for (let i = 0; i < n; i++) { const code = r.u32(), con = r.u8(), loc = r.u8(), seq = r.u32(), d = r.u64(); r.u8(); a.push({ code, name: cname(code), con, loc, seq, desc: descText(d, code) }); } return a; };
  switch (id) {
    case 11: P.summon = small('u32'); P.spsummon = small('u32'); P.repos = small('u8'); P.mset = small('u32'); P.sset = small('u32'); P.activate = act(); P.bp = r.u8(); P.ep = r.u8(); P.shuffle = r.u8(); break;
    case 10: P.activate = act(); { const n = r.u32(); P.attack = []; for (let i = 0; i < n; i++) { const code = r.u32(), con = r.u8(), loc = r.u8(), seq = r.u8(), direct = r.u8(); P.attack.push({ code, name: cname(code), con, loc, seq, direct }); } } P.m2 = r.u8(); P.ep = r.u8(); break;
    case 12: { const code = r.u32(); P.card = { code, name: cname(code), ...r.loc() }; P.desc = descText(r.u64(), code); break; }
    case 13: P.desc = descText(r.u64(), 0); break;
    case 14: { const n = r.u8(); P.options = []; for (let i = 0; i < n; i++) P.options.push(descText(r.u64(), 0)); break; }
    case 15: P.cancel = r.u8(); P.min = r.u32(); P.max = r.u32(); P.cards = cardList(r, true); break;
    case 20: P.cancel = r.u8(); P.min = r.u32(); P.max = r.u32(); { const n = r.u32(); P.cards = []; for (let i = 0; i < n; i++) { const code = r.u32(), con = r.u8(), loc = r.u8(), seq = r.u32(), rp = r.u8(); P.cards.push({ code, name: cname(code), con, loc, seq, rel: rp }); } } break;
    case 26: P.finish = r.u8(); P.cancel = r.u8(); P.min = r.u32(); P.max = r.u32(); P.cards = cardList(r, true); P.picked = cardList(r, true); break;
    case 16: { P.spe = r.u8(); P.forced = r.u8(); r.u32(); r.u32(); const n = r.u32(); P.chains = []; for (let i = 0; i < n; i++) { const code = r.u32(), l = r.loc(), d = r.u64(); r.u8(); P.chains.push({ code, name: cname(code), ...l, desc: descText(d, code) }); } break; }
    case 18: case 24: P.count = r.u8(); P.flag = r.u32(); break;
    case 19: { const code = r.u32(); P.card = { code, name: cname(code) }; P.positions = r.u8(); break; }
    case 140: P.count = r.u8(); P.available = Number(r.u64()); break;
    case 141: P.count = r.u8(); P.available = r.u32(); break;
    case 142: break;
    case 143: { const n = r.u8(); P.values = []; for (let i = 0; i < n; i++) P.values.push(r.u64()); break; }
    default: return null; }
  return P; }
const i32 = (...v) => { const b = Buffer.alloc(4 * v.length); v.forEach((x, i) => b.writeInt32LE(x, 4 * i)); return b; };
function encode(P, d) { const idle = { summon: 0, spsummon: 1, repos: 2, mset: 3, sset: 4, activate: 5, bp: 6, ep: 7, shuffle: 8 }, bat = { activate: 0, attack: 1, m2: 2, ep: 3 };
  const sel = () => { if (d.cancel) return i32(-1); const s = d.sel || []; const b = Buffer.alloc(8 + s.length); b.writeInt32LE(2, 0); b.writeUInt32LE(s.length, 4); s.forEach((x, i) => b[8 + i] = x); return b; };
  switch (P.kind) {
    case 'IDLECMD': return i32((((d.idx || 0) << 16) | idle[d.cmd]) >>> 0 | 0);
    case 'BATTLECMD': return i32((((d.idx || 0) << 16) | bat[d.cmd]) >>> 0 | 0);
    case 'EFFECTYN': case 'YESNO': return i32(d.yes ? 1 : 0);
    case 'OPTION': return i32(d.idx); case 'CHAIN': return i32(d.idx); case 'POSITION': return i32(d.pos);
    case 'CARD': case 'TRIBUTE': return sel();
    case 'UNSELECT': return d.finish ? i32(-1) : i32(1, d.idx);
    case 'PLACE': case 'DISFIELD': return Buffer.from([d.player, d.loc, d.seq]);
    case 'ANNOUNCE_RACE': { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(d.mask)); return b; }
    case 'ANNOUNCE_ATTRIB': { const b = Buffer.alloc(4); b.writeUInt32LE(d.mask >>> 0); return b; }
    case 'ANNOUNCE_CARD': return i32(d.code); case 'ANNOUNCE_NUMBER': return i32(d.idx); } }

export { parsePrompt, encode, i32 };
