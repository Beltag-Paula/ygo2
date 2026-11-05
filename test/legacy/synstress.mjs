// Plays duels preferring Extra Deck summons and reports every refusal / stuck prompt (mimics a human's choices).
const BASE = process.env.BASE || 'http://localhost:3800', MODE = process.env.MODE || 'classic', SECS = +process.env.SECS || 30;
const call = async (tab, url, body) => { const r = await fetch(BASE + url, { method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json', 'x-tab': tab }, body: body ? JSON.stringify(body) : undefined }); return r.json().catch(() => null); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const stats = { fails: [], sp_attempt: 0, sp_ok: 0, refused: {}, prompts: {}, stuck: [], extraSeen: {}, turns: 0 };
async function player(tab, deck) {
  await call(tab, '/api/duel/join', { playerDeck: deck, mode: MODE }); for (let i = 0; i < 60; i++) { if ((await call(tab, '/api/duel/lobby')).status === 'started') break; await sleep(200); }
  let res = await call(tab, '/api/duel/state'), t0 = Date.now(), repeat = 0, lastSig = '', lastExtra = 0, attempt = null;
  while (Date.now() - t0 < SECS * 1000 && res && res.view && !res.view.gameOver) {
    const v = res.view, p = v.prompt; stats.turns = Math.max(stats.turns, v.turn); let act = null, label = '';
    if (p) { stats.prompts[p.type] = (stats.prompts[p.type] || 0) + 1;
      if (p.type === 'fieldChoice') { const n = p.min === 0 ? (p.max > 0 && p.uids.length ? 1 : 0) : p.min; act = ['choice', { uids: p.uids.slice(0, n) }]; label = 'fieldChoice min' + p.min + ' max' + p.max; }
      else if (p.type === 'choice') { const n = p.min === 0 ? (p.cards.length ? 1 : 0) : p.min; act = ['choice', { uids: p.cards.slice(0, n).map(c => c.uid) }]; label = 'choice'; }
      else if (p.type === 'place') { const z = p.zones.find(z => z.kind === 'monster' && z.seq >= 5) || p.zones[0]; act = ['place', z]; label = 'place'; }
      else if (p.type === 'option') { act = ['option', { id: p.options[0].id }]; label = 'option: ' + p.prompt; }
      else if (['chain', 'battleResponse', 'summonResponse'].includes(p.type)) { act = Math.random() < .5 && p.options.length ? ['engine', { uid: p.options[0].uid }] : ['passResponse', {}]; label = 'chain'; }
      else if (p.type === 'search') act = ['announceCard', { code: 46986414 }];
    } else if (v.canAct) {
      const sp = v.you.extra.find(c => c.act && c.act.eng && c.act.eng.length);
      if (sp) { for (const c of v.you.extra) if (c.act && c.act.eng && c.act.eng.length) stats.extraSeen[c.name] = (stats.extraSeen[c.name] || 0) + 1; act = ['engine', { uid: sp.uid, cmd: sp.act.eng[0].cmd, idx: sp.act.eng[0].idx }]; label = 'EXTRA ' + sp.name; stats.sp_attempt++; attempt = { name: sp.name, trace: [] }; lastExtra = v.you.monsters.filter(Boolean).length + (v.emz ? v.emz.filter(m => m && m.side === 'you').length : 0); }
      else { const h = v.you.hand.find(c => c.act && c.act.summon && !c.act.summon.tributes) || v.you.hand.find(c => c.act && c.act.summon && v.you.monsters.filter(Boolean).length >= c.act.summon.tributes);
        const e = [...v.you.hand, ...v.you.monsters.filter(Boolean), ...v.you.spellTrap.filter(Boolean)].find(c => c.act && c.act.eng && c.act.eng.length);
        const atk = v.you.monsters.find(c => c && c.act && c.act.attack);
        if (h) { const tr = []; if (h.act.summon.tributes) v.you.monsters.forEach((m, i) => { if (m && tr.length < h.act.summon.tributes) tr.push(i); }); act = ['summon', { uid: h.uid, tributes: tr }]; }
        else if (e) act = ['engine', { uid: e.uid, cmd: e.act.eng[0].cmd, idx: e.act.eng[0].idx }];
        else if (atk) act = ['attack', { uid: atk.uid, target: atk.act.attack.targets[0] || null }];
        else if (v.phaseButtons.some(b => b.id === 'battle')) act = ['gotoPhase', { phase: 'battle' }]; else act = ['endTurn', {}]; } }
    const sig = JSON.stringify([v.turn, v.phase, p && p.type, p && (p.uids || []).length, p && p.min]); repeat = act && sig === lastSig ? repeat + 1 : (act ? 0 : repeat); lastSig = act ? sig : lastSig;
    if (repeat > 6) { stats.debug = await call(tab, '/api/debug/duels'); stats.stuck.push({ tab, label, prompt: p && { type: p.type, min: p.min, max: p.max, prompt: p.prompt, n: (p.uids || p.cards || []).length }, turn: v.turn, phase: v.phase }); break; }
    if (attempt && p) attempt.trace.push({ type: p.type, min: p.min, max: p.max, n: (p.uids || p.cards || p.zones || p.options || []).length, text: p.prompt, send: act ? act[0] + ' ' + JSON.stringify(act[1]).slice(0, 50) : null });
    if (act) { const before = JSON.stringify(v.you.monsters.map(m => m && m.uid)); res = await call(tab, '/api/duel/act', { type: act[0], ...act[1] }); if (res && res.ok === false) { const k = (label || act[0]) + ' -> ' + res.message; stats.refused[k] = (stats.refused[k] || 0) + 1; }
      if (attempt && res && res.ok === false) attempt.trace.push({ refused: res.message });
      if (attempt && res && res.view && !res.view.prompt && !label.startsWith('EXTRA')) { const rv = res.view, names = [...rv.you.monsters, ...(rv.emz || []).filter(m => m && m.side === 'you')].filter(Boolean).map(m => m.name); if (names.includes(attempt.name)) { stats.sp_ok++; } else stats.fails.push(attempt); attempt = null; }
      if (label.startsWith('EXTRA') && res && res.view && !res.view.prompt) { if (attempt) { const rv = res.view, names = [...rv.you.monsters, ...(rv.emz || []).filter(m => m && m.side === 'you')].filter(Boolean).map(m => m.name); if (names.includes(attempt.name)) stats.sp_ok++; else stats.fails.push({ ...attempt, immediate: true, message: res.message }); attempt = null; } }
      if (false) { const nowN = res.view.you.monsters.filter(Boolean).length + (res.view.emz ? res.view.emz.filter(m => m && m.side === 'you').length : 0); if (nowN > lastExtra - 1) stats.sp_ok++; } }
    else { res = await call(tab, '/api/duel/act', { type: 'step' }); }
  }
}
await Promise.all([player('sA', process.env.DA || 'my_resonator'), player('sB', process.env.DB || 'my_resonator')]);
console.log(JSON.stringify({ mode: MODE, turns: stats.turns, spAttempts: stats.sp_attempt, spCompleted: stats.sp_ok, failedAttempts: stats.fails.slice(0, 4), refusals: stats.refused, prompts: stats.prompts, extraOffered: stats.extraSeen, stuck: stats.stuck, debug: stats.debug }, null, 1)); process.exit(0);
