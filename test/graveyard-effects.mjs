import { Match } from '../match.js'; import fs from 'node:fs';
const deck = JSON.parse(fs.readFileSync('deck_inventory/my_resonator.json')); const main = deck.mainDeck.map(c => c.id), extra = deck.extraDeck.map(c => c.id);
const pl = n => ({ name: n, deckName: 'My Resonator', main: [...main], extra: [...extra] });
const SCEN = process.env.SCEN || 'vision';
const setups = {
  vision: [{ p: 0, code: 98396890, loc: 4, seq: 0, pos: 1 }, { p: 0, code: 70781052, loc: 4, seq: 1, pos: 1 }],                                  // Vision Resonator (Lv2 Tuner) + Summoned Skull (Lv6)
  synkron: [{ p: 0, code: 77360173, loc: 4, seq: 0, pos: 1 }, { p: 0, code: 6368038, loc: 4, seq: 1, pos: 1 }, { p: 0, code: 34761841, loc: 16, seq: 0, pos: 1 }] // Synkron Resonator (Lv1) + Gaia (Lv7), Crimson Resonator already in the GY
};
const m = new Match([pl('A'), pl('B')], { rules: 'classic', setup: setups[SCEN] });
const names = c => c.map(x => x.name); const handOf = v => names(v.you.hand).sort().join(', ');
let r = m.act(0, 'state'), v = r.view; const handBefore = v.you.hand.length, gyBefore = v.you.graveyard.length; console.log(`[${SCEN}] before: hand ${handBefore}, GY [${names(v.you.graveyard)}]`);
const ex = v.you.extra.find(c => c.name === 'Red Dragon Archfiend'); console.log('Red Dragon Archfiend offered:', !!(ex && ex.act.eng.length));
r = m.act(0, 'engine', { uid: ex.uid, cmd: ex.act.eng[0].cmd, idx: ex.act.eng[0].idx }); v = r.view;
for (let i = 0; i < 14; i++) { const p = v.prompt; if (!p) break; let act;
  const desc = JSON.stringify({ t: p.type, text: p.prompt, opts: (p.options || []).map(o => o.name || o.label), n: (p.uids || p.cards || p.zones || []).length, min: p.min });
  if (p.type === 'fieldChoice') act = ['choice', { uids: p.uids.slice(0, Math.max(1, p.min)) }];
  else if (p.type === 'choice') act = ['choice', { uids: p.cards.slice(0, Math.max(1, p.min)).map(c => c.uid) }];
  else if (p.type === 'place') act = ['place', p.zones[0]];
  else if (['chain', 'summonResponse', 'battleResponse'].includes(p.type)) { const o = p.options[0]; act = o ? ['engine', { uid: o.uid }] : ['passResponse', {}]; }
  else if (p.type === 'option') act = ['option', { id: p.options[0].id }];
  else { console.log('UNHANDLED', desc); break; }
  console.log('  prompt', desc, '->', act[0]); r = m.act(0, act[0], act[1]); if (r.ok === false) console.log('  REFUSED:', r.message); v = r.view; }
console.log(`after:  hand ${v.you.hand.length} (${v.you.hand.length - handBefore >= 0 ? '+' : ''}${v.you.hand.length - handBefore} vs before) | GY [${names(v.you.graveyard)}] | field [${names(v.you.monsters.filter(Boolean))}] | pending prompt: ${v.prompt ? v.prompt.type : 'none'} | canAct: ${v.canAct}`);
console.log('new cards in hand are:', names(v.you.hand).join(', '));
console.log('log tail:', v.log.slice(-6).join(' / '));
process.exit(0);
