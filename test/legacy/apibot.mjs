const BASE = process.env.BASE || 'http://localhost:3200'; const evTypes = {}, promptTypes = {}, errs = []; let maxTurn = 0, over = null, actions = {};
const call = async (tab, method, url, body) => { const r = await fetch(BASE + url, { method, headers: { 'content-type': 'application/json', 'x-tab': tab }, body: body ? JSON.stringify(body) : undefined }); let j = null; try { j = await r.json() } catch {} return { s: r.status, j } };
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function player(tab, deck, name) {
  let r = await call(tab, 'POST', '/api/duel/join', { playerDeck: deck, mode: process.env.MODE || 'classic' }); if (r.s !== 200) { errs.push('join ' + JSON.stringify(r.j)); return; }
  for (let i = 0; i < 50; i++) { const l = await call(tab, 'GET', '/api/duel/lobby'); if (l.j.status === 'started') break; await sleep(200); }
  let res = (await call(tab, 'GET', '/api/duel/state')).j; const t0 = Date.now(); let idle = 0;
  while (Date.now() - t0 < (+process.env.SECS || 40) * 1000) {
    const v = res.view; for (const e of res.events || []) evTypes[e.type] = (evTypes[e.type] || 0) + 1; maxTurn = Math.max(maxTurn, v.turn);
    if (v.gameOver) { over = v.winner; break; }
    let act = null; const p = v.prompt;
    if (p) { promptTypes[p.type] = (promptTypes[p.type] || 0) + 1;
      if (p.type === 'option') act = ['option', { id: p.options[0].id }];
      else if (p.type === 'chain' || p.type === 'battleResponse' || p.type === 'summonResponse') act = p.options.length && Math.random() < .5 ? ['engine', { uid: p.options[0].uid }] : ['passResponse', {}];
      else if (p.type === 'choice') act = ['choice', { uids: p.cards.slice(0, Math.max(p.min, 1)).map(c => c.uid) }];
      else if (p.type === 'fieldChoice') act = ['choice', { uids: p.uids.slice(0, Math.max(p.min, 1)) }];
      else if (p.type === 'search') { const s = await call(tab, 'GET', '/api/cards/search?q=Dark'); act = ['announceCard', { code: s.j.cards[Math.floor(Math.random() * s.j.cards.length)].id }]; }
    } else if (v.canAct) {
      const hand = v.you.hand, mons = v.you.monsters;
      const h = hand.find(c => c.act && c.act.summon && !c.act.summon.tributes) || hand.find(c => c.act && c.act.summon && c.act.summon.tributes && mons.filter(Boolean).length >= c.act.summon.tributes);
      const e = [...hand, ...v.you.spellTrap, ...mons].find(c => c && c.act && c.act.eng && c.act.eng.length && Math.random() < .6);
      const st = hand.find(c => c.act && c.act.setSpellTrap); const atk = mons.find(c => c && c.act && c.act.attack);
      if (h) { const tr = []; if (h.act.summon.tributes) mons.forEach((m, i) => { if (m && tr.length < h.act.summon.tributes) tr.push(i); }); act = ['summon', { uid: h.uid, tributes: tr }]; }
      else if (atk) act = ['attack', { uid: atk.uid, target: atk.act.attack.targets[0] || null }];
      else if (e) act = ['engine', { uid: e.uid, cmd: e.act.eng[0].cmd, idx: e.act.eng[0].idx }];
      else if (st && Math.random() < .5) act = ['setSpellTrap', { uid: st.uid }];
      else if (v.phaseButtons.some(b => b.id === 'battle') && Math.random() < .7) act = ['gotoPhase', { phase: 'battle' }];
      else if (v.phaseButtons.some(b => b.id === 'm2') && Math.random() < .3) act = ['gotoPhase', { phase: 'm2' }];
      else act = ['endTurn', {}];
    }
    if (act) { actions[act[0]] = (actions[act[0]] || 0) + 1; res = (await call(tab, 'POST', '/api/duel/act', { type: act[0], ...act[1] })).j; if (res && res.ok === false && res.message) errs.push(act[0] + ': ' + res.message); idle = 0; }
    else { res = (await call(tab, 'POST', '/api/duel/act', { type: 'step' })).j; if (++idle > 400) { errs.push('stuck waiting'); break; } }
    if (!res || !res.view) { errs.push('bad response ' + JSON.stringify(res).slice(0, 120)); break; }
  }
}
await Promise.all([player('tabA', process.env.DA || 'yugi'), player('tabB', process.env.DB || 'kaiba')]);
console.log(JSON.stringify({ maxTurn, over, events: evTypes, prompts: promptTypes, actions, errorSample: [...new Set(errs)].slice(0, 8), errorCount: errs.length }, null, 1));
process.exit(0);
