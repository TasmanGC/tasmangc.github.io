/* ============================================================
   ore-game.js — "Find the ore body" homepage mini-game.
   A noisy gravity profile sits over a hidden cross-section.
   Click (or arrow keys + Enter) to drill; each hole reveals the
   geology it passes through and an assay reading.
   Difficulty changes the survey signal (noise, regional trend,
   false bumps, decoy bodies); deposits sets how many to find.
   ============================================================ */
(function () {
  var canvas = document.getElementById('ore-canvas');
  if (!canvas || !canvas.getContext) return;
  var ctx = canvas.getContext('2d');
  var statusEl = document.getElementById('ore-status');
  var holesEl  = document.getElementById('ore-holes');
  var againBtn = document.getElementById('ore-again');
  var settingBtns = document.querySelectorAll('[data-ore-setting]');

  // Logical drawing space; scaled to the canvas size on render.
  var W = 480, H = 300;
  var GRAV_TOP = 18, GRAV_BOT = 60;
  var SURFACE = 80;
  var HOLE_HALF = 5;          // half-width of the revealed strip
  var METRES_PER_UNIT = 2;
  var MIN_SPACING = 70;       // min horizontal gap between buried bodies

  // noise: per-station jitter, ripple: false bumps, trend: regional slope,
  // decoys: dense barren bodies, size/depth: ore geometry.
  var DIFFICULTY = {
    easy:   { noise: 0.04, ripple: 0.04, trend: 0.15, decoys: 0, size: 1.15, depth: [90, 150] },
    normal: { noise: 0.12, ripple: 0.16, trend: 0.6,  decoys: 1, size: 0.9,  depth: [100, 185] },
    hard:   { noise: 0.22, ripple: 0.3,  trend: 1.0,  decoys: 2, size: 0.75, depth: [130, 195] }
  };

  var COLORS = {
    bg:      '#FDFCF8',
    panel:   '#F5F0E8',
    hidden:  '#EDE8DA',
    hatch:   'rgba(58, 58, 56, 0.06)',
    primary: '#00693E',
    ink:     '#3A3A38',
    muted:   '#8A8880',
    accent:  '#C4942A',
    accentD: '#8B6000',
    decoy:   '#55524C',
    layers:  ['#E6D5B0', '#D6B98C', '#BFA07C', '#A0907C', '#7A736A']
  };

  var settings = { difficulty: 'normal', deposits: 1 };
  try {
    var saved = JSON.parse(localStorage.getItem('ore-game-settings'));
    if (saved && DIFFICULTY[saved.difficulty]) settings.difficulty = saved.difficulty;
    if (saved && saved.deposits >= 1 && saved.deposits <= 3) settings.deposits = saved.deposits;
  } catch (e) { /* storage unavailable; use defaults */ }

  var boundaries, bodies, gravity, holes, maxHoles, aimX, busy, over, reveal, scale;

  function rand(a, b) { return a + Math.random() * (b - a); }
  function ores() { return bodies.filter(function (b) { return !b.decoy; }); }
  function foundCount() { return ores().filter(function (b) { return b.found; }).length; }

  // --- Model ------------------------------------------------------
  function placeBody(diff, decoy) {
    for (var tries = 0; tries < 60; tries++) {
      var cx = rand(0.12 * W, 0.88 * W);
      var clear = bodies.every(function (b) { return Math.abs(b.cx - cx) > MIN_SPACING; });
      if (clear || tries === 59) {
        var s = decoy ? rand(0.9, 1.3) : diff.size;
        return {
          cx: cx,
          cy: SURFACE + rand(diff.depth[0], diff.depth[1]),
          a:  rand(20, 32) * s,
          b:  rand(8, 12) * s,
          th: rand(-0.7, 0.7),
          decoy: decoy,
          found: false
        };
      }
    }
  }

  function newGame() {
    var diff = DIFFICULTY[settings.difficulty];

    boundaries = [];
    for (var k = 1; k < COLORS.layers.length; k++) {
      boundaries.push({
        base: SURFACE + k * (H - SURFACE) / COLORS.layers.length + rand(-8, 8),
        waves: [
          { amp: rand(2, 9), freq: rand(0.006, 0.02), phase: rand(0, 6.28) },
          { amp: rand(1, 4), freq: rand(0.02, 0.05), phase: rand(0, 6.28) }
        ]
      });
    }

    bodies = [];
    for (var i = 0; i < settings.deposits; i++) bodies.push(placeBody(diff, false));
    for (var j = 0; j < diff.decoys; j++) bodies.push(placeBody(diff, true));

    // Sum of point-mass anomalies (mass ~ area / depth^2), normalised so
    // the strongest body peaks near 1, then trend, ripple and noise on top.
    var signal = [], peak = 0;
    for (var x = 0; x <= W; x += 4) {
      var g = 0;
      bodies.forEach(function (b) {
        var dz = b.cy - SURFACE, dx = (x - b.cx) / dz;
        g += (b.a * b.b) / (dz * dz) * Math.pow(1 + dx * dx, -1.5);
      });
      signal.push(g);
      peak = Math.max(peak, g);
    }
    var trend = rand(-1, 1) * diff.trend;
    var ripples = [0, 1, 2].map(function () {
      return { amp: rand(0.5, 1) * diff.ripple, freq: rand(0.015, 0.06), phase: rand(0, 6.28) };
    });
    gravity = signal.map(function (g, i) {
      var x = i * 4;
      var v = g / peak + trend * (x / W - 0.5);
      ripples.forEach(function (r) { v += r.amp * Math.sin(x * r.freq + r.phase); });
      return v + rand(-1, 1) * diff.noise;
    });

    maxHoles = 3 + 2 * settings.deposits;
    holes = [];
    aimX = null;
    busy = false;
    over = false;
    reveal = 0;
    againBtn.hidden = true;
    setStatus(settings.deposits === 1
      ? 'Gravity survey’s in. Pick your spot and drill.'
      : 'Gravity survey’s in. ' + settings.deposits + ' deposits to find.');
    renderHoleCount();
    renderSettings();
    draw();
  }

  function boundaryY(b, x) {
    var y = b.base;
    for (var i = 0; i < b.waves.length; i++) {
      var w = b.waves[i];
      y += w.amp * Math.sin(x * w.freq + w.phase);
    }
    return y;
  }

  // Normalised ellipse radius: <= 1 means inside the body.
  function bodyR(b, x, y) {
    var dx = x - b.cx, dy = y - b.cy;
    var c = Math.cos(b.th), s = Math.sin(b.th);
    var u = dx * c + dy * s;
    var v = -dx * s + dy * c;
    return Math.sqrt((u / b.a) * (u / b.a) + (v / b.b) * (v / b.b));
  }

  // --- Drawing ----------------------------------------------------
  function drawBody(b) {
    if (!b.decoy) {
      // Alteration halo around the ore body.
      ctx.save();
      ctx.translate(b.cx, b.cy);
      ctx.rotate(b.th);
      ctx.scale(b.a, b.b);
      var halo = ctx.createRadialGradient(0, 0, 0, 0, 0, 2.6);
      halo.addColorStop(0,    'rgba(196, 148, 42, 0.55)');
      halo.addColorStop(0.38, 'rgba(196, 148, 42, 0.4)');
      halo.addColorStop(1,    'rgba(196, 148, 42, 0)');
      ctx.fillStyle = halo;
      ctx.fillRect(-3, -3, 6, 6);
      ctx.restore();
    }

    ctx.beginPath();
    ctx.ellipse(b.cx, b.cy, b.a, b.b, b.th, 0, Math.PI * 2);
    ctx.fillStyle = b.decoy ? COLORS.decoy : COLORS.accent;
    ctx.fill();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = b.decoy ? COLORS.ink : COLORS.accentD;
    ctx.stroke();
  }

  function drawGeology() {
    for (var k = 0; k < COLORS.layers.length; k++) {
      ctx.fillStyle = COLORS.layers[k];
      ctx.beginPath();
      ctx.moveTo(0, H);
      for (var x = 0; x <= W; x += 4) {
        ctx.lineTo(x, k === 0 ? SURFACE : boundaryY(boundaries[k - 1], x));
      }
      ctx.lineTo(W, H);
      ctx.closePath();
      ctx.fill();
    }
    bodies.forEach(drawBody);
  }

  function drawHidden() {
    ctx.fillStyle = COLORS.hidden;
    ctx.fillRect(0, SURFACE, W, H - SURFACE);
    ctx.strokeStyle = COLORS.hatch;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (var x = -H; x < W; x += 10) {
      ctx.moveTo(x, H);
      ctx.lineTo(x + (H - SURFACE), SURFACE);
    }
    ctx.stroke();
  }

  function drawGravity() {
    ctx.fillStyle = COLORS.panel;
    ctx.fillRect(0, 4, W, GRAV_BOT - 4 + 6);

    ctx.fillStyle = COLORS.muted;
    ctx.font = '700 9px "Nunito Sans", sans-serif';
    ctx.textBaseline = 'top';
    ctx.fillText('GRAVITY SURVEY', 8, 8);

    var lo = Math.min.apply(null, gravity), hi = Math.max.apply(null, gravity);
    ctx.beginPath();
    for (var i = 0; i < gravity.length; i++) {
      var y = GRAV_BOT - (gravity[i] - lo) / (hi - lo) * (GRAV_BOT - GRAV_TOP);
      if (i === 0) ctx.moveTo(i * 4, y); else ctx.lineTo(i * 4, y);
    }
    ctx.strokeStyle = COLORS.primary;
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }

  function drawRig(x, color) {
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(x - 5, SURFACE);
    ctx.lineTo(x, SURFACE - 12);
    ctx.lineTo(x + 5, SURFACE);
    ctx.moveTo(x - 3, SURFACE - 5);
    ctx.lineTo(x + 3, SURFACE - 5);
    ctx.stroke();
  }

  function draw() {
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    ctx.fillStyle = COLORS.bg;
    ctx.fillRect(0, 0, W, H);

    drawGravity();
    drawHidden();

    if (over) {
      ctx.globalAlpha = reveal;
      drawGeology();
      ctx.globalAlpha = 1;
    } else {
      holes.forEach(function (h) {
        ctx.save();
        ctx.beginPath();
        ctx.rect(h.x - HOLE_HALF, SURFACE, HOLE_HALF * 2, h.depth);
        ctx.clip();
        drawGeology();
        ctx.restore();
      });
      // Deposits already found stay outlined while you hunt the rest.
      bodies.forEach(function (b) { if (b.found) drawBody(b); });
    }

    // Ground surface.
    ctx.fillStyle = COLORS.primary;
    ctx.fillRect(0, SURFACE - 1.5, W, 3);

    // Aim guide.
    if (aimX !== null && !busy && !over) {
      ctx.save();
      ctx.setLineDash([3, 4]);
      ctx.strokeStyle = COLORS.accentD;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(aimX, GRAV_TOP - 4);
      ctx.lineTo(aimX, H);
      ctx.stroke();
      ctx.restore();
      drawRig(aimX, COLORS.accentD);
    }

    // Drill holes.
    holes.forEach(function (h, i) {
      ctx.strokeStyle = COLORS.ink;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(h.x, SURFACE);
      ctx.lineTo(h.x, SURFACE + h.depth);
      ctx.stroke();
      drawRig(h.x, h.hit ? COLORS.accentD : COLORS.ink);
      ctx.fillStyle = COLORS.ink;
      ctx.font = '700 9px "Nunito Sans", sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      ctx.fillText(String(i + 1), h.x, SURFACE - 13);
      ctx.textAlign = 'left';
    });
  }

  // --- Game flow --------------------------------------------------
  function setStatus(text) { statusEl.textContent = text; }

  function renderHoleCount() {
    holesEl.innerHTML = '';
    for (var i = 0; i < maxHoles; i++) {
      var dot = document.createElement('span');
      dot.className = 'ore-hole-dot';
      var h = holes[i];
      if (h) dot.classList.add(h.hit ? 'is-hit' : 'is-used');
      holesEl.appendChild(dot);
    }
    holesEl.setAttribute('aria-label', (maxHoles - holes.length) + ' of ' + maxHoles + ' drill holes left');
  }

  function renderSettings() {
    settingBtns.forEach(function (btn) {
      var key = btn.dataset.oreSetting;
      var val = key === 'deposits' ? Number(btn.dataset.value) : btn.dataset.value;
      btn.setAttribute('aria-pressed', String(settings[key] === val));
    });
  }

  function drill(x) {
    if (busy || over || x === null) return;
    busy = true;
    var hole = { x: x, depth: 0, hit: false };
    holes.push(hole);

    var target = H - SURFACE;
    var start = null;
    function step(t) {
      if (start === null) start = t;
      var p = Math.min((t - start) / 700, 1);
      hole.depth = target * (1 - Math.pow(1 - p, 3));
      draw();
      if (p < 1) requestAnimationFrame(step);
      else finishHole(hole);
    }
    requestAnimationFrame(step);
  }

  function winVerdict(used, total) {
    var dry = used - total;
    if (used === maxHoles) return 'Last hole of the budget. Classic exploration.';
    if (dry === 0) return 'Every hole a discovery. Hire this geologist.';
    if (dry === 1) return 'Only one dry hole. Very tidy targeting.';
    if (dry === 2) return 'The board is pleased.';
    return 'Got there in the end.';
  }

  function finishHole(hole) {
    var n = holes.length;
    var total = settings.deposits;
    var minR = Infinity, newOre = 0, oreMetres = 0, decoyMetres = 0;

    bodies.forEach(function (b) {
      var inside = 0;
      for (var y = SURFACE; y <= H; y++) {
        var r = bodyR(b, hole.x, y);
        if (r <= 1) inside++;
        if (!b.decoy && !b.found && r < minR) minR = r;
      }
      if (!inside) return;
      if (b.decoy) {
        decoyMetres += inside * METRES_PER_UNIT;
      } else {
        oreMetres += inside * METRES_PER_UNIT;
        if (!b.found) { b.found = true; newOre++; }
      }
    });
    busy = false;

    var found = foundCount();
    var msg;
    if (oreMetres > 0) {
      hole.hit = newOre > 0;
      msg = 'Hole ' + n + ': ' + oreMetres + ' m @ ' + rand(4, 12).toFixed(1) + ' g/t gold. ';
      if (found === total)  msg += winVerdict(n, total);
      else if (newOre)      msg += 'Deposit ' + found + ' of ' + total + ' found.';
      else                  msg += 'Already found that one.';
    } else if (decoyMetres > 0) {
      msg = 'Hole ' + n + ': ' + decoyMetres + ' m of dolerite. Dense, but barren. That explains a bump.';
    } else {
      var grade = Math.exp(-Math.pow((minR - 1) * 1.2, 2));
      if (grade > 0.45)      msg = 'strong alteration, ' + (grade * 1.8).toFixed(2) + ' g/t. You’re close.';
      else if (grade > 0.12) msg = 'weak anomaly, ' + (grade * 1.8).toFixed(2) + ' g/t. Warmer.';
      else                   msg = 'barren. Nothing but country rock.';
      msg = 'Hole ' + n + ': ' + msg;
    }

    if (found === total) {
      endGame();
    } else if (n >= maxHoles) {
      msg += ' Budget’s gone' + (total > 1 ? ' with ' + found + ' of ' + total + ' found' : '') +
             '. There’s the geology: that’s exploration.';
      endGame();
    }
    setStatus(msg);
    renderHoleCount();
    draw();
  }

  function endGame() {
    over = true;
    againBtn.hidden = false;
    var start = null;
    function step(t) {
      if (start === null) start = t;
      reveal = Math.min((t - start) / 600, 1);
      draw();
      if (reveal < 1) requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
  }

  // --- Input & sizing ---------------------------------------------
  function toLogicalX(evt) {
    var rect = canvas.getBoundingClientRect();
    var x = (evt.clientX - rect.left) / rect.width * W;
    return Math.max(HOLE_HALF + 1, Math.min(W - HOLE_HALF - 1, x));
  }

  canvas.addEventListener('pointermove', function (e) { aimX = toLogicalX(e); draw(); });
  canvas.addEventListener('pointerleave', function () { aimX = null; draw(); });
  canvas.addEventListener('click', function (e) { drill(toLogicalX(e)); });

  canvas.addEventListener('keydown', function (e) {
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      if (aimX === null) aimX = W / 2;
      aimX += e.key === 'ArrowLeft' ? -8 : 8;
      aimX = Math.max(HOLE_HALF + 1, Math.min(W - HOLE_HALF - 1, aimX));
      draw();
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      drill(aimX === null ? W / 2 : aimX);
    }
  });
  canvas.addEventListener('focus', function () { if (aimX === null) { aimX = W / 2; draw(); } });
  canvas.addEventListener('blur', function () { aimX = null; draw(); });

  againBtn.addEventListener('click', newGame);

  settingBtns.forEach(function (btn) {
    btn.addEventListener('click', function () {
      if (busy) return;
      var key = btn.dataset.oreSetting;
      settings[key] = key === 'deposits' ? Number(btn.dataset.value) : btn.dataset.value;
      try { localStorage.setItem('ore-game-settings', JSON.stringify(settings)); } catch (e) { /* ignore */ }
      newGame();
    });
  });

  function resize() {
    var dpr = window.devicePixelRatio || 1;
    var cssW = canvas.clientWidth;
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssW * H / W * dpr);
    scale = canvas.width / W;
    if (bodies) draw();
  }

  window.addEventListener('resize', resize);
  resize();
  newGame();
})();
