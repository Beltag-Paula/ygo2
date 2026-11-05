/* =====================================================================
   duel.js — the duel client.
   The server (DuelSession) sends a full JSON view of the board plus an
   ordered list of events. We (1) play the events as cinematics against
   the CURRENT board, then (2) render the new view, which makes every
   persistent card element glide to its new zone. All rules/legality
   live on the server; this file only draws and asks.
   ===================================================================== */
(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // ------------------------------------------------------------------ geometry
  const CW = 104, CH = 152, GAP = 26, X0 = 523;
  const ROW = { oppST: 70, oppMon: 236, youMon: 422, youST: 588 };
  const COLL = 393, COLR = 1173;
  let MODERN = false, FS = 1; // Modern rules: five rows with the two Extra Monster Zones in the middle; field cards drawn a little smaller
  const P2 = 102, MCY = { oppST: 134, oppMon: 268, emz: 402, youMon: 536, youST: 670 };
  const emzPos = i => ({ x: 835 + (i ? 1 : -1) * P2 - CW / 2, y: MCY.emz - CH / 2 });
  const FRAME_COLOR = { normal: '#c8a53c', effect: '#b9622e', spell: '#1d9e8a', trap: '#b03b83', fusion: '#7b4fa3', ritual: '#3f6fb5', synchro: '#d8d8d8', xyz: '#222', link: '#1b5ea6' };

  function zonePos(side, kind, i) {
    const col = side === 'you' ? i : 4 - i;
    if (MODERN) { const r = side === 'you' ? (kind === 'mon' ? 'youMon' : 'youST') : (kind === 'mon' ? 'oppMon' : 'oppST'); return { x: 835 + (col - 2) * P2 - CW / 2, y: MCY[r] - CH / 2 }; }
    const x = X0 + col * (CW + GAP);
    const y = side === 'you' ? (kind === 'mon' ? ROW.youMon : ROW.youST) : (kind === 'mon' ? ROW.oppMon : ROW.oppST);
    return { x, y };
  }
  function pilePos(side, k) {
    if (MODERN) { const L = 835 - 3 * P2, R = 835 + 3 * P2; const m = side === 'you' ? { gy: [R, 'youMon'], deck: [R, 'youST'], extra: [L, 'youST'], field: [L, 'youMon'] } : { gy: [L, 'oppMon'], deck: [L, 'oppST'], extra: [R, 'oppST'], field: [R, 'oppMon'] }; const q = m[k] || m.gy; return { x: q[0] - CW / 2, y: MCY[q[1]] - CH / 2 }; }
    const m = side === 'you'
      ? { gy: [COLR, ROW.youMon], deck: [COLR, ROW.youST], extra: [COLL, ROW.youST], field: [COLL, ROW.youMon] }
      : { gy: [COLL, ROW.oppMon], deck: [COLL, ROW.oppST], extra: [COLR, ROW.oppST], field: [COLR, ROW.oppMon] };
    const p = m[k] || m.gy; return { x: p[0], y: p[1] };
  }
  function handPos(side, i, n) {
    const mid = (n - 1) / 2;
    if (side === 'you') {
      const sp = Math.min(112, 690 / Math.max(n, 1)), dy = Math.pow(Math.abs(i - mid), 2) * 2.4;
      return { x: 835 - CW / 2 + (i - mid) * sp, y: 772 + dy, r: (i - mid) * 2.6, s: 1.12 };
    }
    const sp = Math.min(64, 480 / Math.max(n, 1)), dy = Math.pow(Math.abs(i - mid), 2) * 1.2;
    return { x: 835 - CW / 2 - (i - mid) * sp, y: -80 - dy, r: 180 + (i - mid) * 2, s: .7 };
  }

  // ------------------------------------------------------------------ state
  const S = {
    view: null, els: new Map(), stats: new Map(), pos: new Map(), data: new Map(),
    ui: { sel: null, mode: null }, locked: false, introShown: false, moveTo: new Map(),
    lp: { you: 8000, opp: 8000 }, lpMax: { you: 8000, opp: 8000 }, shownLog: 0, scale: 1
  };

  // ------------------------------------------------------------------ network
  async function post(type, payload) {
    const r = await fetch('/api/duel/act', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type, ...(payload || {}) }) });
    if (r.status === 404) { location.href = '/duel'; throw new Error('no duel'); }
    return r.json();
  }

  async function send(type, payload) {
    if (S.locked) return;
    S.locked = true; clearUI(); hideHint(); await hidePromptBox();
    try { await handle(await post(type, payload)); await pump(); }
    catch (e) { console.error(e); toast('Connection problem: ' + e.message, true); }
    S.locked = false; refreshUI();
  }

  async function pump() {
    let guard = 0;
    while (S.view && S.view.botBusy && !S.view.gameOver && guard++ < 1e9) {
      await wait(520);
      await handle(await post('step'));
    }
  }

  async function handle(res) {
    if (!res || !res.view) { if (res && res.error) toast(res.error, true); return; }
    if (!res.ok && res.message) { toast(res.message, true); SFX.play('deny'); }
    const ev = res.events || [];
    const tributeBatch = ev.some(e => e.type === 'field' && /summon|set-monster|ritual/.test(e.kind));
    for (const e of ev) if (e.type === 'move') S.moveTo.set(e.id, e.to);
    await playPre(ev, res.view, tributeBatch);
    render(res.view);
    await wait(ev.length ? 380 : 0);
    await playPost(ev);
  }

  // ------------------------------------------------------------------ stage scaling
  function fit() {
    const s = Math.min(innerWidth / 1600, innerHeight / 900); S.scale = s;
    $('stage').style.transform = 'scale(' + s + ')'; $('stage').style.setProperty('--fit', s);
  }
  addEventListener('resize', fit); fit();

  function stagePoint(el) {
    const r = el.getBoundingClientRect(), sr = $('stage').getBoundingClientRect();
    return { x: (r.left - sr.left) / S.scale, y: (r.top - sr.top) / S.scale, w: r.width / S.scale, h: r.height / S.scale };
  }

  // ------------------------------------------------------------------ static field decoration
  function buildSlots() {
    const host = $('slots'); host.innerHTML = '';
    for (const side of ['you', 'opp']) {
      for (let i = 0; i < 5; i++) {
        for (const kind of ['mon', 'st']) {
          const p = zonePos(side, kind, i), d = document.createElement('div');
          d.className = 'slot ' + kind + (kind === 'st' && (i === 0 || i === 4) ? ' pz ' + (i === 0 ? 'pzl' : 'pzr') : ''); d.style.left = p.x + 'px'; d.style.top = p.y + 'px'; d.dataset.side = side; d.dataset.kind = kind; d.dataset.i = i;
          if (MODERN) d.style.transform = `scale(${FS})`; d.onclick = () => onSlotClick(side, kind, i); host.appendChild(d);
        }
      }
      for (const [k, label] of [['deck', 'DECK'], ['extra', 'EXTRA'], ['gy', 'GRAVE'], ['field', 'FIELD']]) {
        const p = pilePos(side, k), d = document.createElement('div');
        d.className = 'slot pile'; d.style.left = p.x + 'px'; d.style.top = p.y + 'px'; d.id = `pile-${side}-${k}`; if (MODERN) d.style.transform = `scale(${FS})`;
        if (k === 'deck' || k === 'extra') d.innerHTML = '<div class="stk"><i></i><i></i><i></i></div>';
        host.appendChild(d);
        const l = document.createElement('div'); l.className = 'pile-label'; l.style.left = p.x + 'px'; l.style.top = (p.y + (MODERN ? CH / 2 - 10 * FS : 66)) + 'px'; l.textContent = label; host.appendChild(l);
        if (k !== 'field') {
          const c = document.createElement('div'); c.className = 'pile-count'; c.id = `cnt-${side}-${k}`; c.style.left = (p.x + (MODERN ? CW / 2 + 20 * FS : 72)) + 'px'; c.style.top = (p.y + (MODERN ? CH / 2 + 52 * FS : 128)) + 'px'; c.textContent = '0'; host.appendChild(c);
          const h = document.createElement('div'); h.className = 'pile-hit'; h.style.left = p.x + 'px'; h.style.top = p.y + 'px'; if (MODERN) h.style.transform = `scale(${FS})`;
          h.onclick = () => openPile(side, k); host.appendChild(h);
        }
      }
      const p = pilePos(side, 'gy'),
        b = document.createElement('div');
      // banish pill sits OUTBOARD of the graveyard pile (right of yours, left of theirs) so it never covers the deck pile
      b.className = 'pile-count'; b.id = `cnt-${side}-ban`; b.style.cssText += `left:${side === 'you' ? p.x + CW + 10 : p.x - 104}px;top:${p.y}px;width:auto;background:rgba(70,20,40,.93);border-color:#ff8a9a;cursor:pointer;white-space:nowrap`; b.title = 'Banished Zone'; b.textContent = 'BANISH 0'; host.appendChild(b);
    }
    if (MODERN) for (let i = 0; i < 2; i++) {
      const p = emzPos(i), d = document.createElement('div');
      d.className = 'slot emz'; d.style.left = p.x + 'px'; d.style.top = p.y + 'px'; d.style.transform = `scale(${FS})`; host.appendChild(d);
      d.onclick = () => onSlotClick('you', 'mon', 5 + i); // the two Extra Monster Zones (my seq 5 / 6)
      const l = document.createElement('div'); l.className = 'pile-label'; l.style.left = p.x + 'px'; l.style.top = (p.y + CH / 2 + 24 * FS) + 'px'; l.textContent = 'EXTRA MONSTER'; host.appendChild(l);
    }
  }

  // ------------------------------------------------------------------ cards
  function bigImg(url) { return url ? url.replace('cards_small', 'cards') : ''; }

  function makeCard(uid) {
    const el = document.createElement('div');
    el.className = 'card down snap'; el.dataset.uid = uid;
    el.innerHTML = '<div class="inner"><div class="face front"><img alt="" draggable="false"><div class="ph"></div></div><div class="face back"></div></div>';
    const img = el.querySelector('img');
    img.onerror = () => el.classList.add('noimg');
    img.onload = () => el.classList.remove('noimg');
    el.addEventListener('mouseenter', () => showInfo(uid));
    el.addEventListener('click', ev => { ev.stopPropagation(); onCardClick(uid); });
    $('cards').appendChild(el);
    return el;
  }

  const MARK = [[0x40, 'tl', '\u25E4'], [0x80, 't', '\u25B2'], [0x100, 'tr', '\u25E5'], [0x8, 'l', '\u25C0'], [0x20, 'r', '\u25B6'], [0x1, 'bl', '\u25E3'], [0x2, 'b', '\u25BC'], [0x4, 'br', '\u25E2']];
  const linkArrows = m => MARK.filter(a => m & a[0]).map(a => `<i class="lm ${a[1]}">${a[2]}</i>`).join('');
  const flipMarker = m => { const F = { 0x40: 0x4, 0x80: 0x2, 0x100: 0x1, 0x8: 0x20, 0x20: 0x8, 0x1: 0x100, 0x2: 0x80, 0x4: 0x40 }; let o = 0; for (const k of Object.keys(F)) if (m & k) o |= F[k]; return o; };
  function applyPos(el, t) {
    el.style.setProperty('--x', t.x + 'px'); el.style.setProperty('--y', t.y + 'px');
    el.style.setProperty('--r', (t.r || 0) + 'deg'); el.style.setProperty('--s', t.s == null ? 1 : t.s);
  }

  function render(view) {
    const prev = S.view; S.view = view; S.data.clear();
    const placements = [];
    for (const side of ['you', 'opp']) {
      const pv = view[side];
      pv.hand.forEach((c, i) => placements.push({ c, side, zone: 'hand', i, n: pv.hand.length }));
      pv.monsters.forEach((c, i) => c && placements.push({ c, side, zone: 'mon', i }));
      pv.spellTrap.forEach((c, i) => c && placements.push({ c, side, zone: 'st', i }));
      if (pv.field) placements.push({ c: pv.field, side, zone: 'field', i: 0 });
      if (side === 'you' && view.emz) view.emz.forEach((c, i) => c && placements.push({ c, side: c.side || 'you', zone: 'mon', i: 5 + i, emz: true }));
      pv.graveyard.slice(-2).forEach((c, k, a) => placements.push({ c, side, zone: 'gy', i: k, top: k === a.length - 1 }));
    }
    const seen = new Set(); let newHand = 0;
    for (const p of placements) {
      const uid = p.c.uid; seen.add(uid); S.data.set(uid, { ...p.c, side: p.side, zone: p.zone, idx: p.i });
      let el = S.els.get(uid), fresh = false;
      if (!el) {
        fresh = true; el = makeCard(uid); S.els.set(uid, el);
        const isExtraType = /Fusion|Synchro|XYZ|Link/i.test(p.c.type || '');
        const o = pilePos(p.side, (p.zone === 'mon' && isExtraType) ? 'extra' : 'deck');
        applyPos(el, { x: o.x, y: o.y, r: 0, s: 1 });
        el.classList.add('down'); void el.offsetWidth;
      }
      // target transform
      let t, down = false, def = false;
      if (p.zone === 'hand') { t = handPos(p.side, p.i, p.n); down = p.side === 'opp'; }
      else if (p.zone === 'mon') { const z = p.emz ? emzPos(p.i - 5) : zonePos(p.side, 'mon', p.i); def = p.c.pos === 'defense'; t = { x: z.x, y: z.y, r: def ? 90 : 0, s: (def ? .86 : 1) * FS }; down = !p.c.faceUp; }
      else if (p.zone === 'st') { const z = zonePos(p.side, 'st', p.i); t = { x: z.x, y: z.y, r: 0, s: FS }; down = !p.c.faceUp; }
      else if (p.zone === 'field') { const z = pilePos(p.side, 'field'); t = { x: z.x, y: z.y, r: 0, s: FS }; down = !p.c.faceUp; }
      else { const z = pilePos(p.side, 'gy'); t = { x: z.x, y: z.y, r: 0, s: FS }; }
      if (p.side === 'opp' && p.zone === 'hand') t.r = 180 + (p.i - (p.n - 1) / 2) * -2;
      S.pos.set(uid, { ...t, def });
      el.classList.toggle('down', down); el.classList.toggle('def', def);
      el.classList.toggle('hand', p.zone === 'hand'); el.classList.toggle('opp-card', p.side === 'opp');
      el.classList.toggle('can-act', p.side === 'you' && !!p.c.act && Object.keys(p.c.act).length > 0 && view.canAct && !view.prompt);
      el.classList.toggle('is-mon', p.zone === 'mon'); el.classList.toggle('in-gy', p.zone === 'gy');
      el.style.zIndex = p.zone === 'hand' ? 100 + p.i : p.zone === 'gy' ? 10 + p.i : 20;
      if (fresh && p.zone === 'hand') { el.style.transitionDelay = (newHand++ * 90) + 'ms'; setTimeout(() => { el.style.transitionDelay = ''; }, 1200); }
      if (p.c.image) { const img = el.querySelector('img'); if (img.dataset.src !== p.c.image) { img.dataset.src = p.c.image; img.src = p.c.image; el.classList.remove('noimg'); }
        const ph = el.querySelector('.ph'); ph.textContent = p.c.name || ''; ph.style.setProperty('--fc', FRAME_COLOR[p.c.frame] || '#888'); }
      if (p.c.marker) { // Link arrows; the opponent's are turned around because their cards face the other way
        const m = p.side === 'opp' ? flipMarker(p.c.marker) : p.c.marker; let lk = el.querySelector('.lmk');
        if (!lk) { lk = document.createElement('div'); lk.className = 'lmk'; el.querySelector('.front').appendChild(lk); }
        if (lk.dataset.m !== String(m)) { lk.dataset.m = String(m); lk.innerHTML = linkArrows(m); }
      }
      const old = el.querySelector('.counter'); if (p.c.counter && !old) { const c = document.createElement('div'); c.className = 'counter'; el.querySelector('.front').appendChild(c); } else if (!p.c.counter && old) old.remove();
      el.classList.remove('snap');
      applyPos(el, t);
    }
    // cards that left the visible board (to deck / banished / extra deck / gone)
    for (const [uid, el] of [...S.els]) {
      if (seen.has(uid)) continue;
      S.els.delete(uid); S.pos.delete(uid);
      const to = S.moveTo.get(uid), sd = (el.dataset.side) || 'you';
      const side = S.lastSide && S.lastSide.get(uid) || sd;
      const tgt = to === 'deck' ? pilePos(side, 'deck') : to === 'extraDeck' ? pilePos(side, 'extra') : pilePos(side, 'gy');
      el.style.opacity = '0'; applyPos(el, { x: tgt.x, y: tgt.y, r: 0, s: .9 }); setTimeout(() => el.remove(), 650);
    }
    S.lastSide = new Map([...S.data].map(([u, d]) => [u, d.side]));
    for (const [u, el] of S.els) el.dataset.side = (S.data.get(u) || {}).side || 'you';
    for (const el of S.els.values()) delete el.dataset.chain;
    (view.chain || []).forEach(l => { const el = S.els.get(l.uid); if (el) el.dataset.chain = l.n; });
    renderStats(view); renderHUD(view, prev); renderPiles(view); applyHighlights(); refreshUI();
  }

  function renderStats(view) {
    const keep = new Set();
    for (const [uid, d] of S.data) {
      if (d.zone !== 'mon' || !d.faceUp || d.atk == null) continue;
      keep.add(uid);
      let el = S.stats.get(uid);
      if (!el) { el = document.createElement('div'); el.className = 'stat'; $('stats').appendChild(el); S.stats.set(uid, el); }
      const p = S.pos.get(uid), cx = p.x + CW / 2, halfH = (p.def ? 45 : CH / 2) * FS, cy = p.y + CH / 2;
      el.style.setProperty('--x', p.x + 'px'); el.style.setProperty('--y', (cy - halfH - 44) + 'px');
      const cls = (v, b) => v > b ? 'up' : v < b ? 'down' : '';
      const lv = d.level && d.frame !== 'link' ? `<small class="lv${d.frame === 'xyz' ? ' xyz' : ''}">${d.frame === 'xyz' ? '\u2606' : '\u2605'} ${d.level}</small>` : '';
      el.innerHTML = `<b>${d.def == null ? `<span class="${cls(d.atk, d.baseAtk)}">${d.atk}</span>` : `<span class="${cls(d.atk, d.baseAtk)}">${d.atk}</span>/<span class="${cls(d.def, d.baseDef)}">${d.def}</span>`}</b>${lv}`;
    }
    for (const [uid, el] of [...S.stats]) if (!keep.has(uid)) { el.remove(); S.stats.delete(uid); }
  }

  function renderPiles(view) {
    for (const side of ['you', 'opp']) {
      const c = view[side].counts;
      for (const [k, n] of [['deck', c.deck], ['extra', c.extra], ['gy', c.gy]]) {
        const el = $(`cnt-${side}-${k}`); if (el.textContent !== String(n)) { el.textContent = n; el.classList.add('bump'); setTimeout(() => el.classList.remove('bump'), 300); }
        const pile = $(`pile-${side}-${k}`); if (k !== 'gy') pile.classList.toggle('empty', n === 0);
      }
      const b = $(`cnt-${side}-ban`); b.style.display = 'grid'; b.textContent = c.banished; b.classList.toggle('empty', !c.banished);
    }
  }

  // ------------------------------------------------------------------ HUD
  function setPlate(side, v) {
    $('nm' + (side === 'you' ? 'You' : 'Opp')).textContent = v.name; $('dk' + (side === 'you' ? 'You' : 'Opp')).textContent = v.deckName;
    const ava = $('ava' + (side === 'you' ? 'You' : 'Opp'));
    if (!ava.dataset.done) { ava.dataset.done = 1; ava.innerHTML = avatarHTML(v.avatar, v.frame, v.name); }
  }
  function lpWidth(side, v) { return Math.max(0, Math.min(100, v / S.lpMax[side] * 100)) + '%'; }
  function setLPDisplay(side, v) {
    const k = side === 'you' ? 'You' : 'Opp';
    $('lp' + k).textContent = Math.round(v); $('plate' + k).classList.toggle('low', v <= 2000);
  }
  function renderHUD(view, prev) {
    setPlate('you', view.you); setPlate('opp', view.opp);
    if (!prev) { for (const s of ['you', 'opp']) { S.lpMax[s] = Math.max(8000, view[s].lp); S.lp[s] = view[s].lp; $('fill' + (s === 'you' ? 'You' : 'Opp')).style.width = $('ghost' + (s === 'you' ? 'You' : 'Opp')).style.width = lpWidth(s, view[s].lp); } }
    for (const s of ['you', 'opp']) { if (S.lp[s] !== view[s].lp && !S.tweening) { S.lp[s] = view[s].lp; $('fill' + (s === 'you' ? 'You' : 'Opp')).style.width = lpWidth(s, view[s].lp); } setLPDisplay(s, S.lp[s]); }
    const mine = view.turnOf === 'you';
    const who = $('turnWho'); who.textContent = mine ? 'YOUR TURN' : "OPPONENT'S TURN"; who.className = 'who ' + (mine ? 'you' : 'opp');
    $('turnNo').textContent = 'TURN ' + view.turn;
    markPhase(view.phase, mine);
    // log
    const log = $('log'); log.innerHTML = view.log.map(l => `<div class="${/^(===|---)/.test(l) ? 'hd' : ''}">${esc(l.replace(/^[=\-\s]+|[=\-\s]+$/g, '') || l)}</div>`).join(''); log.scrollTop = log.scrollHeight;
    // buttons
    const pb = $('phaseBtns'); pb.innerHTML = '';
    (view.phaseButtons || []).forEach(b => {
      const btn = document.createElement('button'); btn.className = 'btn cmd' + (b.id === 'end' ? ' ghost' : ''); btn.textContent = b.label;
      btn.onclick = () => { SFX.play('click'); send(b.id === 'end' ? 'endTurn' : 'gotoPhase', { phase: b.id }); }; pb.appendChild(btn);
    });
    $('thinking').style.display = (view.botBusy && !view.gameOver) ? 'block' : 'none';
  }
  function markPhase(phase, mine) {
    document.querySelectorAll('#phases span').forEach(s => { const on = s.dataset.p === phase; s.classList.toggle('on', on); s.classList.toggle('foe', on && !mine); });
  }

  // ------------------------------------------------------------------ info panel
  function showInfo(uid) {
    const d = S.data.get(uid); const box = $('info');
    if (!d) return;
    if (!d.name) { box.innerHTML = '<div class="img back"></div><div class="nm">Set card</div><div class="meta">Face-down</div>'; return; }
    const stars = d.level && d.isMonster ? '★'.repeat(Math.min(d.level, 12)) : '';
    box.innerHTML = `<div class="img" style="background-image:url('${esc(bigImg(d.image))}')"></div>
      <div class="nm">${esc(d.name)}</div>
      <div class="meta">${esc([d.attr, d.race, d.type].filter(Boolean).join(' · '))} ${stars ? '· <span style="color:#ffd36a">' + stars + '</span>' : ''}</div>
      ${d.isMonster ? `<div class="stats"><span class="a">ATK ${d.atk != null ? d.atk : '?'}</span> &nbsp; <span class="d">${d.def == null && d.linkRating ? 'LINK-' + d.linkRating : 'DEF ' + (d.def != null ? d.def : '?')}</span></div>` : ''}
      <div class="txt">${esc(d.desc)}</div>
      ${d.fx && d.fx.length ? '<div class="tags">' + d.fx.map(f => `<span title="${esc(f.label)}">${esc(f.tag)}</span>`).join('') + '</div>' : ''}`;
  }

  // ------------------------------------------------------------------ interaction
  function clearUI() { S.ui = { sel: null, mode: null }; hideCmd(); hideHint(); applyHighlights(); }
  function hideCmd() { $('cmd').className = ''; $('cmd').innerHTML = ''; document.querySelectorAll('.card.sel').forEach(e => e.classList.remove('sel')); }
  function hint(t) { const h = $('hint'); h.textContent = t; h.classList.add('on'); }
  function hideHint() { $('hint').classList.remove('on'); }
  async function hidePromptBox() { const box = $('prompt'); box.className = ''; box.innerHTML = ''; shownPrompt = null; }
  function refreshUI() {
    const v = S.view; if (!v) return;
    if (v.gameOver) { showResult(v); return; }
    if (v.prompt && !S.locked && !S.ui.mode) showPrompt(v.prompt); else if (!v.prompt) { hidePrompt(); }
  }

  function applyHighlights() {
    const m = S.ui.mode;
    document.querySelectorAll('.card').forEach(el => el.classList.remove('hl-target', 'hl-attack', 'hl-tribute', 'picked', 'dim'));
    document.querySelectorAll('.slot.valid').forEach(e => e.classList.remove('valid'));
    if (S.ui.sel && S.els.get(S.ui.sel)) S.els.get(S.ui.sel).classList.add('sel');
    if (!m) return;
    if (m.type === 'zonepick') { for (const z of m.zones) { const el = zoneSlotEl(z); if (el) el.classList.add('valid'); } return; }
    const cls = m.type === 'attack' ? 'hl-attack' : m.type === 'tribute' ? 'hl-tribute' : 'hl-target';
    for (const [uid, el] of S.els) {
      if (m.candidates.has(uid)) el.classList.add(cls); else if (uid !== m.source) el.classList.add('dim');
      if (m.picked && m.picked.includes(uid)) el.classList.add('picked');
    }
  }

  function onCardClick(uid) {
    const v = S.view; if (!v || S.locked) return;
    const d = S.data.get(uid); if (!d) return;
    const m = S.ui.mode;
    if (m) {
      if (!m.candidates.has(uid)) { SFX.play('deny'); return; }
      SFX.play('click');
      if (m.type === 'tribute') {
        const i = m.picked.indexOf(uid); if (i >= 0) m.picked.splice(i, 1); else m.picked.push(uid);
        applyHighlights();
        if (m.picked.length >= m.need) {
          const idxs = m.picked.map(u => S.data.get(u).idx);
          const act = m.action, src = m.source; clearUI(); send(act, { uid: src, tributes: idxs });
        }
        return;
      }
      if (m.type === 'fieldpick') {
        const i = m.picked.indexOf(uid); if (i >= 0) m.picked.splice(i, 1); else if (m.picked.length < m.max) m.picked.push(uid);
        applyHighlights();
        if (m.picked.length === m.max && m.max === 1 && m.min === 1) finishFieldPick();
        return;
      }
      if (m.type === 'target') { const act = m.action, src = m.source; clearUI(); send(act, { uid: src, target: uid }); return; }
      if (m.type === 'attack') { const src = m.source; clearUI(); send('attack', { uid: src, target: uid }); return; }
      return;
    }
    if (d.side !== 'you' || !v.canAct) { showInfo(uid); return; }
    if (d.zone === 'gy') { openPile('you', 'gy'); return; }
    if (!d.act || Object.keys(d.act).length === 0) { SFX.play('deny'); showInfo(uid); return; }
    SFX.play('click');
    S.ui.sel = uid; applyHighlights(); openCmd(uid, d);
  }

  function openCmd(uid, d) {
    const a = d.act, items = [];
    const needTribute = n => n > 0 ? ` (${n} Tribute${n > 1 ? 's' : ''})` : '';
    if (a.summon) items.push([`${a.summon.tributes || a.summon.forced ? 'Tribute Summon' : 'Normal Summon'}${needTribute(a.summon.tributes)}`, () => startSummon(uid, 'summon', a.summon.tributes, a.summon)]);
    (a.summon && a.summon.alt || []).forEach(n => items.push([`Tribute Summon (${n} Tributes)`, () => startSummon(uid, 'summon', n, a.summon)]));
    if (a.handEffect) items.push(['Activate Effect', () => send('handEffect', { uid })]);
    if (a.set) items.push([`Set${needTribute(a.set.tributes)}`, () => startSummon(uid, 'set', a.set.tributes, a.set)]);
    if (a.spell) items.push(['Activate', () => startTargeted(uid, 'spell', a.spell.target)]);
    if (a.setSpellTrap) items.push(['Set', () => send('setSpellTrap', { uid })]);
    if (a.activate) items.push(['Activate', () => startTargeted(uid, 'activateSet', a.activate.target)]);
    if (a.attack) {
      if (a.attack.targets.length) items.push(['Attack', () => startAttack(uid, a.attack)]);
      if (a.attack.direct) items.push(['Direct Attack', () => send('attack', { uid, target: null })]);
    }
    if (a.gemini) items.push(['Gemini Summon', () => send('gemini', { uid })]);
    if (a.effect) items.push(['Activate Effect', () => startTargeted(uid, 'monsterEffect', a.effect.target)]);
    if (a.position) items.push([d.faceUp ? 'Change Position' : 'Flip Summon / Position', () => send('position', { uid })]);
    if (a.quick) items.push(['Activate Effect', () => send('quick', { uid })]);
    if (a.unequip) items.push(['Unequip Union', () => send('unequip', { uid })]);
    (a.eng || []).forEach(x => items.push([x.label, () => send('engine', { uid, cmd: x.cmd, idx: x.idx })]));
    items.push(['Cancel', clearUI, true]);
    const cmd = $('cmd'); cmd.innerHTML = '';
    items.forEach(([label, fn, cancel]) => { const b = document.createElement('button'); b.textContent = label; if (cancel) b.className = 'cancel'; b.onclick = ev => { ev.stopPropagation(); SFX.play('click'); hideCmd(); fn(); }; cmd.appendChild(b); });
    const el = S.els.get(uid), p = S.pos.get(uid);
    let x = p.x + CW * (d.zone === 'hand' ? 1.45 : 1.08) + 8, y = d.zone === 'hand' ? 600 : p.y;
    if (x > 1400) x = p.x - 205;
    cmd.style.left = Math.max(10, x) + 'px'; cmd.style.top = Math.max(60, Math.min(y, 640)) + 'px'; cmd.className = 'on';
  }

  function startSummon(uid, action, need, info) {
    if (info && info.forced) { const f = findCardAnywhere(info.forced); toast('Soul Exchange: ' + (f ? f.name : 'the targeted monster') + ' will be Tributed' + (need ? ' along with your choice' : '')); }
    if (!need) return send(action, { uid, tributes: [] });
    const cands = new Set(info && info.candidates ? info.candidates : (S.view.you.monsters || []).filter(Boolean).map(c => c.uid));
    S.ui = { sel: null, mode: { type: 'tribute', action, source: uid, need, picked: [], candidates: cands } };
    hint(`Select ${need} monster${need > 1 ? 's' : ''} to Tribute`); applyHighlights();
  }

  function startAttack(uid, atk) {
    if (!atk.targets.length) return send('attack', { uid, target: null });
    S.ui = { sel: null, mode: { type: 'attack', source: uid, candidates: new Set(atk.targets) } };
    hint('Select a monster to attack'); applyHighlights();
  }

  function startTargeted(uid, action, target) {
    if (!target) return send(action, { uid });
    const uids = target.uids;
    const onField = uids.every(u => { const d = S.data.get(u); return d && (d.zone === 'mon' || d.zone === 'st'); });
    if (uids.length === 1 && onField) { /* still let the player see what is targeted */ }
    if (onField) {
      S.ui = { sel: null, mode: { type: 'target', action, source: uid, candidates: new Set(uids) } };
      hint('Select a target'); applyHighlights(); return;
    }
    const cards = uids.map(findCardAnywhere).filter(Boolean);
    openPicker({ title: 'Select a target', sub: 'Choose one card', cards, min: 1, max: 1, optional: true,
      onOk: ids => send(action, { uid, target: ids[0] }), onCancel: () => {} });
  }

  function onSlotClick(side, kind, i) {
    if (S.ui.mode && S.ui.mode.type === 'zonepick') {
      const key = side + ':' + (kind === 'mon' ? 'monster' : 'spellTrap') + ':' + i;
      if (!S.ui.mode.candidates.has(key)) { SFX.play('deny'); return; }
      SFX.play('click'); finishZonePick({ side, kind: kind === 'mon' ? 'monster' : 'spellTrap', seq: i });
      return;
    }
    if (S.ui.mode) { /* slots are display-only */ } else if (!S.locked) { clearUI(); }
  }
  $('stage').addEventListener('click', e => { if (!e.target.closest('.card') && !e.target.closest('#cmd') && !e.target.closest('#picker') && !e.target.closest('#prompt') && !S.locked) { if (S.ui.mode || S.ui.sel) clearUI(); } });
  addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    const m = S.ui.mode;
    if (m && m.type === 'fieldpick' && m.optional) { clearUI(); shownPrompt = null; send('cancelChoice'); return; } // cancel the whole selection (e.g. the summon) on the server
    if (m && m.type === 'fieldpick') { toast("This selection can't be cancelled."); return; }
    if (m && m.type === 'zonepick') { toast("The materials are already used: a zone has to be chosen now."); return; }
    const had = !!m; clearUI(); closePicker(true); if (had) { shownPrompt = null; refreshUI(); }
  });

  function findCardAnywhere(uid) {
    const v = S.view;
    for (const side of ['you', 'opp']) {
      const pv = v[side];
      for (const list of [pv.hand, pv.monsters, pv.spellTrap, pv.graveyard, pv.banished, pv.extra || []]) {
        for (const c of list) if (c && c.uid === uid && c.name) return c;
      }
    }
    return null;
  }

  // ------------------------------------------------------------------ picker (choice windows, GY viewer)
  let pk = null;
  function openPicker(o) {
    pk = { ...o, picked: [] };
    $('pkTitle').textContent = o.title || '';
    $('pkSub').textContent = o.sub || '';
    const boxCls = 'box' + (o.compact ? ' compact' : '');
    const grid = $('pkGrid'); grid.innerHTML = '';
    (o.cards || []).forEach(c => {
      const d = document.createElement('div'); const legalForTurn = o.legal ? o.legal.has(c.uid) : true;
      d.className = 'pc' + (o.viewOnly ? ' view' : '') + (('legal' in o || o.legal) ? (legalForTurn ? ' legal' : ' grayed') : ' legal');
      d.innerHTML = `<img src="${esc(c.image || '')}" alt="" onerror="this.style.opacity=.3">${o.legal ? (legalForTurn ? '<i class="lgm">\u2726</i>' : '') : ''}<div class="nm">${esc(c.name)}</div>`;
      d.onmouseenter = () => { S.data.set(c.uid, { ...(S.data.get(c.uid) || {}), ...c }); showInfo(c.uid); };
      d.onclick = () => {
        if (o.viewOnly) return;
        if (!legalForTurn) { SFX.play('deny'); return; }
        SFX.play('click');
        const i = pk.picked.indexOf(c.uid);
        if (i >= 0) pk.picked.splice(i, 1);
        else { if (pk.max === 1) pk.picked = []; if (pk.picked.length < pk.max) pk.picked.push(c.uid); }
        grid.querySelectorAll('.pc').forEach((n, k) => n.classList.toggle('pick', pk.picked.includes(o.cards[k].uid)));
        updatePk();
      };
      grid.appendChild(d);
    });
    $('pkCancel').style.display = (o.optional || o.viewOnly) ? '' : 'none'; $('pkCancel').textContent = o.viewOnly ? 'Close' : 'Cancel';
    $('pkOk').style.display = o.viewOnly ? 'none' : '';
    updatePk(); const bx = document.querySelector('#picker .box'); bx.className = boxCls; $('picker').classList.add('on');
  }
  function updatePk() {
    if (!pk) return; const n = pk.picked.length;
    $('pkCnt').textContent = pk.viewOnly ? (pk.cards.length + ' cards') : `Selected ${n} / ${pk.min === pk.max ? pk.max : pk.min + '–' + pk.max}`;
    $('pkOk').disabled = n < pk.min || n > pk.max;
  }
  function closePicker(fromEsc) {
    if (!pk) return; if (fromEsc && !pk.optional && !pk.viewOnly) return;
    $('picker').classList.remove('on'); const c = pk; pk = null; if (c.onCancel) c.onCancel();
  }
  $('pkCancel').onclick = () => closePicker(false);
  $('pkOk').onclick = () => { if (!pk || $('pkOk').disabled) return; const ids = pk.picked.slice(), fn = pk.onOk; $('picker').classList.remove('on'); pk = null; fn(ids); };

  function openPile(side, k) {
    // browsing piles is a read-only action: allowed during the opponent's turn too.
    // only refuse while an interaction of OURS is in flight on our own turn.
    if (S.locked && S.view && S.view.turnOf === 'you' && S.view.canAct) return;
    const pv = S.view[side];
    let cards = k === 'gy' ? pv.graveyard : k === 'extra' ? (side === 'you' ? pv.extra : []) : [];
    if (k === 'gy') return openPicker({ title: (side === 'you' ? 'Your ' : "Opponent's ") + 'Graveyard', sub: cards.length ? 'Hover a card to read it.' : 'Empty.', cards: cards.slice().reverse(), viewOnly: true, compact: side === 'opp' });
    if (k === 'extra' && side === 'opp') { return openPicker({ title: "Opponent's Extra Deck", sub: 'Hidden — ' + ((pv.counts || {}).extra || 0) + ' cards', cards: [], viewOnly: true }); }
    if (k === 'deck') return;
    if (k === 'extra' && side === 'you' && S.view.canAct) {
      const legal = new Set((cards || []).filter(c => c.act && c.act.eng && c.act.eng.length).map(c => c.uid));
      const list = (cards || []).slice().reverse();
      if (!legal.size) return openPicker({ title: 'Extra Deck', sub: 'No card in there can be summoned right now.', cards: list, viewOnly: true });
      return openPicker({ title: 'Extra Deck', sub: 'Hover to read. Cards with a \u2726 marker can be summoned now.', cards: list, min: 1, max: 1, optional: true, legal,
        okEach: true, onOk: ids => { const c = list.find(x => x.uid === ids[0]); const a = c && c.act && c.act.eng && c.act.eng[0]; if (a) send('engine', { uid: c.uid, cmd: a.cmd, idx: a.idx }); }, onCancel: () => {} });
    }
    openPicker({ title: (side === 'you' ? 'Your ' : "Opponent's ") + (k === 'gy' ? 'Graveyard' : 'Extra Deck'), sub: cards.length ? 'Hover a card to read it.' : 'Empty.', cards: cards.slice().reverse(), viewOnly: true });
  }
  function wireBan() {
    $('cnt-you-ban').onclick = () => openBan('you'); $('cnt-opp-ban').onclick = () => openBan('opp');
    $('cnt-you-ban').style.pointerEvents = $('cnt-opp-ban').style.pointerEvents = 'auto';
  }
  function openBan(side) {
    const pv = S.view[side], ba = (pv.banished || []).slice().reverse();
    openPicker({ title: (side === 'you' ? 'Your ' : "Opponent's ") + 'Banished Zone', sub: ba.length ? ba.length + ' cards. Hover to read.' : 'Empty.', cards: ba, viewOnly: true, compact: true });
  }

  // ------------------------------------------------------------------ prompts
  let shownPrompt = null;
  function hidePrompt() { $('prompt').className = ''; shownPrompt = null; hideHint(); }
  function promptKey(p) { return JSON.stringify([p.type, p.links, p.options, p.lastName, p.attacker, p.summoned, p.prompt, p.count, (p.cards || []).map(c => c.uid), p.candidates && p.candidates.map(c => c.uid), p.uids]); }

  function showPrompt(p) {
    const key = promptKey(p); if (shownPrompt === key) return; shownPrompt = key;
    const box = $('prompt'); box.innerHTML = '';
    box.style.top = box.style.left = box.style.right = box.style.bottom = '';
    const row = html => { const d = document.createElement('div'); d.className = 'row'; d.innerHTML = html || ''; return d; };
    const mk = (label, fn, cls) => { const b = document.createElement('button'); b.className = 'btn small ' + (cls || ''); b.textContent = label; b.onclick = () => { SFX.play('click'); fn(); }; return b; };
    const name = uid => { const c = findCardAnywhere(uid) || S.data.get(uid); return c && c.name ? c.name : 'a card'; };

    if (p.type === 'option') {
      box.innerHTML = `<h3>${esc(p.prompt)}</h3>`;
      if (p.cards && p.cards.length) {
        const strip = document.createElement('div'); strip.className = 'strip';
        p.cards.forEach(c => { const d = document.createElement('div'); d.className = 'sc'; d.innerHTML = `<img src="${esc(c.image || '')}" alt="" onerror="this.style.opacity=.3"><span>${esc(c.name)}</span>`; d.onmouseenter = () => { S.data.set(c.uid, { ...(S.data.get(c.uid) || {}), ...c }); showInfo(c.uid); }; strip.appendChild(d); });
        box.appendChild(strip);
      }
      const isCoin = p.options.length === 2 && p.options.every(o => o.id === 'heads' || o.id === 'tails');
      const r = row();
      if (isCoin) {   // a coin call: the two faces are the Millennium Puzzle (heads) and Winged Kuriboh (tails)
        r.className += ' coin-row';
        p.options.forEach(o => { const b = document.createElement('button'); b.className = 'coin-btn'; b.innerHTML = `<img src="/images/coin/coin-${o.id}.png" alt=""><span>${esc(o.label)}</span>`; b.onclick = () => { shownPrompt = null; send('option', { id: o.id }); }; r.appendChild(b); });
      } else p.options.forEach(o => r.appendChild(mk(o.label, () => { shownPrompt = null; send('option', { id: o.id }); })));
      box.appendChild(r); box.className = 'on'; return;
    }
    if (p.type === 'place') { startZonePick(p); return; }
    if (p.type === 'fieldChoice') { startFieldPick(p); return; }
    if (p.type === 'search') {
      box.innerHTML = `<h3>${esc(p.prompt)}</h3>`; const inp = document.createElement('input'); inp.placeholder = 'Type a card name…';
      inp.style.cssText = 'width:100%;padding:9px;background:#07142c;border:1px solid #3a6fb0;color:#fff;font:inherit;margin-bottom:8px'; box.appendChild(inp);
      const r = row(); r.style.flexWrap = 'wrap'; box.appendChild(r); let t;
      inp.oninput = () => { clearTimeout(t); t = setTimeout(async () => { const j = await (await fetch('/api/cards/search?q=' + encodeURIComponent(inp.value))).json(); r.innerHTML = ''; j.cards.forEach(c => r.appendChild(mk(c.name, () => { shownPrompt = null; send('announceCard', { code: c.id }); }))); }, 200); };
      box.className = 'on'; setTimeout(() => inp.focus(), 50); return;
    }
    if (p.type === 'chain') {
      const links = p.links.map(l => `<div class="lk ${l.side}"><b>${l.n}</b> ${esc(l.name)}</div>`).join('');
      box.innerHTML = `<h3>Chain — respond?</h3><div class="chain">${links}</div><p>${esc(p.lastName)} is about to resolve. You may chain a Quick Effect.</p>`;
      const r = row();
      p.options.forEach(o => {
        const act = o.quick ? 'quick' : o.from === 'hand' ? 'spell' : o.from === 'monster' ? 'monsterEffect' : 'activateSet';
        r.appendChild(mk((o.quick ? 'Use ' : 'Activate ') + o.name, () => { hidePrompt(); startTargeted(o.uid, act, o.target); }));
      });
      if (!p.forced) r.appendChild(mk('Pass', () => { shownPrompt = null; send('passResponse'); }, 'ghost'));
      box.appendChild(r); box.className = 'on'; return;
    }
    if (p.type === 'choice') {
      box.className = '';
      openPicker({ title: p.prompt, sub: p.min === p.max ? `Choose ${p.max}` : `Choose ${p.min}–${p.max}`, cards: p.cards, min: p.min, max: p.max, optional: p.optional,
        onOk: ids => { shownPrompt = null; send('choice', { uids: ids }); }, onCancel: () => { if (p.optional) { shownPrompt = null; send('cancelChoice'); } } });
      return;
    }
    if (p.type === 'battleResponse' || p.type === 'summonResponse') {
      const att = p.type === 'battleResponse';
      box.innerHTML = `<h3>${att ? 'Opponent attacks!' : 'Opponent summoned a monster'}</h3><p>${att ? esc(name(p.attacker)) + (p.target ? ' attacks ' + esc(name(p.target)) : ' attacks you directly') : esc(name(p.summoned)) + ' was summoned.'} Activate a Set card?</p>`;
      const r = row();
      (p.options || []).forEach(o => r.appendChild(mk((o.quick ? 'Use ' : 'Activate ') + (name(o.uid) === 'a card' ? 'Set Card' : name(o.uid)), () => {
        const act = () => { box.className = ''; shownPrompt = null; };
        if (o.quick) { act(); send('quick', { uid: o.uid }); return; }
        if (o.target && o.target.uids.length) {
          const cards = o.target.uids.map(findCardAnywhere).filter(Boolean); box.className = '';
          if (cards.length) return openPicker({ title: 'Select a target', cards, min: 1, max: 1, optional: true, onOk: ids => { act(); send('activateSet', { uid: o.uid, target: ids[0] }); }, onCancel: () => { shownPrompt = null; showPrompt(S.view.prompt); } });
        }
        act(); send('activateSet', { uid: o.uid });
      })));
      (p.handOptions || []).forEach(u => r.appendChild(mk('Discard ' + name(u), () => { shownPrompt = null; send('handCard', { uid: u }); }, 'gold')));
      if (!p.forced) r.appendChild(mk('Pass', () => { shownPrompt = null; send('passResponse'); }, 'ghost'));
      box.appendChild(r); box.className = 'on'; return;
    }
    if (p.type === 'discard') {
      box.innerHTML = `<h3>Hand limit</h3><p>Discard ${p.count} card${p.count > 1 ? 's' : ''} from your hand.</p>`;
      const cards = S.view.you.hand.filter(c => c.name);
      box.className = '';
      openPicker({ title: 'Discard ' + p.count, sub: 'End Phase hand size limit', cards, min: p.count, max: p.count, onOk: ids => { shownPrompt = null; send('discard', { uids: ids }); } });
      return;
    }
    if (p.type === 'position') {
      const over = {}; box.innerHTML = '<h3>Choose positions</h3><p>Pick Attack or Defense for each Special Summoned monster.</p>';
      p.uids.forEach(u => {
        const r = row(`<span style="align-self:center;min-width:180px;text-align:right">${esc(name(u))}</span>`);
        const a = mk('ATK', () => { over[u] = 'attack'; a.className = 'btn small'; d.className = 'btn small ghost'; }, over[u] === 'attack' ? '' : 'ghost'), d = mk('DEF', () => { over[u] = 'defense'; d.className = 'btn small'; a.className = 'btn small ghost'; }, 'ghost');
        r.appendChild(a); r.appendChild(d); box.appendChild(r);
      });
      box.appendChild(mk('Confirm', () => { shownPrompt = null; send('positions', { overrides: over }); }, 'gold')); box.className = 'on'; return;
    }
    if (p.type === 'ritual') {
      const cards = p.candidates.map(c => ({ ...(findCardAnywhere(c.uid) || { uid: c.uid, name: 'Monster ' + c.level }), level: c.level }));
      let need = p.requiredLevel;
      box.className = '';
      const o = { title: 'Ritual Summon — choose Tributes', sub: `Total Level must be ${need}+`, cards, min: 1, max: cards.length, optional: true,
        onOk: ids => { shownPrompt = null; send('ritual', { uids: ids }); }, onCancel: () => { shownPrompt = null; send('cancelRitual'); } };
      openPicker(o);
      const orig = updatePk; // live level total
      const lvl = {}; p.candidates.forEach(c => lvl[c.uid] = c.level);
      const upd = () => { const t = pk ? pk.picked.reduce((s, u) => s + (lvl[u] || 0), 0) : 0; $('pkCnt').textContent = `Level ${t} / ${need}`; $('pkOk').disabled = t < need; };
      $('pkGrid').addEventListener('click', upd); upd(); return;
    }
  }

  // Master Rule 5 zone choice: Extra Deck summons (synchro/fusion/xyz/link) may use the
  // two purple Extra Monster Zones or a free Monster Zone; the player picks where to put it.
  function zoneKey(z) { return z.side + ':' + z.kind + ':' + z.seq; }
  function zoneSlotEl(z) {
    if (z.kind === 'monster' && z.seq >= 5) { const list = [...document.querySelectorAll('.slot.emz')]; if (!list.length) return null; const idx = z.side === 'you' ? z.seq - 5 : (z.seq === 5 ? 1 : 0); return list[idx] || null; }
    if (z.kind === 'spellTrap' && z.seq === 5) return document.getElementById('pile-' + z.side + '-field');
    return document.querySelector('.slot.' + (z.kind === 'monster' ? 'mon' : 'st') + '[data-side="' + z.side + '"][data-i="' + z.seq + '"]');
  }
  function startZonePick(p) {
    S.ui = { sel: null, mode: { type: 'zonepick', candidates: new Set(p.zones.map(zoneKey)), zones: p.zones } };
    hint(p.prompt); applyHighlights();
  }
  function finishZonePick(z) { if (!z) return; const m = S.ui.mode; if (!m || m.type !== 'zonepick' || !m.candidates.has(zoneKey(z))) return; clearUI(); hidePrompt(); send('place', { side: z.side, kind: z.kind, seq: z.seq }); }

  // Blind pick of cards on the field (Trap Master, Fissure ties ...): the cards stay face-down, we only highlight them.
  function startFieldPick(p) {    const cands = new Set(p.uids);
    S.ui = { sel: null, mode: { type: 'fieldpick', candidates: cands, picked: [], min: p.min, max: p.max, optional: p.optional } };
    hint(p.prompt); applyHighlights();
    const box = $('prompt'); box.innerHTML = ''; box.className = '';
    if (p.max > 1 || p.optional || p.min === 0) {
      const r = document.createElement('div'); r.className = 'row';
      const ok = document.createElement('button'); ok.className = 'btn small'; ok.textContent = 'Confirm';
      ok.onclick = () => finishFieldPick(); r.appendChild(ok);
      if (p.optional) { const c = document.createElement('button'); c.className = 'btn small ghost'; c.textContent = p.cancelLabel || 'Skip'; c.onclick = () => { clearUI(); shownPrompt = null; send('cancelChoice'); }; r.appendChild(c); }
      box.appendChild(r); box.classList.add('on'); box.style.top = '760px'; box.style.left = '520px'; box.style.right = '520px';
    }
  }
  function finishFieldPick() {
    const m = S.ui.mode; if (!m || m.type !== 'fieldpick' || m.picked.length < (m.min || 0)) return;
    const ids = m.picked.slice(); clearUI(); hidePrompt(); send('choice', { uids: ids });
  }

  // ------------------------------------------------------------------ cinematics
  const center = uid => { const p = S.pos.get(uid); return p ? { x: p.x + CW / 2, y: p.y + CH / 2 } : { x: 835, y: 450 }; };

  async function playPre(events, view, tributeBatch) {
    const destroyed = new Set(); let draws = 0, destroyWait = false;
    for (const e of events) {
      switch (e.type) {
        case 'duelStart':
          S.introShown = true;
          await FX.banner('DUEL START', { gold: false, sub: e.first === 'you' ? 'YOU GO FIRST' : 'OPPONENT GOES FIRST', ms: 1500 }); break;
        case 'turn':
          SFX.play('turn'); await FX.banner(e.side === 'you' ? 'YOUR TURN' : "OPPONENT'S TURN", { foe: e.side !== 'you', ms: 950, sub: 'TURN ' + e.turn }); break;
        case 'phase':
          markPhase(e.phase, e.side === 'you'); SFX.play('phase');
          if (e.phase === 'battle') await FX.banner('BATTLE PHASE', { small: true, foe: e.side !== 'you', ms: 650 });
          break;
        case 'field':
          if (e.kind === 'spell-activate' || e.kind === 'trap-activate') {
            SFX.play('activate'); await FX.cutin(e.image, e.name, e.kind === 'trap-activate' ? 'trap' : '');
          }
          break;
        case 'chain':
          if (e.action === 'add' && e.index > 1) { SFX.play('activate'); await FX.banner('CHAIN ' + e.index, { small: true, foe: e.ownerSide === 'opp', ms: 650, sub: e.name }); }
          else if (e.action === 'resolve' && e.index > 1) { SFX.play('phase'); }
          break;
        case 'attack': await animAttack(e); break;
        case 'lp': await animLP(e); break;
        case 'move':
          if (e.destroyed && !destroyed.has(e.id)) {
            destroyed.add(e.id); const c = center(e.id), el = S.els.get(e.id);
            if (tributeBatch && e.from === 'monster') { FX.ring(c.x, c.y, '#ffd36a', 90, .5, 6); }
            else { FX.destroy(c.x, c.y); SFX.play('destroy'); if (el) { el.style.filter = 'brightness(3)'; setTimeout(() => { el.style.filter = ''; }, 200); } destroyWait = true; }
          }
          break;
      }
    }
    if (destroyWait) await wait(420);
  }

  async function playPost(events) {
    let drew = false;
    for (const e of events) {
      if (e.type === 'move' && e.from === 'deck' && e.to === 'hand' && !drew) { drew = true; SFX.play('draw'); }
      if (e.type === 'field') {
        const c = center(e.id);
        if (/^(summon|ritual)$/.test(e.kind)) { SFX.play('summon'); FX.summon(c.x, c.y, e.ownerSide === 'you' ? '#7cf2ff' : '#ff8a9a'); FX.shake(false); }
        else if (/set-/.test(e.kind)) SFX.play('set');
        else if (e.kind === 'flip') { SFX.play('flip'); FX.ring(c.x, c.y, '#ffffff', 100, .5, 6); }
      }
      if (e.type === 'gameover') { SFX.play(e.winner === 'you' ? 'win' : 'lose'); }
    }
  }

  async function animAttack(e) {
    const el = S.els.get(e.attacker); if (!el) return;
    const base = S.pos.get(e.attacker); if (!base) return;
    const from = center(e.attacker);
    const tgt = e.target ? center(e.target) : { x: 835, y: e.attackerSide === 'you' ? 20 : 880 };
    SFX.play('attack'); el.style.zIndex = 700;
    applyPos(el, { x: base.x, y: base.y + (e.attackerSide === 'you' ? 14 : -14), r: base.def ? 90 : 0, s: 1.28 * FS }); await wait(340);
    FX.beam(from.x, from.y, tgt.x, tgt.y, '#ffffff', 14);
    applyPos(el, { x: tgt.x - CW / 2, y: tgt.y - CH / 2 + (e.attackerSide === 'you' ? 34 : -34), r: 0, s: 1.28 * FS }); await wait(190);
    FX.impact(tgt.x, tgt.y); FX.flash(false); FX.shake(true); SFX.play('hit');
    const tel = e.target && S.els.get(e.target); if (tel) { tel.style.filter = 'brightness(2.4) saturate(.4)'; setTimeout(() => { tel.style.filter = ''; }, 260); }
    await wait(260);
    applyPos(el, { ...base, s: base.s == null ? 1 : base.s }); el.style.zIndex = 20; await wait(380);
  }

  async function animLP(e) {
    const side = e.side, from = e.from, to = e.to, delta = to - from; if (!delta) return;
    const k = side === 'you' ? 'You' : 'Opp', plate = $('plate' + k);
    S.tweening = true; S.lp[side] = to;
    $('fill' + k).style.width = lpWidth(side, to); $('ghost' + k).style.width = lpWidth(side, to);
    const d = document.createElement('div'); d.className = 'dmg ' + (delta < 0 ? 'minus' : 'plus');
    d.textContent = (delta < 0 ? '−' : '+') + Math.abs(delta); d.style.left = (side === 'you' ? 1330 : 130) + 'px'; d.style.top = (side === 'you' ? 740 : 100) + 'px';
    $('stage').appendChild(d); setTimeout(() => d.remove(), 1500);
    if (delta < 0) { plate.classList.add('hit'); setTimeout(() => plate.classList.remove('hit'), 550); if (-delta >= 1500) { FX.shake(true); FX.flash(true); } }
    else FX.heal(side === 'you' ? 1400 : 200, side === 'you' ? 840 : 50);
    const t0 = performance.now(), dur = Math.min(1100, 400 + Math.abs(delta) / 4); let lastTick = 0;
    await new Promise(res => {
      (function tick(now) {
        const k2 = Math.min(1, (now - t0) / dur), v = from + delta * (1 - Math.pow(1 - k2, 3)); setLPDisplay(side, v);
        if (now - lastTick > 70) { SFX.play('lp'); lastTick = now; }
        if (k2 < 1) requestAnimationFrame(tick); else res();
      })(t0);
    });
    setLPDisplay(side, to); S.tweening = false;
  }

  // ------------------------------------------------------------------ result
  function showResult(v) {
    const r = $('result'); if (r.classList.contains('on')) return;
    const win = v.winner === 'you';
    $('resTxt').textContent = win ? 'VICTORY' : 'DEFEAT'; $('resSub').textContent = win ? 'YOU WON THE DUEL' : (v.winner ? 'YOU LOST THE DUEL' : 'DRAW');
    setTimeout(() => { r.className = 'on ' + (win ? 'win' : 'lose'); if (win) { for (let i = 0; i < 6; i++) setTimeout(() => FX.burst(300 + Math.random() * 1000, 200 + Math.random() * 300, { count: 40, colors: ['#ffd36a', '#fff', '#7cf2ff'], speed: 380, life: 1.4 }), i * 220); } }, 1100);
  }

  // ------------------------------------------------------------------ misc UI
  $('btnSnd').textContent = SFX.isMuted() ? '🔇' : '🔊';
  $('btnSnd').onclick = () => { SFX.setMuted(!SFX.isMuted()); $('btnSnd').textContent = SFX.isMuted() ? '🔇' : '🔊'; SFX.play('click'); };
  $('btnLeave').onclick = () => { if (confirm('Leave the duel? The current duel stays open until you start a new one.')) location.href = '/'; };
  $('btnSurr').onclick = () => { if (S.view && !S.view.gameOver && confirm('Surrender this duel?')) send('surrender'); };

  // ------------------------------------------------------------------ boot
  async function boot() {
    const r = await fetch('/api/duel/state'); if (r.status === 404) { location.href = '/duel'; return; }
    const res = await r.json();
    MODERN = !!(res.view && res.view.rules === 'modern'); FS = MODERN ? .78 : 1; document.body.classList.toggle('modern', MODERN);
    buildSlots(); wireBan();
    S.locked = true;
    render(res.view);
    await wait(900);
    if (res.view.turn <= 1 && !S.introShown) { S.introShown = true; await FX.banner('DUEL START', { sub: res.view.first === 'you' ? 'YOU GO FIRST' : 'OPPONENT GOES FIRST', ms: 1400 }); }
    await handle({ ok: true, view: res.view, events: res.events.filter(e => e.type !== 'duelStart') });
    await pump();
    S.locked = false; refreshUI();
  }
  boot().catch(e => { console.error(e); toast('Could not load the duel: ' + e.message, true); });
  window.__S = S; // handy for debugging in the console / headless tests
})();
