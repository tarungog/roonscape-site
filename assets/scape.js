// roonscape hero: starfield, eclipsed moon, drifting ridgelines.
(function () {
  var canvas = document.getElementById('scape-canvas');
  if (!canvas) return;
  var ctx = canvas.getContext('2d');
  var reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  var W, H, dpr;

  // deterministic PRNG so the scape is the same on every visit
  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  var rand = mulberry32(0x500);

  var STARS = [];
  for (var i = 0; i < 260; i++) {
    STARS.push({
      x: rand(), y: rand() * 0.72,
      r: 0.4 + rand() * 1.1,
      p: rand() * Math.PI * 2,
      s: 0.3 + rand() * 0.9
    });
  }

  // layered value noise for ridgelines
  function ridge(seed, x) {
    var v = 0, amp = 1, freq = 1, r = mulberry32(seed);
    var offs = [r() * 1000, r() * 1000, r() * 1000, r() * 1000];
    for (var o = 0; o < 4; o++) {
      var xx = x * freq + offs[o];
      var i0 = Math.floor(xx), f = xx - i0;
      var a = hash(seed, i0), b = hash(seed, i0 + 1);
      var u = f * f * (3 - 2 * f);
      v += (a + (b - a) * u) * amp;
      amp *= 0.5; freq *= 2.1;
    }
    return v / 1.9;
  }
  function hash(seed, n) {
    var x = Math.sin(n * 127.1 + seed * 311.7) * 43758.5453;
    return x - Math.floor(x);
  }

  var LAYERS = [
    { seed: 7,  base: 0.62, amp: 0.16, speed: 0.0035, color: '#1a1727' },
    { seed: 21, base: 0.72, amp: 0.13, speed: 0.008,  color: '#151222' },
    { seed: 47, base: 0.82, amp: 0.10, speed: 0.016,  color: '#100e1a' },
    { seed: 93, base: 0.90, amp: 0.08, speed: 0.028,  color: '#0b0a13' }
  ];

  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = canvas.clientWidth; H = canvas.clientHeight;
    canvas.width = W * dpr; canvas.height = H * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function draw(t) {
    // sky
    var sky = ctx.createLinearGradient(0, 0, 0, H);
    sky.addColorStop(0, '#07070e');
    sky.addColorStop(0.55, '#0d0b18');
    sky.addColorStop(1, '#171227');
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, W, H);

    // stars
    for (var i = 0; i < STARS.length; i++) {
      var st = STARS[i];
      var tw = 0.55 + 0.45 * Math.sin(st.p + t * 0.0006 * st.s);
      ctx.globalAlpha = tw * 0.85;
      ctx.fillStyle = '#cfc9e6';
      ctx.beginPath();
      ctx.arc(st.x * W, st.y * H, st.r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    // eclipsed moon: bright disc with occluding disc slightly offset
    var mx = W * 0.76, my = H * 0.26, mr = Math.min(W, H) * 0.075;
    var glow = ctx.createRadialGradient(mx, my, mr * 0.6, mx, my, mr * 3.2);
    glow.addColorStop(0, 'rgba(224, 133, 74, 0.28)');
    glow.addColorStop(1, 'rgba(224, 133, 74, 0)');
    ctx.fillStyle = glow;
    ctx.fillRect(mx - mr * 3.2, my - mr * 3.2, mr * 6.4, mr * 6.4);

    ctx.beginPath();
    ctx.arc(mx, my, mr, 0, Math.PI * 2);
    ctx.fillStyle = '#e8c9a8';
    ctx.fill();

    ctx.save();
    ctx.beginPath();
    ctx.arc(mx, my, mr + 0.5, 0, Math.PI * 2);
    ctx.clip();
    ctx.beginPath();
    ctx.arc(mx - mr * 0.32, my - mr * 0.18, mr * 0.98, 0, Math.PI * 2);
    ctx.fillStyle = '#0d0b16';
    ctx.fill();
    ctx.restore();

    // ridgelines, far to near
    for (var l = 0; l < LAYERS.length; l++) {
      var L = LAYERS[l];
      var drift = t * L.speed * (reduceMotion ? 0 : 1);
      ctx.beginPath();
      ctx.moveTo(0, H);
      var steps = 90;
      for (var sx = 0; sx <= steps; sx++) {
        var px = (sx / steps) * W;
        var n = ridge(L.seed, (sx / steps) * 3 + drift * 0.01);
        var py = H * (L.base - n * L.amp);
        ctx.lineTo(px, py);
      }
      ctx.lineTo(W, H);
      ctx.closePath();
      ctx.fillStyle = L.color;
      ctx.fill();
    }
  }

  var start = null;
  function frame(ts) {
    if (start === null) start = ts;
    draw(ts - start);
    if (!reduceMotion) requestAnimationFrame(frame);
  }

  resize();
  window.addEventListener('resize', function () { resize(); draw(0); });
  requestAnimationFrame(frame);
})();
