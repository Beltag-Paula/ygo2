// Master Duel arena theme: small UI glue only (no duel logic).
(() => {
  const $ = id => document.getElementById(id), stage = $('stage'), turnBox = $('turnBox');
  stage.appendChild($('log')); // the duel log is a pop-up panel in this theme
  const names = { draw: 'Draw', standby: 'Standby', m1: 'Main 1', battle: 'Battle', m2: 'Main 2', end: 'End' };
  const sync = () => {
    const on = document.querySelector('#phases span.on');
    const t = on ? names[on.dataset.p] || '' : '', el = $('phaseName');
    if (el.textContent !== t) el.textContent = t; // only write on change, otherwise the observer below would re-trigger itself
    turnBox.classList.toggle('foe', $('turnWho').classList.contains('opp'));
  };
  // watch only what the duel script changes (phase highlight, whose turn), never our own phase label
  const obs = new MutationObserver(sync);
  obs.observe($('phases'), { attributes: true, subtree: true, attributeFilter: ['class'] });
  obs.observe($('turnWho'), { attributes: true, attributeFilter: ['class'] }); sync();
  $('rbLog').onclick = () => stage.classList.toggle('show-log');
  $('rbInfo').onclick = () => stage.classList.toggle('pin-info');
  $('rbSnd').onclick = () => $('btnSnd').click();
})();
