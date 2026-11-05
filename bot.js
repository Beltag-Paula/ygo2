// bot.js — the computer duelists. A Bot sits in one seat of a Match and answers exactly the prompts a human would see
// (it reads the same per-player "view" the browser gets), so the rules engine stays the only source of truth.
//
// Each duelist has a PERSONA: how aggressive they are, how much they trust traps, which cards are their "aces", which
// cards they rush to play, and what they say. Underneath is a shared brain: effect-aware targeting (it knows whether a
// card is removal, a revival or an equip), a lethal check, trap timing, flip-monster handling and position management.
// It is a heuristic, not a search — but it plays to its deck's identity.

import { randomCard } from './cards.js';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const rnd = Math.random;

// ------------------------------------------------------------------------------------------------ personas
export const PERSONAS = {
  default: { aggr: 0.6, caution: 0.4, trapChain: 0.7, holdSets: false, tributeGain: 200, gambleAtk: 1800, gamble: 0, underdog: false, defend: 0.5, fusionFirst: false,
    aces: [], prio: [], delay: [650, 1100], lines: {} },

  // Yugi — patient, trap-minded, builds a board of strong monsters and ends with a big finisher. Hides his sets until Main 2.
  yugi: { aggr: 0.64, caution: 0.7, trapChain: 0.92, holdSets: true, tributeGain: 250, gambleAtk: 2100, defend: 0.6, underdog: true,
    aces: [/Dark Magician/, /Black Luster/, /Slifer/, /Buster Blader/, /Summoned Skull/, /Gaia/],
    prio: [[/Pot of Greed|Card Destruction/, 96], [/Monster Reborn/, 90], [/Dark Magician Girl|Magician of Black Chaos/, 0]], delay: [850, 1400],
    lines: { start: ['It’s time to duel!', 'I believe in the heart of the cards.'], ace: ['Come forth — my loyal monster!', 'I summon the magician of my deck!'], attack: ['Go! Attack!'], trap: ['You’ve activated my trap card!'], hurt: ['I won’t give up — not while I trust my deck.'], pressure: ['The cards are on my side.'] } },

  // Kaiba — total aggression. Tributes for the biggest monster, fuses Blue-Eyes, attacks into anything weaker, never hides.
  kaiba: { aggr: 0.97, caution: 0.1, trapChain: 0.6, holdSets: false, tributeGain: -500, gambleAtk: 1500, defend: 0.1, fusionFirst: true,
    aces: [/Blue-Eyes/, /Obelisk/],
    prio: [[/Polymerization/, 94], [/Burst Stream of Destruction/, 90], [/Heavy Storm|Graceful Charity|Pot of Greed/, 92], [/Cost Down/, 70]], delay: [450, 800],
    lines: { start: ['Prepare to lose, I’m not wasting time on amateurs.', 'This duel is mine.'], ace: ['Blue-Eyes White Dragon — obliterate them!', 'Behold the power of my ace!'], attack: ['White Lightning! Annihilate!', 'Pathetic. Attack!'], trap: ['Did you think I’d leave myself open?'], hurt: ['Impossible! I will not lose to you!'], pressure: ['Your life points end here.'] } },

  // Joey — the gambler. Dice/coin cards first, takes risky attacks, and fights harder the further behind he is.
  joey: { aggr: 0.72, caution: 0.2, trapChain: 0.65, holdSets: false, tributeGain: 100, gambleAtk: 1500, gamble: 0.55, underdog: true, defend: 0.35, fusionFirst: true,
    aces: [/Red-Eyes/, /Jinzo/, /Time Wizard/, /Black Skull/, /Thousand Dragon/, /Gilford/, /Flame Swordsman/],
    prio: [[/Dice|Roulette|Time Wizard|Skull Dice|Amplifier|Graceful Dice/, 91], [/Polymerization|Fusion Gate/, 86]], delay: [550, 950],
    lines: { start: ['Alright! Time to roll the dice!', 'Let’s go, I’m feeling lucky!'], ace: ['Go, Red-Eyes! Show ’em what you’ve got!', 'Here comes my heavy hitter!'], attack: ['Take this!', 'Charge!'], trap: ['Surprise! Didn’t see that coming, huh?'], hurt: ['I ain’t done yet — never give up!', 'Heart of the underdog, baby!'], pressure: ['Luck’s running my way!'] } },

  // Mai — Harpie swarm. Sets traps and spells and waits, fires Feather Duster, Egotist and Hysteric Party, strikes when she is safe.
  mai: { aggr: 0.64, caution: 0.6, trapChain: 0.88, holdSets: true, tributeGain: 200, gambleAtk: 1900, defend: 0.55,
    aces: [/Harpie Queen/, /Harpie’s Pet Dragon|Harpie's Pet Dragon/, /Cyber Harpie/, /Harpie Lady Sisters/],
    prio: [[/Harpie's Feather Duster/, 92], [/Elegant Egotist/, 93], [/Hysteric Party|Triangle Ecstasy Spark/, 90], [/Rising Air Current|Harpies' Hunting Ground|Cyber Shield/, 74], [/Graceful Charity/, 94]], delay: [700, 1100],
    lines: { start: ['Ready to lose, sweetie?', 'Let’s see if you can handle a real duelist.'], ace: ['Harpie ladies, show them your talons!', 'Spread your wings, my beauties!'], attack: ['Dance for me, ladies!'], trap: ['Didn’t your mother teach you to watch for traps?'], hurt: ['You’ll regret that, honey.'], pressure: ['The Harpies are circling.'] } },

  // Jesse — calm Crystal Beast player. Builds his crystal zone patiently, protects his Rainbow Dragon, rarely attacks without a clear edge.
  jesse: { aggr: 0.62, caution: 0.45, trapChain: 0.75, holdSets: true, tributeGain: 200, gambleAtk: 2200, defend: 0.6,
    aces: [/Rainbow Dragon/, /Rainbow Dark/, /Malefic/, /Yubel/, /Crystal Beast Ruby Carbuncle/, /Crystal Master/],
    prio: [[/Crystal Tree|Crystal Release|Crystal Beacon|Rainbow Bridge|Crystal Keeper|Golden Rule|Crystal Bond|Crystal Miracle/, 89], [/Advanced Dark/, 60]], delay: [800, 1250],
    lines: { start: ['Let’s have a fun duel!', 'The crystal beasts are with me.'], ace: ['Crystal Beasts, lend me your light!', 'Shine, Rainbow Dragon!'], attack: ['Go — Rainbow!'], trap: ['The gems protect me.'], hurt: ['I trust my friends — the crystal beasts.'], pressure: ['Almost time for the rainbow.'] } },

  // Jaden — Fusion-first Elemental HERO player. Polymerization before anything else, goes for the aggressive combo, loves to attack.
  jaden: { aggr: 0.85, caution: 0.3, trapChain: 0.68, holdSets: false, tributeGain: 0, gambleAtk: 1600, gamble: 0.25, defend: 0.25, fusionFirst: true, underdog: true,
    aces: [/Flame Wingman/, /Thunder Giant/, /Shining Flare/, /Neos/, /Wildedge/, /Rampart Blaster/, /Necroid Shaman/],
    prio: [[/Polymerization|Miracle Fusion|Fusion Gate|Super Polymerization/, 97], [/Hero Signal|Hero Mask|Mirage of Nightmare/, 80], [/Pot of Greed|Graceful Charity|Reinforcement/, 93]], delay: [500, 900],
    lines: { start: ['Get your game on!', 'It’s gonna be a great duel!'], ace: ['Gotcha! Fusion Summon — go, HERO!', 'Time to unleash a HERO!'], attack: ['Go get ’em!', 'Take this!'], trap: ['Sweet — I was hoping you’d do that!'], hurt: ['Whoa, that was close! Now it’s my turn.'], pressure: ['That’s game, I think!'] } }
};

// ------------------------------------------------------------------------------------------------ card-effect knowledge
// [name pattern, (state) => score | -1 (never now)]. Only dangerous / situational cards need a rule; the engine already
// refuses to list activations that have no legal target.
const bestGY = s => Math.max(0, ...[...s.myGY, ...s.oppGY].filter(c => c.isMonster).map(c => c.atk ?? 0));
const RULES = [
  [/^(Pot of Greed|Graceful Charity|Card Destruction|Reinforcement of the Army|Foolish Burial|Magical Stone Excavation|Hysteric Party|Ultimate Offering)$/, () => 94],
  [/^Dark Hole$/, s => (s.foes.length >= 2 && s.foes.length > s.mine.length) || (s.foes.length >= 1 && !s.mine.length) ? 88 : -1],
  [/^Raigeki$/, s => s.foes.length ? 90 : -1],
  [/^Heavy Storm$/, s => s.oppST >= 2 && s.oppST > s.myST ? 86 : -1],
  [/^Harpie's Feather Duster$/, s => s.oppST >= 1 ? 90 : -1],
  [/^Lightning Vortex$/, s => s.foes.length > s.mine.length && s.hand.length >= 2 ? 80 : -1],
  [/^(Mystical Space Typhoon|Dust Tornado)$/, s => s.oppST >= 1 ? 72 : -1],
  [/^(Fissure|Smashing Ground)$/, s => s.foes.length ? 80 : -1],
  [/^(Change of Heart|Brain Control|Enemy Controller|Snatch Steal|Soul Exchange)$/, s => s.foes.length ? 87 : -1],
  [/^(Monster Reborn|Premature Burial|Call of the Haunted|Call of the Grave)$/, s => bestGY(s) >= 1500 ? 86 : -1],
  [/^Swords of Revealing Light$/, s => s.foes.length ? 78 : -1],
  [/^(Polymerization|Fusion Gate|Miracle Fusion|Super Polymerization)$/, () => 88],
  [/^Cost Down$/, s => s.hand.some(c => c.isMonster && (c.level || 0) >= 5) ? 60 : -1],
  [/^Megamorph$/, s => s.mine.length ? 66 : -1],
  [/^Scapegoat$/, s => s.foes.length ? 55 : -1],
  [/^Crush Card Virus$/, s => s.foes.some(c => (c.atk || 0) >= 1500) && s.mine.some(c => c.faceUp && (c.atk || 0) <= 1000) ? 76 : -1],
  [/^Burst Stream of Destruction$/, s => s.foes.length && s.mine.some(c => /Blue-Eyes White Dragon/.test(c.name || '')) ? 86 : -1],
  [/^(Final Countdown|Self-Destruct Button|Ring of Destruction)$/, () => -1],   // too risky to fire on purpose
];
const ruleFor = name => RULES.find(([re]) => re.test(name));

/** What is this card FOR? Used to pick sensible targets and costs in the prompts that follow its activation. */
function kindOf(c) {
  const t = c.type || '', d = c.desc || '', n = c.name || '';
  if (/Equip/.test(t)) return 'equip';
  if (/Fusion Summon/i.test(d) || /Polymerization|Fusion Gate|Miracle Fusion/.test(n)) return 'fusion';
  if (/Special Summon[^.]*(Graveyard|from your GY)/i.test(d) && !/^Target 1 (card|monster) your opponent/i.test(d)) return 'revive';
  if (/destroy|banish|return[^.]*to the (hand|Deck)|take control|negate/i.test(d)) return 'removal';
  if (/add [^.]*to your hand/i.test(d)) return 'search';
  if (/discard/i.test(d)) return 'cost';
  return 'other';
}

// ------------------------------------------------------------------------------------------------ the bot
export class Bot {
  constructor(match, seat, { mode = 'classic', persona = 'default', delay } = {}) {
    this.p = { ...PERSONAS.default, ...(PERSONAS[persona] || {}) };
    Object.assign(this, { match, seat, mode, delay: delay || this.p.delay, stopped: false, turn: -1, tried: new Set(), noProgress: 0, lastSig: '', intent: null, spoke: {}, lastSpeech: -9, started: false, hurtSaid: false, pressSaid: false });
  }
  stop() { this.stopped = true; }

  async run() {
    while (!this.stopped && !this.match.over) {
      try {
        const res = await this.match.state(this.seat), v = res.view;
        const a = v.gameOver ? null : this.decide(v);
        if (a) {
          const sig = a.type + JSON.stringify(a.payload || {}) + (v.prompt ? v.prompt.type : v.phase);
          this.noProgress = sig === this.lastSig ? this.noProgress + 1 : 0; this.lastSig = sig;
          const r = this.noProgress > 4 ? await this.escape(v) : await this.match.act(this.seat, a.type, a.payload || {});
          if (r && r.ok === false) this.noProgress++;
          await sleep(this.delay[0] + rnd() * (this.delay[1] - this.delay[0]));
        } else await sleep(this.delay[0] > 100 ? 300 : 5);
      } catch (e) { console.error('[bot]', e.message); await sleep(1000); }
    }
  }

  /** Last resort when the same answer keeps being refused: back out of the prompt, or end the turn. */
  async escape(v) {
    const m = this.match, p = v.prompt;
    if (p) {
      if (p.type === 'choice' || p.type === 'fieldChoice') { const r = await m.act(this.seat, 'cancelChoice', {}); return r.ok ? r : m.act(this.seat, 'choice', { uids: [] }); }
      if (p.type === 'option') return m.act(this.seat, 'option', { id: p.options[p.options.length - 1].id });
      return m.act(this.seat, 'passResponse', {});
    }
    this.tried.clear(); return m.act(this.seat, v.phase === 'battle' ? 'endTurn' : 'endTurn', {});
  }

  say(kind) {   // anime-style lines go into the shared duel log
    const L = this.p.lines[kind]; if (!L || typeof this.match._log !== 'function') return;
    if (this.spoke[kind] != null && this.turn - this.spoke[kind] < 4) return; if (this.turn - this.lastSpeech < 2 && kind !== 'start') return;
    this.spoke[kind] = this.turn; this.lastSpeech = this.turn;
    this.match._log(`${this.match.pl[this.seat].name.replace(/ \(CPU\)$/, '')}: “${L[Math.floor(rnd() * L.length)]}”`);
  }

  // ------------------------------------------------------------------------------------------- reading the board
  snap(v) {
    const live = a => (a || []).filter(Boolean);
    const mine = [...v.you.monsters.map((c, i) => c && { ...c, zone: i }), ...live(v.emz).filter(c => c.side === 'you').map(c => ({ ...c, zone: -1 }))].filter(Boolean);
    const foes = [...live(v.opp.monsters), ...live(v.emz).filter(c => c.side === 'opp')];
    const s = { v, mine, foes, hand: live(v.you.hand), myST: live(v.you.spellTrap).length + (v.you.field ? 1 : 0), oppST: live(v.opp.spellTrap).length,
      oppSetST: live(v.opp.spellTrap).filter(c => !c.faceUp).length, myGY: v.you.graveyard || [], oppGY: v.opp.graveyard || [], lp: v.you.lp, oppLp: v.opp.lp };
    s.threat = Math.max(0, ...foes.map(c => (c.faceUp ? c.atk ?? 0 : 1500)));
    s.aggr = Math.min(1, this.p.aggr + (this.p.underdog && s.lp < s.oppLp - 2000 ? 0.25 : 0) + (s.oppLp <= 3000 ? 0.15 : 0) + (mine.length > foes.length + 1 ? 0.1 : 0));
    s.byUid = new Map(); for (const [side, list] of [['mine', [...live(v.you.monsters), ...live(v.you.spellTrap), v.you.field, ...live(v.emz).filter(c => c.side === 'you'), ...live(v.you.hand), ...live(v.you.extra), ...s.myGY]], ['opp', [...live(v.opp.monsters), ...live(v.opp.spellTrap), v.opp.field, ...live(v.emz).filter(c => c.side === 'opp'), ...s.oppGY]]]) for (const c of list) if (c && c.uid) s.byUid.set(c.uid, { c, side });
    return s;
  }
  isAce(c) { return this.p.aces.some(re => re.test(c.name || '')); }
  val(c) { return !c ? 0 : (this.isAce(c) ? 4000 : 0) + (c.isMonster ? (c.atk ?? c.baseAtk ?? 0) : 1200); }

  decide(v) {
    if (v.turn !== this.turn) { this.turn = v.turn; this.tried.clear(); }
    if (!this.started && v.turn >= 1) { this.started = true; this.say('start'); }
    if (v.you.lp <= 2500 && !this.hurtSaid) { this.hurtSaid = true; this.spoke.hurt = null; this.say('hurt'); }
    if (v.opp.lp <= 2500 && !this.pressSaid) { this.pressSaid = true; this.say('pressure'); }
    if (v.prompt) return this.answer(v, v.prompt);
    if (v.canAct) return v.phase === 'battle' ? this.battle(v) : this.main(v);
    return null;
  }

  // ------------------------------------------------------------------------------------------- prompts
  answer(v, p) {
    const s = this.snap(v);
    switch (p.type) {
      case 'option': return this.option(s, p);
      case 'chain': case 'summonResponse': case 'battleResponse': return this.respond(s, p);
      case 'place': { const mine = p.zones.filter(z => z.side === 'you'), foes = p.zones.filter(z => z.side === 'opp');
        const z = /disable/i.test(p.prompt || '') ? (foes[0] || mine[0]) : (mine[0] || foes[0]); return { type: 'place', payload: { side: z.side, kind: z.kind, seq: z.seq } }; }
      case 'search': return { type: 'announceCard', payload: { code: this.declare() } };
      case 'fieldChoice': return this.pickCards(s, p, p.uids.map(u => ({ uid: u, ...(s.byUid.get(u) || {}) })));
      case 'choice': return this.pickCards(s, p, p.cards.map(c => ({ uid: c.uid, c, side: (s.byUid.get(c.uid) || {}).side || 'mine', zone: c.zone })));
      default: return { type: 'passResponse', payload: {} };
    }
  }

  declare() { return randomCard(this.mode); }

  option(s, p) {
    const labels = p.options.map(o => o.label), find = l => p.options.find(o => o.label === l);
    if (find('Yes') && find('No')) {
      const mustPay = /pay|discard|tribute/i.test(p.prompt || '') && s.lp <= 1500;     // don't bleed out for a luxury effect
      return { type: 'option', payload: { id: (mustPay ? find('No') : find('Yes')).id } };
    }
    if (labels.includes('Face-up Attack') || labels.includes('Face-up Defense')) {      // special-summon position
      const nm = (/position for (.+)$/.exec(p.prompt || '') || [])[1], me = [...s.hand, ...s.mine, ...(s.v.you.extra || [])].find(c => c.name === nm);
      const weak = me && (me.def ?? 0) > (me.atk ?? 0) + 300 && s.threat > (me.atk ?? 0);
      const pick = (weak && find('Face-up Defense')) || find('Face-up Attack') || find('Face-up Defense') || p.options[0]; return { type: 'option', payload: { id: pick.id } };
    }
    if (/Declare a (Type|Attribute)/.test(p.prompt || '')) {   // name the strongest enemy's Type / Attribute
      const t = [...s.foes].filter(c => c.faceUp).sort((a, b) => (b.atk ?? 0) - (a.atk ?? 0))[0], want = t && (/Type/.test(p.prompt) ? t.race : t.attr), hit = p.options.find(o => o.label === want);
      return { type: 'option', payload: { id: (hit || p.options[0]).id } };
    }
    return { type: 'option', payload: { id: p.options[0].id } };
  }

  /** Chain / battle / summon responses: when to fire traps and quick effects. */
  respond(s, p) {
    const foeIds = new Set(s.foes.map(c => c.uid));
    let prob = this.p.trapChain, own = false;
    if (p.type === 'battleResponse') { own = !foeIds.has(p.attacker); prob = own ? 0.3 : Math.min(0.98, this.p.trapChain + 0.1); }
    else if (p.type === 'summonResponse') { own = !foeIds.has(p.summoned); prob = own ? 0.12 : this.p.trapChain * 0.8; }
    else { const top = (p.links || [])[p.links.length - 1]; own = !!top && top.side === 'you'; prob = own ? 0.1 : this.p.trapChain; }
    const scored = p.options.map(o => { const e = s.byUid.get(o.uid), c = e && e.c; let sc = 50;
      if (c) { const r = ruleFor(c.name || ''); if (r) sc = r[1](s); if (/Kuriboh/i.test(c.name || '') && p.type === 'battleResponse' && !own) sc = 99; } return { o, c, sc }; }).filter(x => x.sc > 0).sort((a, b) => b.sc - a.sc);
    if (scored.length && (p.forced || scored[0].sc >= 99 || rnd() < prob)) {
      const pick = scored[0]; if (pick.c) { this.intent = { kind: kindOf(pick.c), card: pick.c }; if (/Trap/.test(pick.c.type || '')) this.say('trap'); }
      return { type: 'engine', payload: { uid: pick.o.uid } };
    }
    if (p.forced && p.options.length) return { type: 'engine', payload: { uid: p.options[0].uid } };
    return { type: 'passResponse', payload: {} };
  }

  /** Card selection prompts: the intent of the card we just played decides what "best" means. */
  pickCards(s, p, cands) {
    const kind = (this.intent && this.intent.kind) || 'other';
    const summoning = /Summon:/i.test(p.prompt || '');
    const threat = c => c.isMonster ? (c.faceUp === false ? 1500 : (c.atk ?? 0) + (this.isAce(c) ? 300 : 0)) : 1500 + (c.faceUp ? 400 : 0);
    const score = x => {
      const c = x.c || {}, mineSide = x.side !== 'opp';
      if (summoning || kind === 'cost') return mineSide ? -this.val(c) : -1e6;                         // pay with the cheapest cards
      if (kind === 'revive') return (c.isMonster ? this.val(c) : -500) + (mineSide ? 40 : 0);
      if (kind === 'equip') return mineSide ? this.val(c) : -1e6;
      if (kind === 'removal') return mineSide ? -this.val(c) - 5000 : threat(c);
      if (kind === 'search' || x.zone === 'deck') return this.searchValue(c);
      if (!mineSide) return threat(c);                                                                   // unknown intent: hit their best
      return -this.val(c);                                                                               // ...or give up our worst
    };
    const ranked = cands.slice().sort((a, b) => score(b) - score(a));
    if (p.min === 0 && p.optional && !['search', 'revive', 'removal', 'equip', 'fusion'].includes(kind) && !summoning) return { type: 'cancelChoice', payload: {} };
    const n = Math.max(1, p.min);
    return { type: 'choice', payload: { uids: ranked.slice(0, Math.min(n, p.max || n)).map(x => x.uid) } };
  }
  searchValue(c) {
    const n = c.name || '', hit = this.p.prio.find(([re]) => re.test(n));
    return (this.isAce(c) ? 3000 : 0) + (hit ? hit[1] * 20 : 0) + (c.isMonster ? (c.atk ?? 0) / 4 : 300);
  }

  // ------------------------------------------------------------------------------------------- main phase
  fxScore(c, e, s) {
    const n = c.name || '', t = c.type || '';
    const rule = ruleFor(n); if (rule) { const r = rule[1](s); if (r < 0) return -1; var base = r; }
    const pr = this.p.prio.find(([re]) => re.test(n)); if (pr) { if (pr[1] <= 0) return -1; base = Math.max(base || 0, pr[1]); }
    if (base != null) return base;
    if (e.cmd === 'spsummon') return 72 + (this.p.fusionFirst ? 8 : 0) + (this.isAce(c) ? 6 : 0);
    if (/Equip/.test(t)) return s.mine.length ? 66 : -1;
    if (/Field/.test(t)) return 60;
    if (/Continuous/.test(t)) return 56;
    if (/Quick-Play/.test(t)) return s.foes.length ? 44 : 30;
    return c.isMonster ? 46 : 52;
  }

  main(v) {
    const s = this.snap(v), p = this.p; this.intent = null;
    const cands = [], add = (score, key, act) => { if (score > 0 && !this.tried.has(key)) cands.push({ score: score + rnd() * 0.5, key, act }); };
    const m1 = v.phase !== 'm2', canBattle = v.phaseButtons.some(b => b.id === 'battle');

    // 1. effects: spells, monster effects, special summons (Fusion/Synchro from the Extra Deck)
    const onField = [...(v.you.spellTrap || []), v.you.field].filter(Boolean);
    for (const c of [...s.hand, ...onField, ...s.mine, ...(v.you.extra || [])]) for (const e of (c.act && c.act.eng) || [])
      add(this.fxScore(c, e, s), c.uid + ':' + e.cmd + e.idx, { type: 'engine', payload: { uid: c.uid, cmd: e.cmd, idx: e.idx }, card: c });

    // 2. normal summon / set (tribute only when it is worth it) and flip summons
    const fodder = s.mine.filter(m => m.zone >= 0).sort((a, b) => this.val(a) - this.val(b));
    for (const c of s.hand) {
      if (!c.act || !(c.act.summon || c.act.set)) continue;
      const need = (c.act.summon || c.act.set).tributes || 0; if (fodder.length < need) continue;
      const tr = fodder.slice(0, need), cost = tr.reduce((x, m) => x + this.val(m), 0), power = (c.atk ?? 0) + (this.isAce(c) ? 400 : 0);
      if (need && power - cost < p.tributeGain) continue;
      const flip = /^FLIP:/i.test(c.desc || ''), strong = (c.atk ?? 0) >= s.threat || !s.foes.length;
      const aggressive = s.aggr > 0.7 && (c.atk ?? 0) >= 1500 && (c.atk ?? 0) >= s.threat - 300;
      const faceUp = !!c.act.summon && !flip && (strong || aggressive || !c.act.set);
      add(60 + power / 100 - need * 2 - (faceUp ? 0 : 8) + (this.isAce(c) ? 6 : 0), c.uid + ':sum', { type: faceUp ? 'summon' : 'set', payload: { uid: c.uid, tributes: tr.map(m => m.zone) }, card: c, ace: faceUp && this.isAce(c) });
    }
    for (const c of s.mine) if (c.act && c.act.summon && c.faceUp === false)                       // flip summon
      add(/^FLIP:/i.test(c.desc || '') ? 74 : (c.atk ?? 0) > s.threat ? 52 : 0, c.uid + ':flip', { type: 'summon', payload: { uid: c.uid, tributes: [] }, card: c });

    // 3. set Spells/Traps (holding them back until Main 2 when the persona hides information)
    const hold = p.holdSets && m1 && canBattle && v.turn > 1;
    if (!hold) for (const c of s.hand) if (c.act && c.act.setSpellTrap) add(/Trap/.test(c.type || '') ? 38 : 28, c.uid + ':sst', { type: 'setSpellTrap', payload: { uid: c.uid }, card: c });

    // 4. positions: defenders become defenders after battle, a strong monster in defense stands up before it
    for (const c of s.mine) if (c.act && c.act.position && c.faceUp !== false) {
      const atk = c.atk ?? 0, def = c.def ?? 0;
      if (!m1 || !canBattle) { if (c.pos === 'attack' && s.threat > atk && def >= atk - 200 && p.defend > 0.3) add(34 * p.defend + 14, c.uid + ':pos', { type: 'position', payload: { uid: c.uid } }); }
      else if (c.pos === 'defense' && atk > s.threat && s.aggr > 0.5) add(33, c.uid + ':pos', { type: 'position', payload: { uid: c.uid } });
    }

    cands.sort((a, b) => b.score - a.score);
    const best = cands[0];
    if (best) {
      this.tried.add(best.key); const a = best.act;
      if (a.type === 'engine') this.intent = { kind: kindOf(a.card), card: a.card };
      if (a.ace) this.say('ace'); else if (this.intent && this.intent.kind === 'fusion') this.say('ace');
      return { type: a.type, payload: a.payload };
    }
    if (m1 && canBattle) return { type: 'gotoPhase', payload: { phase: 'battle' } };
    return { type: 'endTurn', payload: {} };
  }

  // ------------------------------------------------------------------------------------------- battle phase
  battle(v) {
    const s = this.snap(v), p = this.p; this.intent = null;
    const byFoe = new Map(s.foes.map(c => [c.uid, c]));
    const attackers = s.mine.filter(a => a.act && a.act.attack && !this.tried.has(a.uid + ':atk')).sort((a, b) => this.val(b) - this.val(a));
    const directSum = attackers.filter(a => a.act.attack.direct || !a.act.attack.targets.length).reduce((x, a) => x + (a.atk ?? 0), 0);
    const lethal = directSum >= s.oppLp;
    for (const a of attackers) {
      this.tried.add(a.uid + ':atk');
      const at = a.act.attack, mine = a.atk ?? 0;
      if (at.direct || !at.targets.length) {
        const risky = this.isAce(a) && s.oppSetST >= 2 && p.caution > 0.6 && !lethal && rnd() < p.caution * 0.6;   // careful players don't throw their ace into 2+ set cards
        if (risky) continue;
        if (this.isAce(a) && mine >= 2000) this.say('attack');
        return { type: 'attack', payload: { uid: a.uid, target: null } };
      }
      const trapFear = s.oppSetST * p.caution * 150;
      const options = at.targets.map(u => byFoe.get(u)).filter(Boolean).map(t => {
        if (t.faceUp === false) return { t, sc: mine >= p.gambleAtk && s.aggr > 0.5 ? 1 : -1 };                  // a gamble: only big monsters take it
        if (t.pos === 'defense') return { t, sc: mine > (t.def ?? 0) ? 3 + (this.isAce(t) ? 2 : 0) : -1 };      // free kill, no damage
        const need = mine - (t.atk ?? 0);
        const ok = need > trapFear || (need === 0 && s.aggr > 0.6 && trapFear === 0) || (p.gamble && s.lp < s.oppLp && need >= -700 && rnd() < p.gamble);
        return { t, sc: ok ? 5 + (t.atk ?? 0) / 1000 + (this.isAce(t) ? 2 : 0) : -1 };
      }).filter(x => x.sc > 0).sort((x, y) => y.sc - x.sc);
      if (options.length) { if (this.isAce(a) && mine >= 2000) this.say('attack'); return { type: 'attack', payload: { uid: a.uid, target: options[0].t.uid } }; }
    }
    if (v.phaseButtons.some(b => b.id === 'm2')) return { type: 'gotoPhase', payload: { phase: 'm2' } };
    return { type: 'endTurn', payload: {} };
  }
}
