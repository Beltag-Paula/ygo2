import { Match } from '../match.js'; import fs from 'node:fs';
const deck = JSON.parse(fs.readFileSync('deck_inventory/my_resonator.json')); const main = deck.mainDeck.map(c => c.id), extra = deck.extraDeck.map(c => c.id);
const pl = n => ({ name: n, deckName: 'd', main: [...main], extra: [...extra] });
const names = c => c.filter(Boolean).map(x => x.name);
const mk = setup => new Match([pl('A'), pl('B')], { rules: 'classic', setup });
const snap = v => `field [${names(v.you.monsters)}] GY [${names(v.you.graveyard)}] hand ${v.you.hand.length} canAct:${v.canAct} prompt:${v.prompt ? v.prompt.type : 'none'}`;
let fails = 0; const check = (ok, label) => { console.log((ok ? 'PASS' : 'FAIL') + '  ' + label); if (!ok) fails++; };
const synSetup = [{ p: 0, code: 34761841, loc: 4, seq: 0, pos: 1 }, { p: 0, code: 70781052, loc: 4, seq: 1, pos: 1 }];
const startSyn = m => { let v = m.act(0, 'state').view; const ex = v.you.extra.find(c => c.name === 'Red Dragon Archfiend'); return m.act(0, 'engine', { uid: ex.uid, cmd: ex.act.eng[0].cmd, idx: ex.act.eng[0].idx }); };
const finishSyn = (m, r) => { let v = r.view; for (let i = 0; i < 8 && v.prompt; i++) { const p = v.prompt; const act = p.type === 'fieldChoice' ? ['choice', { uids: p.uids.slice(0, Math.max(1, p.min)) }] : p.type === 'place' ? ['place', p.zones[0]] : p.type === 'option' ? ['option', { id: p.options[0].id }] : null; if (!act) break; v = m.act(0, act[0], act[1]).view; } return v; };

// A. cancel at the very first step (nothing picked yet)
{ const m = mk(synSetup); let r = startSyn(m); let v = r.view; console.log('A1 first step :', v.prompt.prompt, '| optional:', v.prompt.optional, '| label:', v.prompt.cancelLabel);
  r = m.act(0, 'cancelChoice'); v = r.view; console.log('A2 after cancel:', snap(v)); check(!v.prompt && v.canAct && names(v.you.monsters).length === 2 && !names(v.you.monsters).includes('Red Dragon Archfiend'), 'A  cancel at step 1 returns to the main phase, nothing summoned, both monsters still on the field');
  v = finishSyn(m, startSyn(m)); check(names(v.you.monsters).join() === 'Red Dragon Archfiend', 'A  the Synchro can then be done normally afterwards'); }
// B. cancel after the Tuner was already picked (finish and cancel are the same answer in the engine)
{ const m = mk(synSetup); let r = startSyn(m); let v = r.view; r = m.act(0, 'choice', { uids: v.prompt.uids.slice(0, 1) }); v = r.view; console.log('B1 after Tuner :', v.prompt.prompt, '| optional:', v.prompt.optional, '| label:', v.prompt.cancelLabel);
  check(v.prompt && v.prompt.optional === true, 'B  after picking the Tuner the prompt still offers Cancel');
  r = m.act(0, 'cancelChoice'); v = r.view; console.log('B2 after cancel:', r.ok === false ? 'REFUSED ' + r.message : snap(v));
  check(r.ok !== false && !v.prompt && v.canAct && names(v.you.monsters).length === 2 && v.you.graveyard.length === 0, 'B  cancel after picking the Tuner un-picks it, aborts the summon, nothing sent to the Graveyard');
  v = finishSyn(m, startSyn(m)); check(names(v.you.monsters).join() === 'Red Dragon Archfiend', 'B  a Synchro with the same cards works afterwards'); }
// C. cancel a Tribute Summon at the tribute prompt
{ const m = mk([{ p: 0, code: 91152256, loc: 4, seq: 0, pos: 1 }, { p: 0, code: 70781052, loc: 2, seq: 0, pos: 1 }]); let v = m.act(0, 'state').view; const sk = v.you.hand.find(c => c.name === 'Summoned Skull'); const handBefore = v.you.hand.length;
  console.log('C0 summon offered:', JSON.stringify(sk && sk.act.summon && { tributes: sk.act.summon.tributes }));
  let r = m.act(0, 'summon', { uid: sk.uid, tributes: [] }); v = r.view; console.log('C1 tribute prompt:', v.prompt && v.prompt.type, v.prompt && v.prompt.prompt, '| optional:', v.prompt && v.prompt.optional);
  if (v.prompt) { r = m.act(0, 'cancelChoice'); v = r.view; console.log('C2 after cancel:', r.ok === false ? 'REFUSED ' + r.message : snap(v)); check(r.ok !== false && !v.prompt && v.canAct && v.you.hand.length === handBefore && names(v.you.monsters).join() === 'Celtic Guardian', 'C  cancel at the tribute prompt keeps the Skull in hand and the Celtic Guardian on the field'); } else check(false, 'C  expected a tribute prompt'); }
console.log(fails ? `\n${fails} FAILED` : '\nall cancel tests passed'); process.exit(fails ? 1 : 0);
