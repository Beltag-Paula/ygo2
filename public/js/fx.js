/* fx.js — canvas particles + banners + cut-ins + screen shake (stage coordinates). */
(function () {
  const cv = document.getElementById('fxcanvas'), g = cv.getContext('2d');
  const parts = [], rings = [], beams = [];
  let running = false;
  const wait = ms => new Promise(r => setTimeout(r, ms));

  function loop() {
    g.clearRect(0, 0, 1600, 900);
    g.globalCompositeOperation = 'lighter';
    for (let i = rings.length - 1; i >= 0; i--) {
      const r = rings[i]; r.t += 1 / 60; const k = r.t / r.life;
      if (k >= 1) { rings.splice(i, 1); continue; }
      g.strokeStyle = r.color; g.globalAlpha = (1 - k) * .9; g.lineWidth = r.w * (1 - k) + 1;
      g.beginPath(); g.arc(r.x, r.y, r.r0 + (r.r1 - r.r0) * (1 - Math.pow(1 - k, 3)), 0, 7); g.stroke();
    }
    for (let i = beams.length - 1; i >= 0; i--) {
      const b = beams[i]; b.t += 1 / 60; const k = b.t / b.life;
      if (k >= 1) { beams.splice(i, 1); continue; }
      g.strokeStyle = b.color; g.globalAlpha = (1 - k); g.lineWidth = b.w * (1 - k);
      g.beginPath(); g.moveTo(b.x1, b.y1); g.lineTo(b.x1 + (b.x2 - b.x1) * Math.min(1, k * 3), b.y1 + (b.y2 - b.y1) * Math.min(1, k * 3)); g.stroke();
    }
    for (let i = parts.length - 1; i >= 0; i--) {
      const p = parts[i]; p.t += 1 / 60; if (p.t >= p.life) { parts.splice(i, 1); continue; }
      p.vy += p.grav / 60; p.x += p.vx / 60; p.y += p.vy / 60;
      const k = p.t / p.life; g.globalAlpha = 1 - k; g.fillStyle = p.color;
      if (p.shard) { g.save(); g.translate(p.x, p.y); g.rotate(p.t * p.spin); g.fillRect(-p.s, -p.s / 2, p.s * 2, p.s); g.restore(); }
      else { g.beginPath(); g.arc(p.x, p.y, p.s * (1 - k * .6), 0, 7); g.fill(); }
    }
    g.globalCompositeOperation = 'source-over'; g.globalAlpha = 1;
    if (parts.length || rings.length || beams.length) requestAnimationFrame(loop); else running = false;
  }
  function kick() { if (!running) { running = true; requestAnimationFrame(loop); } }

  const FX = {
    wait,
    burst(x, y, o) {
      o = o || {}; const n = o.count || 30, c = o.colors || ['#7cf2ff', '#ffffff', '#46d2ff'];
      for (let i = 0; i < n; i++) {
        const a = Math.random() * 6.283, sp = (o.speed || 260) * (.3 + Math.random());
        parts.push({ x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - (o.up || 0), grav: o.grav === undefined ? 300 : o.grav, t: 0, life: (o.life || .8) * (.6 + Math.random() * .6),
          s: (o.size || 4) * (.5 + Math.random()), color: c[i % c.length], shard: !!o.shard, spin: (Math.random() - .5) * 20 });
      }
      kick();
    },
    ring(x, y, color, r1, life, w) { rings.push({ x, y, r0: 6, r1: r1 || 110, t: 0, life: life || .6, color: color || '#7cf2ff', w: w || 8 }); kick(); },
    beam(x1, y1, x2, y2, color, w) { beams.push({ x1, y1, x2, y2, color: color || '#ffffff', w: w || 10, t: 0, life: .35 }); kick(); },
    summon(x, y, color) { color = color || '#7cf2ff'; FX.ring(x, y, color, 120, .7, 10); FX.ring(x, y, '#ffffff', 80, .5, 5); FX.burst(x, y, { count: 26, colors: [color, '#fff'], speed: 220, grav: -40 }); },
    destroy(x, y) { FX.burst(x, y, { count: 46, colors: ['#ffffff', '#ff9a4a', '#ffd36a', '#9fd9ff'], shard: true, size: 5, speed: 340, grav: 520, life: 1 }); FX.ring(x, y, '#ffb36a', 100, .5, 8); },
    impact(x, y) { FX.ring(x, y, '#ffffff', 130, .45, 12); FX.ring(x, y, '#ff7a4a', 90, .55, 8); FX.burst(x, y, { count: 36, colors: ['#fff', '#ffb36a', '#ff5a3a'], speed: 380, grav: 200, life: .6 }); },
    heal(x, y) { FX.burst(x, y, { count: 24, colors: ['#5dffb0', '#fff'], speed: 90, grav: -160, life: 1.1 }); },
    shake(big) { const s = document.getElementById('stage'); s.classList.remove('shake', 'shake-big'); void s.offsetWidth; s.classList.add(big ? 'shake-big' : 'shake'); },
    flash(red) { const f = document.getElementById('flash'); f.className = red ? 'red' : ''; void f.offsetWidth; f.classList.add('go'); },
    async banner(text, o) {
      o = o || {}; const b = document.getElementById('banner');
      b.className = 'on' + (o.foe ? ' foe' : '') + (o.gold ? ' gold' : '') + (o.small ? ' small' : '');
      b.querySelector('.txt').textContent = text; b.querySelector('.sub2').textContent = o.sub || '';
      await wait(o.ms || 1100); b.classList.add('out'); await wait(340); b.className = '';
    },
    async cutin(img, label, kind) {
      const c = document.getElementById('cutin'); c.className = 'on ' + (kind || '');
      c.querySelector('.big').style.backgroundImage = img ? 'url(' + img.replace('cards_small', 'cards') + ')' : '';
      c.querySelector('.lbl').textContent = label || '';
      const clone = c.cloneNode(true); c.parentNode.replaceChild(clone, c); // restart CSS animations
      await wait(1000); clone.className = '';
    }
  };
  window.FX = FX;
})();
