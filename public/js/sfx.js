/* sfx.js — tiny WebAudio synth so the duel has sound without any asset files. */
(function () {
  let ctx = null, muted = false;
  try { muted = localStorage.getItem('ygo.muted') === '1'; } catch (e) {}
  function ac() {
    if (!ctx) { try { ctx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { return null; } }
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }
  function tone(freq, dur, type, vol, when, slideTo) {
    const c = ac(); if (!c || muted) return;
    const t = c.currentTime + (when || 0), o = c.createOscillator(), g = c.createGain();
    o.type = type || 'sine'; o.frequency.setValueAtTime(freq, t);
    if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t + dur);
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(vol || .15, t + .01); g.gain.exponentialRampToValueAtTime(.0001, t + dur);
    o.connect(g); g.connect(c.destination); o.start(t); o.stop(t + dur + .02);
  }
  function noise(dur, vol, when, hp) {
    const c = ac(); if (!c || muted) return;
    const t = c.currentTime + (when || 0), len = Math.floor(c.sampleRate * dur), buf = c.createBuffer(1, len, c.sampleRate), d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
    const s = c.createBufferSource(), f = c.createBiquadFilter(), g = c.createGain();
    f.type = hp ? 'highpass' : 'lowpass'; f.frequency.value = hp || 1800; s.buffer = buf; g.gain.value = vol || .2;
    s.connect(f); f.connect(g); g.connect(c.destination); s.start(t);
  }
  const S = {
    draw() { noise(.14, .12, 0, 2500); tone(900, .1, 'triangle', .05, 0, 1500); },
    summon() { tone(110, .35, 'sine', .3, 0, 50); noise(.2, .18); tone(660, .3, 'triangle', .08, .05); tone(990, .35, 'triangle', .06, .1); },
    set() { noise(.1, .2); tone(140, .15, 'sine', .22, 0, 80); },
    flip() { tone(500, .12, 'square', .05, 0, 1100); noise(.1, .1, 0, 3000); },
    activate() { tone(440, .5, 'sawtooth', .05, 0, 1320); tone(880, .6, 'sine', .1, .05); tone(1320, .6, 'sine', .07, .12); },
    attack() { noise(.35, .2, 0, 900); tone(300, .35, 'sawtooth', .07, 0, 90); },
    hit() { noise(.3, .4); tone(90, .3, 'sine', .4, 0, 40); tone(240, .12, 'square', .1); },
    destroy() { noise(.5, .3, 0, 600); tone(180, .45, 'sawtooth', .08, 0, 40); tone(1400, .3, 'triangle', .05, .02, 300); },
    lp() { tone(1200, .04, 'square', .03); },
    turn() { tone(523, .15, 'triangle', .1); tone(784, .25, 'triangle', .1, .12); tone(1046, .35, 'sine', .08, .24); },
    phase() { tone(700, .08, 'triangle', .07); },
    click() { tone(1000, .05, 'square', .04); },
    deny() { tone(160, .18, 'square', .07, 0, 110); },
    win() { [523, 659, 784, 1046, 1318].forEach((f, i) => tone(f, .6, 'triangle', .11, i * .13)); },
    lose() { [440, 370, 311, 262].forEach((f, i) => tone(f, .7, 'sawtooth', .06, i * .2)); }
  };
  window.SFX = {
    play(n) { try { S[n] && S[n](); } catch (e) {} },
    isMuted() { return muted; },
    setMuted(m) { muted = m; try { localStorage.setItem('ygo.muted', m ? '1' : '0'); } catch (e) {} }
  };
  addEventListener('pointerdown', () => ac(), { once: true });
})();
