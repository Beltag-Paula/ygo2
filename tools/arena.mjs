// Bot arena: every duelist plays every other one headless (no delays) and the results are tabulated.
//   DB_PATH=:memory: node tools/arena.mjs [gamesPerSeating=2] [maxTurns=40]
process.env.DB_PATH = ':memory:';
const { Match } = await import('../match.js'); const { Bot } = await import('../bot.js'); const { BOTS, forMatch } = await import('../decks.js');
const GAMES = +process.argv[2] || 2, MAXT = +process.argv[3] || 40, errors = [];
const origErr = console.error; console.error = (...a) => { errors.push(a.join(' ')); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const mk = b => { const { main, extra } = forMatch(b.deck); return { name: b.name, deckName: b.deckName, avatar: b.portrait, frame: b.frame, main, extra }; };

async function duel(A, B) {            // A sits first; returns winner index (0/1) or -1 for a stalled game
  const m = new Match([mk(A), mk(B)], { rules: 'classic' }), bots = [A, B].map((x, i) => new Bot(m, i, { persona: x.key, delay: [0, 0] }));
  bots.forEach(b => b.run()); const t0 = Date.now();
  while (!m.over && m.turn <= MAXT && Date.now() - t0 < 90000) await sleep(20);
  const res = { winner: m.over ? m.winner : -1, turns: m.turn, lp: [...m.lp], ms: Date.now() - t0, log: m.logs.filter(l => /“/.test(l)).length };
  bots.forEach(b => b.stop()); m.destroy(); return res;
}
const names = BOTS.map(b => b.key), W = {}, T = {}, D = {};
for (const k of names) { W[k] = {}; T[k] = 0; D[k] = 0; for (const j of names) W[k][j] = 0; }
let games = 0, stalled = 0, turns = 0, said = 0;
for (let i = 0; i < BOTS.length; i++) for (let j = i + 1; j < BOTS.length; j++) for (let g = 0; g < GAMES * 2; g++) {
  const [A, B] = g % 2 ? [BOTS[j], BOTS[i]] : [BOTS[i], BOTS[j]];
  const r = await duel(A, B); games++; turns += r.turns; said += r.log;
  if (r.winner < 0) { stalled++; D[A.key]++; D[B.key]++; process.stdout.write('~'); continue; }
  const win = r.winner === 0 ? A : B, lose = r.winner === 0 ? B : A; W[win.key][lose.key]++; T[win.key]++; process.stdout.write(win.key[0].toUpperCase());
}
console.log('\n\nWins (row beat column):'); console.log('        ' + names.map(n => n.padStart(6)).join(''));
for (const k of names) console.log(k.padEnd(8) + names.map(j => String(W[k][j]).padStart(6)).join('') + '   total ' + T[k]);
console.log(`\n${games} games, avg ${(turns / games).toFixed(1)} turns, ${stalled} stalled/too long, ${said} persona lines spoken, ${errors.length} engine/bot errors`);
if (errors.length) console.log([...new Set(errors)].slice(0, 6).join('\n'));
process.exit(0);
