// ASCII coffee: background decoration for gelson.dev. It only moves when you move it; on its own, just the steam.
(() => {
  // ---------------------------------------------------------------------------
  // Config
  // ---------------------------------------------------------------------------
  const FONT_PX = 14;
  const FONT = `600 ${FONT_PX}px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`;
  // Stone palette, same as gelson.dev. Blue stays reserved for links.
  const PALETTE = {
    light: {
      glass: '#a8a29e', coffee: '#4a2e1b', stain: '#dccfbd', steam: '#a8a29e',
      skin: '#c98f68', sleeve: '#57534e', cloth: '#b4533a', clothHi: '#d97757', ink: '#6b7280',
    },
    dark: {
      glass: '#78716c', coffee: '#9a6a48', stain: '#3a2f27', steam: '#57534e',
      skin: '#c98f68', sleeve: '#a8a29e', cloth: '#b4533a', clothHi: '#d97757', ink: '#a8a29e',
    },
  };
  const mqDark = matchMedia('(prefers-color-scheme: dark)');
  const mqCalm = matchMedia('(prefers-reduced-motion: reduce)');
  let COL;
  function applyTheme() {
    COL = { ...PALETTE[mqDark.matches ? 'dark' : 'light'] };
    const muted = getComputedStyle(document.documentElement).getPropertyValue('--muted').trim();
    if (muted) COL.ink = muted;                 // the timer text uses the site's --muted
  }
  let dirty = true;                             // requests a redraw even in idle mode
  applyTheme();
  mqDark.addEventListener('change', () => { applyTheme(); dirty = true; });
  mqCalm.addEventListener('change', () => { dirty = true; });
  const G = 1500;            // gravity for the handle pendulum (px/s²)
  const FALL_G = 2400;       // gravity for the mug falling onto the table
  const CLEAN_DELAY = 20;    // seconds until the automatic cleanup

  const cvs = document.getElementById('coffee');
  const ctx = cvs.getContext('2d');

  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const lerp = (a, b, t) => a + (b - a) * t;
  const ease = t => (t < .5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);
  const normAngle = a => Math.atan2(Math.sin(a), Math.cos(a));

  // Glyph that "draws" a line in direction (dx, dy). y grows downward.
  const lineGlyph = (dx, dy) => {
    const m = Math.hypot(dx, dy) || 1;
    if (Math.abs(dy) < .38 * m) return '─';
    if (Math.abs(dx) < .38 * m) return '│';
    return dx * dy > 0 ? '╲' : '╱';
  };

  // ---------------------------------------------------------------------------
  // Character grid
  // ---------------------------------------------------------------------------
  let W = 0, H = 0, dpr = 1, cw = 9, ch = 17, cols = 0, rows = 0, ox = 0, oy = 0;
  let gGlyph = [], gCol = [], gAlpha;       // what to draw in each cell this frame
  let liq, stain, energy, stamp, settled, solid;   // spilled coffee ("falling sand" style simulation)
  let frameNo = 0;

  const cellAt = (x, y) => {
    const c = Math.floor((x - ox) / cw), r = Math.floor((y - oy) / ch);
    return c < 0 || r < 0 || c >= cols || r >= rows ? -1 : r * cols + c;
  };
  const put = (i, g, col, a) => { gGlyph[i] = g; gCol[i] = col; gAlpha[i] = a; };

  // ---------------------------------------------------------------------------
  // Mug (local coordinates: origin at the body center, unrotated)
  // ---------------------------------------------------------------------------
  const mug = {
    cx: 0, cy: 0, a: 0, om: 0, vx: 0, vy: 0,
    w: 0, h: 0, t: 0, hR: 0, hcx: 0, hcy: 0,
    vol: .88, mode: 'rest', target: 0, slosh: 0, sloshV: 0,
    spilled: false, hidden: false, home: { x: 0, y: 0 }, interiorCells: 1,
  };
  let samples, sampleYs;

  function toLocal(x, y) {
    const dx = x - mug.cx, dy = y - mug.cy, c = Math.cos(mug.a), s = Math.sin(mug.a);
    return [dx * c + dy * s, -dx * s + dy * c];
  }
  function toWorld(lx, ly) {
    const c = Math.cos(mug.a), s = Math.sin(mug.a);
    return [mug.cx + lx * c - ly * s, mug.cy + lx * s + ly * c];
  }

  function setupMug() {
    // Size in cells, not pixels: 12 columns of mug (10 of coffee + 2 walls) and 9 rows.
    // That way it never "shrinks" by landing between two cells.
    const MUG_COLS = 12, MUG_ROWS = 9;
    mug.w = MUG_COLS * cw;
    mug.h = MUG_ROWS * ch;
    mug.t = cw;                      // the wall is a single stroke; this is just the liquid's inset
    mug.hR = mug.h * .28;            // handle radius (the stroke passes exactly here)
    mug.hcx = mug.w / 2 - cw / 2;    // handle center on top of the wall stroke
    mug.hcy = 0;                     // handle centered on the mug's height
    mug.home = { x: W - Math.max(32, W * .05) - mug.w / 2 - mug.hR, y: H - mug.h / 2 };

    // Sample points inside the mug, used to compute the liquid level.
    const NX = 18, NY = 26, iw = mug.w / 2 - mug.t, top = -mug.h / 2, bot = mug.h / 2 - ch;
    samples = new Float32Array(NX * NY * 2);
    let k = 0;
    for (let j = 0; j < NY; j++) for (let i = 0; i < NX; i++) {
      samples[k++] = -iw + (i + .5) / NX * 2 * iw;
      samples[k++] = top + (j + .5) / NY * (bot - top);
    }
    sampleYs = new Float32Array(NX * NY);
    mug.interiorCells = (2 * iw) * (bot - top) / (cw * ch);
    resetMug();
    prevMx = mug.cx; prevMy = mug.cy;
  }

  function resetMug() {
    Object.assign(mug, {
      cx: mug.home.x, cy: mug.home.y, a: 0, om: 0, vx: 0, vy: 0, vol: .88,
      mode: 'rest', slosh: 0, sloshV: 0, spilled: false, hidden: false,
    });
  }

  // Screen-space y of the coffee surface for the current volume and angle.
  function computeLevel() {
    const c = Math.cos(mug.a), s = Math.sin(mug.a), N = sampleYs.length;
    for (let k = 0; k < N; k++) sampleYs[k] = mug.cy + samples[2 * k] * s + samples[2 * k + 1] * c;
    sampleYs.sort();
    const n = Math.round(mug.vol * N);
    if (n <= 0 || mug.vol < .006) return Infinity;
    if (n >= N) return sampleYs[0] - 1;
    return (sampleYs[N - n] + sampleYs[N - n - 1]) / 2;
  }

  function lowestY() {
    const hw = mug.w / 2, hh = mug.h / 2;
    let m = -Infinity;
    for (const [x, y] of [[-hw, -hh], [hw, -hh], [-hw, hh], [hw, hh]]) m = Math.max(m, toWorld(x, y)[1]);
    for (let k = 0; k < 9; k++) {
      const t = -Math.PI / 2 + k / 8 * Math.PI;
      m = Math.max(m, toWorld(mug.hcx + Math.cos(t) * mug.hR, mug.hcy + Math.sin(t) * mug.hR)[1]);
    }
    return m;
  }

  function keepOnScreen() {
    const low = lowestY();
    if (low > H) mug.cy -= low - H;
    mug.cx = clamp(mug.cx, mug.w * .6, W - mug.w * .6 - mug.hR);
  }

  // ---------------------------------------------------------------------------
  // Pointer
  // ---------------------------------------------------------------------------
  const ptr = { x: 0, y: 0, px: 0, py: 0, vx: 0, vy: 0, ax: 0, ay: 0, seen: false };
  let drag = null;               // null | 'body' | 'handle'
  const dragOff = { x: 0, y: 0 };
  const grabLocal = { x: 0, y: 0 };

  function setPtr(e) {
    ptr.x = e.clientX; ptr.y = e.clientY;
    if (!ptr.seen) { ptr.px = ptr.x; ptr.py = ptr.y; ptr.seen = true; }
  }

  function updatePtr(dt) {
    const vx = (ptr.x - ptr.px) / dt, vy = (ptr.y - ptr.py) / dt;
    const nvx = ptr.vx + (vx - ptr.vx) * .5, nvy = ptr.vy + (vy - ptr.vy) * .5;
    const ax = clamp((nvx - ptr.vx) / dt, -9000, 9000), ay = clamp((nvy - ptr.vy) / dt, -9000, 9000);
    ptr.ax += (ax - ptr.ax) * .35;
    ptr.ay += (ay - ptr.ay) * .35;
    ptr.vx = nvx; ptr.vy = nvy; ptr.px = ptr.x; ptr.py = ptr.y;
  }

  function hit(x, y) {
    if (mug.hidden) return null;
    const [lx, ly] = toLocal(x, y);
    const hw = mug.w / 2, hh = mug.h / 2, pad = cw * .8;
    if (lx > hw - cw * .5) {
      const d = Math.hypot(lx - mug.hcx, ly - mug.hcy);
      if (Math.abs(d - mug.hR) <= ch) return 'handle';
    }
    if (Math.abs(lx) <= hw + pad * .5 && Math.abs(ly) <= hh + pad * .5) return 'body';
    return null;
  }

  // The canvas sits behind the page (pointer-events: none), so input is read at the window level.
  // Mouse: the mug can be grabbed anywhere, even behind text, except over a link or control.
  // Touch: only through the "grip", an invisible box over the mug that exists only while the
  // mug sits over empty space (the side gutter or the table at the end of the page), so it
  // never blocks scrolling over the text.
  const setCursor = c => { document.documentElement.style.cursor = c; };
  const isControl = t => !!(t && t.closest && t.closest('a, button, input, textarea, select, label, summary'));

  const grip = document.createElement('div');
  grip.setAttribute('aria-hidden', 'true');
  grip.style.cssText = 'position:fixed;left:0;top:0;z-index:1;touch-action:none;display:none;-webkit-tap-highlight-color:transparent';
  document.body.appendChild(grip);

  addEventListener('pointerdown', e => {
    if (clean) return;
    const touch = e.pointerType !== 'mouse';
    if (isControl(e.target)) return;
    if (touch && e.target !== grip && !inTimer(e.clientX, e.clientY)) return;
    setPtr(e);
    // reset pointer history: in idle mode it's sampled slowly, and a jump would jolt the mug
    ptr.px = ptr.x; ptr.py = ptr.y; ptr.vx = ptr.vy = ptr.ax = ptr.ay = 0;
    if (inTimer(e.clientX, e.clientY) && !overText) { e.preventDefault(); startClean(); return; }
    const h = hit(e.clientX, e.clientY) || (touch && e.target === grip ? 'body' : null);
    if (!h) return;
    e.preventDefault();                          // no text selection, no scroll
    drag = h;
    if (h === 'body') {
      dragOff.x = mug.cx - e.clientX;
      dragOff.y = mug.cy - e.clientY;
      mug.mode = 'body';
    } else {
      const [lx, ly] = toLocal(e.clientX, e.clientY);
      grabLocal.x = lx; grabLocal.y = ly;
      mug.mode = 'handle';
      mug.om = 0;
    }
    setCursor('grabbing');
    document.documentElement.style.userSelect = 'none';
  }, { capture: true });

  addEventListener('pointermove', e => {
    if (e.pointerType !== 'mouse' && !drag) return;
    setPtr(e);
    if (e.pointerType !== 'mouse') return;
    timerHover = !drag && !overText && inTimer(e.clientX, e.clientY);
    if (!drag && !clean) {
      const onControl = isControl(e.target);
      setCursor(onControl ? '' : timerHover ? 'pointer' : hit(e.clientX, e.clientY) ? 'grab' : '');
    }
  });
  document.addEventListener('mouseleave', () => { timerHover = false; });

  // Where is the mug? Over the text (faint, no touch grip) or over empty space (full, grabbable).
  let overText = false, lastOpacity = '', gripShown = false;
  function mugBox() {
    const hw = mug.w / 2, hh = mug.h / 2;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    const add = ([x, y]) => { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); };
    for (const p of [[-hw, -hh], [hw, -hh], [-hw, hh], [hw, hh]]) add(toWorld(p[0], p[1]));
    for (let k = 0; k <= 8; k++) {
      const t = -Math.PI / 2 + k / 8 * Math.PI;
      add(toWorld(mug.hcx + Math.cos(t) * mug.hR, mug.hcy + Math.sin(t) * mug.hR));
    }
    return { x0, y0, x1, y1 };
  }
  function updateLayout() {
    if (!drag && document.documentElement.style.userSelect) document.documentElement.style.userSelect = '';
    const b = mugBox();
    const col = document.body.getBoundingClientRect();
    const end = (document.querySelector('footer') || document.body).getBoundingClientRect().bottom;
    overText = !mug.hidden && b.x1 > col.left && b.x0 < col.right && b.y0 < end;
    const op = overText && !drag ? '0.16' : '1';
    if (op !== lastOpacity) { cvs.style.opacity = op; lastOpacity = op; }
    const show = drag || (!overText && !mug.hidden && !clean);
    if (show) {
      grip.style.transform = `translate(${b.x0}px, ${b.y0}px)`;
      grip.style.width = `${b.x1 - b.x0}px`;
      grip.style.height = `${b.y1 - b.y0}px`;
    }
    if (show !== gripShown) { grip.style.display = show ? 'block' : 'none'; gripShown = show; }
  }

  function release() {
    if (!drag) return;
    drag = null;
    mug.mode = 'free';
    mug.vx = clamp(ptr.vx * .2, -600, 600);
    mug.vy = clamp(ptr.vy * .2, -600, 600);
    setCursor('');
    document.documentElement.style.userSelect = '';
  }
  addEventListener('pointerup', release);
  addEventListener('pointercancel', release);

  // ---------------------------------------------------------------------------
  // Mug physics
  // ---------------------------------------------------------------------------
  function updateMug(dt) {
    let ax = 0;

    if (mug.mode === 'body') {
      // Held by the body: the hand steadies the mug, so it only translates and keeps its angle.
      mug.cx = ptr.x + dragOff.x;
      mug.cy = ptr.y + dragOff.y;
      mug.om = 0;
      ax = ptr.ax;
      keepOnScreen();

    } else if (mug.mode === 'handle') {
      // Held by the handle: the grab point becomes the pivot and the mug is a free pendulum.
      // Gravity pulls the center of mass below the pivot; the mouse acceleration
      // acts as a "fictitious force" that swings the mug.
      const c = Math.cos(mug.a), s = Math.sin(mug.a);
      const rx = -(grabLocal.x * c - grabLocal.y * s);   // pivot -> center of mass
      const ry = -(grabLocal.x * s + grabLocal.y * c);
      const Fx = -ptr.ax, Fy = G - ptr.ay;
      const L2 = rx * rx + ry * ry;
      const I = L2 + (mug.w * mug.w + mug.h * mug.h) / 12;
      const torque = rx * Fy - ry * Fx;
      mug.om = clamp((mug.om + torque / I * dt) * Math.exp(-2.5 * dt), -10, 10); // pivot friction
      mug.a += mug.om * dt;
      const c2 = Math.cos(mug.a), s2 = Math.sin(mug.a);
      mug.cx = ptr.x - (grabLocal.x * c2 - grabLocal.y * s2);
      mug.cy = ptr.y - (grabLocal.x * s2 + grabLocal.y * c2);
      ax = ptr.ax;
      keepOnScreen();

    } else if (mug.mode === 'free') {
      // Released: falls to the table.
      mug.vy += FALL_G * dt;
      mug.cx += mug.vx * dt;
      mug.cy += mug.vy * dt;
      mug.vx *= Math.exp(-2 * dt);
      mug.a += mug.om * dt;
      mug.om *= Math.exp(-2 * dt);
      mug.cx = clamp(mug.cx, mug.w * .6, W - mug.w * .6 - mug.hR);
      const low = lowestY();
      if (low >= H) {
        mug.cy -= low - H;
        mug.vx = mug.vy = mug.om = 0;
        mug.a = normAngle(mug.a);
        // Tips over to the nearest stable pose: upright, on either side, or upside down.
        mug.target = [0, Math.PI / 2, -Math.PI / 2, Math.PI, -Math.PI]
          .reduce((best, t) => Math.abs(t - mug.a) < Math.abs(best - mug.a) ? t : best, 0);
        mug.mode = 'settle';
      }

    } else if (mug.mode === 'settle') {
      mug.a += (mug.target - mug.a) * Math.min(1, 7 * dt);
      mug.cy -= lowestY() - H;
      if (Math.abs(mug.target - mug.a) < .002) { mug.a = mug.target; mug.mode = 'rest'; }
    }

    // The coffee sloshes with the horizontal acceleration.
    const target = clamp(-ax / G * .6, -.7, .7);
    mug.sloshV += (target - mug.slosh) * 70 * dt;
    mug.sloshV *= Math.exp(-4 * dt);
    mug.slosh = clamp(mug.slosh + mug.sloshV * dt, -.8, .8);
  }

  // ---------------------------------------------------------------------------
  // Spilling: if the volume exceeds what fits at the current angle, the excess pours over the rim
  // ---------------------------------------------------------------------------
  let spillAcc = 0;

  function updateSpill(dt) {
    const iw = mug.w / 2 - mug.t * .5, y = -mug.h / 2;
    const L = toWorld(-iw, y), R = toWorld(iw, y);
    const lip = L[1] > R[1] ? L : R;                      // the lower rim
    let held = 0;
    for (const sy of sampleYs) if (sy > lip[1]) held++;
    const excess = mug.vol - held / sampleYs.length;
    // With the mouth facing down (held === 0) everything drains; it used to leave a tiny leftover.
    if (mug.vol <= 0 || (excess <= .004 && held > 0)) return;

    let dv = Math.min(excess, (.25 + excess * 3) * dt);
    if (mug.vol - dv < .006) dv = mug.vol;            // don't leave a ghost droplet in the mug
    mug.vol -= dv;
    spillAcc += dv * mug.interiorCells;
    const out = Math.sign(lip[0] - mug.cx) || 1;
    while (spillAcc >= 1) { spillAcc -= 1; spawnDrop(lip[0] + out * cw * .8, lip[1]); }

    mug.spilled = true;
    if (spillTimer === null && !clean) spillTimer = CLEAN_DELAY;
  }

  function spawnDrop(x, y) {
    let c = clamp(Math.floor((x - ox) / cw), 0, cols - 1);
    let r = clamp(Math.floor((y - oy) / ch), 0, rows - 1);
    for (let tries = 0; tries < 6; tries++) {
      const i = r * cols + c;
      if (!liq[i]) { liq[i] = 1; energy[i] = 26 + (Math.random() * 14 | 0); return; }
      r = Math.max(0, r - 1);
    }
  }

  // Coffee on the table: falls, slides diagonally and spreads sideways until it runs out of "energy".
  let moved = 0;
  function stepLiquid() {
    frameNo++;
    moved = 0;
    const leftFirst = frameNo & 1;
    const move = (i, j) => {
      moved++;
      liq[j] = 1; liq[i] = 0;
      energy[j] = energy[i]; energy[i] = 0;
      stamp[j] = frameNo;
    };
    const free = j => !liq[j] && !solid[j];   // the mug is solid: coffee can't enter it
    const airborne = mug.mode === 'body' || mug.mode === 'handle' || mug.mode === 'free';
    for (let r = rows - 1; r >= 0; r--) {
      for (let k = 0; k < cols; k++) {
        const c = leftFirst ? k : cols - 1 - k;
        const i = r * cols + c;
        if (!liq[i] || stamp[i] === frameNo) continue;
        const sd = Math.random() < .5 ? -1 : 1;
        if (r < rows - 1) {
          const b = i + cols;
          if (free(b)) { move(i, b); continue; }
          if (c + sd >= 0 && c + sd < cols && free(b + sd)) { move(i, b + sd); continue; }
          if (c - sd >= 0 && c - sd < cols && free(b - sd)) { move(i, b - sd); continue; }
          // a mug in the air isn't a shelf: coffee landing on it slides off
          if (solid[b] && airborne) {
            const out = Math.sign(ox + c * cw + cw / 2 - mug.cx) || sd;
            if (c + out >= 0 && c + out < cols && free(i + out)) { move(i, i + out); continue; }
          }
        }
        if (energy[i] > 0 && Math.random() < .6) {
          if (c + sd >= 0 && c + sd < cols && free(i + sd)) { move(i, i + sd); energy[i + sd]--; }
          else if (c - sd >= 0 && c - sd < cols && free(i - sd)) { move(i, i - sd); energy[i - sd]--; }
        }
      }
    }
  }

  // ---------------------------------------------------------------------------
  // The mug pushes the coffee: the cells it covers become "solid", and any coffee
  // inside them is pushed to the nearest free cell, preferably in the direction
  // the mug is moving.
  // ---------------------------------------------------------------------------
  let prevMx = 0, prevMy = 0, mvx = 0, mvy = 0;

  function drawCenter() {   // the same grid snapping used for drawing
    return [ox + Math.round((mug.cx - ox) / cw) * cw,
            oy + Math.round((mug.cy + mug.h / 2 - oy) / ch) * ch - mug.h / 2];
  }

  function updateSolid(dt) {
    mvx = (mug.cx - prevMx) / dt; mvy = (mug.cy - prevMy) / dt;
    prevMx = mug.cx; prevMy = mug.cy;
    solid.fill(0);
    if (mug.hidden) return;
    const [mx, my] = drawCenter(), c = Math.cos(mug.a), s = Math.sin(mug.a);
    const hw = mug.w / 2, hh = mug.h / 2, R = Math.hypot(hw, hh);
    const c0 = Math.max(0, Math.floor((mx - R - ox) / cw)), c1 = Math.min(cols - 1, Math.floor((mx + R - ox) / cw));
    const r0 = Math.max(0, Math.floor((my - R - oy) / ch)), r1 = Math.min(rows - 1, Math.floor((my + R - oy) / ch));
    for (let r = r0; r <= r1; r++) for (let cc = c0; cc <= c1; cc++) {
      const dx = ox + cc * cw + cw / 2 - mx, dy = oy + r * ch + ch / 2 - my;
      const lx = dx * c + dy * s, ly = -dx * s + dy * c;
      if (Math.abs(lx) < hw && Math.abs(ly) < hh) solid[r * cols + cc] = 1;
    }
  }

  function displaceLiquid() {
    const sp = Math.hypot(mvx, mvy);
    const ux = sp > 1 ? mvx / sp : 0, uy = sp > 1 ? mvy / sp : 0;
    const bias = clamp(sp / 250, 0, 4);            // the faster it moves, the more it pushes along the motion
    for (let i = 0; i < liq.length; i++) {
      if (!liq[i] || !solid[i]) continue;
      const r = (i / cols) | 0, c = i % cols;
      let best = -1, bestScore = Infinity, foundAt = 0;
      for (let ring = 1; ring <= 10 && !(best >= 0 && ring > foundAt + 1); ring++) {
        for (let dr = -ring; dr <= ring; dr++) for (let dc = -ring; dc <= ring; dc++) {
          if (Math.max(Math.abs(dr), Math.abs(dc)) !== ring) continue;
          const rr = r + dr, c2 = c + dc;
          if (rr < 0 || rr >= rows || c2 < 0 || c2 >= cols) continue;
          const j = rr * cols + c2;
          if (liq[j] || solid[j]) continue;
          const px = dc * cw, py = dr * ch;
          const score = px * px + py * py - bias * cw * (px * ux + py * uy);
          if (score < bestScore) { bestScore = score; best = j; if (!foundAt) foundAt = ring; }
        }
      }
      liq[i] = 0;
      if (best >= 0) { liq[best] = 1; energy[best] = Math.max(energy[i], 18); }
      energy[i] = 0;
    }
  }

  // ---------------------------------------------------------------------------
  // Steam
  // ---------------------------------------------------------------------------
  const steam = [];
  let steamAcc = 0;

  function updateSteam(dt) {
    const hot = !mqCalm.matches && !clean && !mug.hidden && mug.mode !== 'handle'
      && Math.abs(normAngle(mug.a)) < .12 && mug.vol > .5;
    if (hot) {
      steamAcc += dt;
      while (steamAcc > .09) {
        steamAcc -= .09;
        steam.push({
          x: mug.cx + (Math.random() - .5) * mug.w * .5, y: mug.cy - mug.h / 2 - ch * .5,
          vy: -(22 + Math.random() * 18), ph: Math.random() * 6.28, life: 0, max: 1.8 + Math.random() * 1.4,
        });
      }
    }
    for (const p of steam) {
      p.life += dt;
      p.y += p.vy * dt;
      p.x += Math.sin(p.ph + p.life * 2.2) * 12 * dt;
    }
    for (let k = steam.length - 1; k >= 0; k--) if (steam[k].life > steam[k].max) steam.splice(k, 1);
  }

  // ---------------------------------------------------------------------------
  // Timer + cleanup
  // ---------------------------------------------------------------------------
  let spillTimer = null, timerHover = false, clean = null;
  const PHASES = [.9, 1.0, 1.9, 1.1, .7]; // hand comes down, takes the mug, wipes with the cloth, brings it back, leaves

  // The timer is drawn on the grid itself: a transparent box that dims what's behind it.
  let timerLabel = null;                         // current text, or null when hidden
  const PAD_X = 3, PAD_Y = 1;                    // 3 characters on the sides, 1 row above and below
  const MARGIN_X = 3, MARGIN_Y = 1;              // distance from the left edge (columns) and from the bottom (rows)
  const BEHIND_ALPHA = .3;                       // whatever is behind the box shows at 30% opacity
  const BOX_W = 'Cleaning in 20'.length + PAD_X * 2;
  const BOX_H = 1 + PAD_Y * 2;

  function timerRect() {
    const c0 = MARGIN_X, r1 = rows - 1 - MARGIN_Y;
    return { c0, c1: c0 + BOX_W - 1, r0: r1 - BOX_H + 1, r1 };
  }

  function inTimer(x, y) {
    if (!timerLabel || clean) return false;
    const i = cellAt(x, y);
    if (i < 0) return false;
    const r = (i / cols) | 0, c = i % cols, b = timerRect();
    return r >= b.r0 && r <= b.r1 && c >= b.c0 && c <= b.c1;
  }

  function updateTimer(dt) {
    if (clean) { timerLabel = 'Cleaning…'; return; }
    if (spillTimer === null) { timerLabel = null; timerHover = false; return; }
    if (!timerHover) spillTimer -= dt;
    if (spillTimer <= 0) { startClean(); return; }
    timerLabel = timerHover ? 'Clean now' : `Cleaning in ${Math.ceil(spillTimer)}`;
  }

  function drawTimer() {
    if (!timerLabel) return;
    const b = timerRect();
    for (let r = Math.max(0, b.r0); r <= b.r1; r++)
      for (let c = b.c0; c <= Math.min(cols - 1, b.c1); c++) gAlpha[r * cols + c] *= BEHIND_ALPHA; // dims what's behind
    const r = b.r0 + PAD_Y, a = clean ? .4 : timerHover ? 1 : .7;
    for (let k = 0; k < timerLabel.length; k++) {
      const c = b.c0 + PAD_X + k;
      if (timerLabel[k] !== ' ' && c < cols && r >= 0) put(r * cols + c, timerLabel[k], COL.ink, a);
    }
  }

  function startClean() {
    if (clean) return;
    const chase = !!drag;                        // holding the mug? the hand comes to get it
    let minRow = rows - 4;
    for (let i = 0; i < liq.length; i++) if (liq[i] || stain[i] > 0) { minRow = Math.min(minRow, (i / cols) | 0); break; }
    clean = {
      phase: 0, t: 0, a0: normAngle(mug.a), x0: mug.cx, y0: mug.cy,
      topRow: clamp(minRow - 1, rows - Math.max(4, Math.round(rows * .25)), rows - 3), hand: { x: mug.cx, y: -ch * 2 }, cloth: null, chase,
    };
    if (!chase) { mug.mode = 'clean'; setCursor(''); }
    spillTimer = null;
    timerHover = false;
    timerLabel = 'Cleaning…';
  }

  // The hand chases the mug while the person is still holding it (or if they let go and it falls).
  function chaseHand(dt) {
    const cl = clean;
    cl.t += dt;
    const tx = mug.cx, ty = mug.cy - mug.h * .15;
    const dx = tx - cl.hand.x, dy = ty - cl.hand.y, d = Math.hypot(dx, dy);
    const step = Math.min(d, (900 + 700 * cl.t) * dt + d * 2.5 * dt);   // keeps getting faster
    if (d > 0) { cl.hand.x += dx / d * step; cl.hand.y += dy / d * step; }
    if (d < ch * 1.2) {                                                  // got it!
      drag = null;
      cl.chase = false;
      cl.phase = 1; cl.t = 0;
      cl.a0 = normAngle(mug.a); cl.x0 = mug.cx; cl.y0 = mug.cy;
      mug.mode = 'clean'; mug.om = 0;
      setCursor('');
    }
  }

  function updateClean(dt) {
    const cl = clean;
    cl.t += dt;
    const k = Math.min(1, cl.t / PHASES[cl.phase]), e = ease(k);
    const grip = mug.h * .15; // the hand "hugs" the top of the mug

    if (cl.phase === 0) {                 // hand comes down to the mug
      cl.hand.x = cl.x0;
      cl.hand.y = lerp(-ch * 2, cl.y0 - grip, e);
    } else if (cl.phase === 1) {          // straightens the mug and lifts it up
      mug.a = lerp(cl.a0, 0, e);
      mug.cx = cl.x0;
      mug.cy = lerp(cl.y0, -mug.h, e);
      cl.hand.x = mug.cx;
      cl.hand.y = mug.cy - grip;
    } else if (cl.phase === 2) {          // wipes the bottom with the cloth
      mug.hidden = true;
      const w = Math.max(W * .3, cw * 22);
      // the scrubbing fades to zero at the ends, otherwise the cloth pops 1 column back on screen after leaving
      const scrub = Math.sin(cl.t * 22) * cw * 1.2 * Math.sin(Math.PI * k);
      const x = lerp(-w / 2 - cw * 2, W + w / 2 + cw * 2, e) + scrub;
      cl.cloth = { x, w };
      cl.hand.x = x;
      cl.hand.y = oy + cl.topRow * ch + ch * 1.5;
      wipe(cl.cloth, cl.topRow);
    } else if (cl.phase === 3) {          // brings the mug back, full
      cl.cloth = null;
      mug.hidden = false;
      mug.vol = .88; mug.a = 0; mug.slosh = mug.sloshV = 0;
      mug.cx = mug.home.x;
      mug.cy = lerp(-mug.h, mug.home.y, e);
      cl.hand.x = mug.cx;
      cl.hand.y = mug.cy - grip;
    } else if (cl.phase === 4) {          // hand leaves
      cl.hand.y = lerp(mug.home.y - grip, -ch * 3, e);
    }

    if (k >= 1) {
      if (cl.phase === 2) cl.cloth = null;       // the cloth doesn't linger a single extra frame
      cl.phase++;
      cl.t = 0;
      if (cl.phase >= PHASES.length) finishClean();
    }
  }

  function wipe(cloth, topRow) {
    const c0 = Math.max(0, Math.floor((cloth.x - cloth.w / 2 - ox) / cw));
    const c1 = Math.min(cols - 1, Math.floor((cloth.x + cloth.w / 2 - ox) / cw));
    for (let r = topRow; r < rows; r++) for (let c = c0; c <= c1; c++) {
      const i = r * cols + c;
      liq[i] = 0; stain[i] = 0; energy[i] = 0;
    }
  }

  function finishClean() {
    clean = null;
    resetMug();
    spillAcc = 0;
    timerLabel = null;
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------
  const HAND = [
    '|      |',
    '|______|',
    ' /||||\\ ',
    '| |||| |',
    '| |||| |',
    ' \\____/ ',
  ];

  function render(level) {
    gGlyph.fill(null);

    // 1) coffee on the table + stain (bottom to top: only what rests on the table "settles")
    settled.fill(0);
    for (let i = liq.length - 1; i >= 0; i--) {
      if (liq[i]) {
        const r = (i / cols) | 0;
        const onTable = r === rows - 1 || settled[i + cols] || solid[i + cols];
        const above = r > 0 ? liq[i - cols] : 0;
        if (!onTable) put(i, (i + frameNo) & 2 ? "'" : ':', COL.coffee, .9);    // dripping
        else {
          settled[i] = 1;
          if (r >= rows - 2) stain[i] = 1;   // the stain stays on the table only
          put(i, above ? '#' : '~', COL.coffee, .95);
        }
      } else if (stain[i] > 0) {
        put(i, '.', COL.stain, .85);                                            // stain
      }
    }

    // 2) steam
    for (const p of steam) {
      const i = cellAt(p.x, p.y);
      if (i < 0 || gGlyph[i]) continue;
      const k = p.life / p.max;
      const g = k > .75 ? '.' : Math.sin(p.ph + p.life * 2.2) > 0 ? ')' : '(';
      put(i, g, COL.steam, (1 - k) * .65 * Math.min(1, p.life * 3));
    }

    // 3) glass mug
    if (!mug.hidden) {
      // Drawn with the center "snapped" to the grid: the walls always land in the middle of a cell.
      // (physics keeps the exact position; only the drawing steps cell by cell)
      const realX = mug.cx, realY = mug.cy;
      mug.cx = ox + Math.round((realX - ox) / cw) * cw;
      mug.cy = oy + Math.round((realY + mug.h / 2 - oy) / ch) * ch - mug.h / 2;
      level += mug.cy - realY;
      const c = Math.cos(mug.a), s = Math.sin(mug.a);
      const hw = mug.w / 2, hh = mug.h / 2;

      // The wall stroke sits half a cell inside the edge, so it never falls off screen.
      const ex = hw - cw * .5, ey = hh - ch * .5;

      // 3a) coffee inside: for each cell near the mug, "am I inside and below the surface?"
      let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
      for (const [lx, ly] of [[-hw, -hh], [hw, -hh], [-hw, hh], [hw, hh]]) {
        const [wx, wy] = toWorld(lx, ly);
        x0 = Math.min(x0, wx); x1 = Math.max(x1, wx); y0 = Math.min(y0, wy); y1 = Math.max(y1, wy);
      }
      const c0 = Math.max(0, Math.floor((x0 - ox) / cw) - 1), c1 = Math.min(cols - 1, Math.floor((x1 - ox) / cw) + 1);
      const r0 = Math.max(0, Math.floor((y0 - oy) / ch) - 1), r1 = Math.min(rows - 1, Math.floor((y1 - oy) / ch) + 1);
      for (let r = r0; r <= r1; r++) for (let cc = c0; cc <= c1; cc++) {
        const x = ox + cc * cw + cw / 2, y = oy + r * ch + ch / 2;
        const dx = x - mug.cx, dy = y - mug.cy;
        const lx = dx * c + dy * s, ly = -dx * s + dy * c;
        if (Math.abs(lx) >= ex - cw * .5 || ly <= -hh || ly >= ey - ch * .5) continue;
        // the slosh tilts the surface, but with little coffee it can't create coffee out of nothing
        const surf = level + mug.slosh * clamp(mug.vol / .3, 0, 1) * (x - mug.cx);
        if (y > surf) put(r * cols + cc, y - surf < ch ? '~' : '#', COL.coffee, 1);
        // empty glass: draw nothing, so you can see what's behind
      }

      // 3b) wall: a single stroke. Each straight segment becomes at most 1 cell per grid row
      // (if mostly vertical) or 1 per column (if mostly horizontal), like Bresenham's algorithm.
      const seg = (ax, ay, bx, by) => {
        const [x1, y1] = toWorld(ax, ay), [x2, y2] = toWorld(bx, by);
        const dx = x2 - x1, dy = y2 - y1, g = lineGlyph(dx, dy);
        const plot = (x, y) => { const i = cellAt(x, y); if (i >= 0) put(i, g, COL.glass, 1); };
        // down to fairly flat slopes, 1 cell per row: an ASCII diagonal reads better that way than doubled
        if (Math.abs(dy) / ch >= .25 * Math.abs(dx) / cw) {
          // only rows whose center falls inside the segment: neighboring segments never repeat a row
          const lo = Math.min(y1, y2), hi = Math.max(y1, y2);
          for (let r = Math.ceil((lo - oy - ch / 2) / ch); oy + r * ch + ch / 2 < hi; r++) {
            const y = oy + r * ch + ch / 2;
            plot(x1 + dx * (y - y1) / dy, y);
          }
        } else {
          const lo = Math.min(x1, x2), hi = Math.max(x1, x2);
          for (let k = Math.ceil((lo - ox - cw / 2) / cw); ox + k * cw + cw / 2 < hi; k++) {
            const x = ox + k * cw + cw / 2;
            plot(x, y1 + dy * (x - x1) / dx);
          }
        }
      };
      const ARC = 14;                // handle: half a circle in 14 straight segments
      for (let k = 0; k < ARC; k++) {
        const t1 = -Math.PI / 2 + k / ARC * Math.PI, t2 = -Math.PI / 2 + (k + 1) / ARC * Math.PI;
        seg(ex + Math.cos(t1) * mug.hR, mug.hcy + Math.sin(t1) * mug.hR,
            ex + Math.cos(t2) * mug.hR, mug.hcy + Math.sin(t2) * mug.hR);
      }
      // walls last, so the tip of the handle doesn't cut into the wall
      seg(-ex, -hh, -ex, ey);        // left side
      seg(-ex, ey, ex, ey);          // bottom
      seg(ex, ey, ex, -hh);          // right side

      // 3c) bottom corners: the glyph depends on which way the corner "opens" after rotation
      for (const [lx, bx, by] of [[-ex, 1, -1], [ex, -1, -1]]) {
        const [wx, wy] = toWorld(lx, ey), i = cellAt(wx, wy);
        if (i < 0) continue;
        const qx = bx * c - by * s, qy = bx * s + by * c;
        put(i, qy < 0 ? (qx > 0 ? '╰' : '╯') : (qx > 0 ? '╭' : '╮'), COL.glass, 1);
      }
      mug.cx = realX; mug.cy = realY;
    }

    // 4) timer (dims what's behind it; the cloth and the hand go over it)
    drawTimer();

    // 5) cloth
    if (clean && clean.cloth) {
      const { x, w } = clean.cloth;
      const c0 = Math.max(0, Math.floor((x - w / 2 - ox) / cw));
      const c1 = Math.min(cols - 1, Math.floor((x + w / 2 - ox) / cw));
      for (let r = clean.topRow; r < rows; r++) for (let cc = c0; cc <= c1; cc++) {
        const g = r === clean.topRow ? '=' : (r + cc) % 3 === 0 ? '~' : '-';
        put(r * cols + cc, g, (r + cc) % 2 ? COL.cloth : COL.clothHi, 1);
      }
    }

    // 6) hand + arm
    if (clean) {
      const rb = Math.floor((clean.hand.y - oy) / ch);
      const cs = Math.floor((clean.hand.x - ox) / cw) - 4;
      const drawRow = (r, line, col) => {
        if (r < 0 || r >= rows) return;
        for (let k = 0; k < line.length; k++) {
          const cc = cs + k;
          if (line[k] !== ' ' && cc >= 0 && cc < cols) put(r * cols + cc, line[k], col, 1);
        }
      };
      for (let j = 0; j < HAND.length; j++) {
        const idx = HAND.length - 1 - j;
        drawRow(rb - j, HAND[idx], idx < 2 ? COL.sleeve : COL.skin);
      }
      for (let r = rb - HAND.length; r >= 0; r--) drawRow(r, HAND[0], COL.sleeve);
    }

    // draw the grid
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.font = FONT;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (let i = 0; i < gGlyph.length; i++) {
      const g = gGlyph[i];
      if (!g) continue;
      ctx.globalAlpha = gAlpha[i];
      ctx.fillStyle = gCol[i];
      ctx.fillText(g, ox + (i % cols) * cw + cw / 2, oy + ((i / cols) | 0) * ch + ch / 2 + 1);
    }
    ctx.globalAlpha = 1;
  }

  // ---------------------------------------------------------------------------
  // Setup + loop
  // Setup + loop
  function resize() {
    W = innerWidth; H = innerHeight;
    dpr = Math.min(devicePixelRatio || 1, 2);
    cvs.width = Math.round(W * dpr);
    cvs.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.font = FONT;
    cw = Math.ceil(ctx.measureText('M').width);
    ch = Math.round(FONT_PX * 1.2);
    cols = Math.floor(W / cw);
    rows = Math.floor(H / ch);
    ox = (W - cols * cw) / 2;
    oy = H - rows * ch;
    const n = cols * rows;
    gGlyph = new Array(n).fill(null);
    gCol = new Array(n);
    gAlpha = new Float32Array(n);
    liq = new Uint8Array(n);
    stain = new Float32Array(n);
    energy = new Uint8Array(n);
    stamp = new Uint32Array(n);
    settled = new Uint8Array(n);
    solid = new Uint8Array(n);
    drag = null;
    clean = null;
    spillTimer = null;
    timerLabel = null;
    timerHover = false;
    steam.length = 0;
    quiet = 0; dirty = true;
    setupMug();
  }

  // Idle mode: when everything is at rest, only the steam moves, at ~14 fps. Any interaction goes back to 60 fps.
  const IDLE_FPS = 14;
  let quiet = 0, idleAcc = 0;
  const isIdle = () => !drag && !clean && mug.mode === 'rest'
    && Math.abs(mug.slosh) < 1e-3 && Math.abs(mug.sloshV) < 1e-3 && quiet > 30;

  let last = performance.now();
  function frame(now) {
    updateLayout();
    if (isIdle()) {
      idleAcc += Math.min((now - last) / 1000, .25);
      last = now;
      if (idleAcc >= 1 / IDLE_FPS) {
        const dt = idleAcc;
        idleAcc = 0;
        updatePtr(dt);
        updateSteam(dt);
        updateTimer(dt);
        if (steam.length || timerLabel || dirty) { render(computeLevel()); dirty = false; }
      }
      requestAnimationFrame(frame);
      return;
    }
    idleAcc = 0;
    const dt = clamp((now - last) / 1000, 1 / 240, 1 / 30);
    last = now;
    updatePtr(dt);
    if (clean && clean.chase) { updateMug(dt); chaseHand(dt); }
    else if (clean) updateClean(dt);
    else updateMug(dt);
    const level = computeLevel();
    if (!clean || clean.chase) updateSpill(dt);
    updateSolid(dt);
    displaceLiquid();
    stepLiquid();
    quiet = moved ? 0 : quiet + 1;
    updateSteam(dt);
    updateTimer(dt);
    render(level);
    requestAnimationFrame(frame);
  }

  addEventListener('resize', resize);
  resize();
  requestAnimationFrame(frame);

})();
