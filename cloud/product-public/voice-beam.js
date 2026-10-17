(function () {
  'use strict';

  var VARIANT_PALETTES = {
    colorful: {
      colors: ['#FF6B6B', '#FFD166', '#6BCB77', '#4D96FF', '#B388FF', '#FF8FAB', '#63E6E2'],
      bandColors: { core: '#ffffff', above: '#FFD166', mid: '#4D96FF', below: '#B388FF' }
    },
    mono: {
      colors: ['#f4f4f4', '#dcdcdc', '#c2c2c2', '#a8a8a8', '#8f8f8f', '#757575', '#5c5c5c'],
      bandColors: { core: '#ffffff', above: '#e8e8e8', mid: '#b5b5b5', below: '#7a7a7a' }
    },
    ocean: {
      colors: ['#7FDBFF', '#39CCCC', '#2E86DE', '#00A8CC', '#54C6EB', '#1B6CA8', '#A0E7E5'],
      bandColors: { core: '#eafcff', above: '#7FDBFF', mid: '#2E86DE', below: '#1B6CA8' }
    },
    sunset: {
      colors: ['#FF9F1C', '#FF6B6B', '#FF3CAC', '#E63946', '#FF8E53', '#F72585', '#FFB347'],
      bandColors: { core: '#fff6e8', above: '#FFB347', mid: '#FF6B6B', below: '#C9184A' }
    },
    forest: {
      colors: ['#95D5B2', '#52B788', '#40916C', '#74C69D', '#2D6A4F', '#B7E4C7', '#1B4332'],
      bandColors: { core: '#f4fff8', above: '#B7E4C7', mid: '#52B788', below: '#2D6A4F' }
    },
    candy: {
      colors: ['#FFB3C1', '#E0AAFF', '#FFC6FF', '#C8B6FF', '#FFAFCC', '#BBD0FF', '#F8C8DC'],
      bandColors: { core: '#fff7ff', above: '#FFC6FF', mid: '#E0AAFF', below: '#C8B6FF' }
    },
    ice: {
      colors: ['#EAF6FF', '#C9E7FF', '#A8D8FF', '#8AC6FF', '#F2FBFF', '#BFE8FF', '#6FB7FF'],
      bandColors: { core: '#ffffff', above: '#EAF6FF', mid: '#A8D8FF', below: '#6FB7FF' }
    },
    gold: {
      colors: ['#FFD166', '#FFB703', '#FFC94D', '#FB8500', '#E09F3E', '#FFE08A', '#D4A017'],
      bandColors: { core: '#fff8e6', above: '#FFD166', mid: '#E09F3E', below: '#A66A11' }
    }
  };

  var OPTION_DEFAULTS = {
    type: 'pill',
    level: 0,
    stream: null,
    processing: false,
    colorVariant: 'colorful',
    colors: null,
    bandColors: null,
    sensitivity: 1.6,
    threshold: 0.06,
    attack: 0.28,
    release: 0.09,
    reach: 0.62,
    spread: 0.55,
    flow: 0.35,
    bend: 0.18,
    idle: 0.08,
    theme: 'dark',
    strength: 1,
    active: true,
    paused: false,
    scale: 1
  };

  function clamp01(value) {
    if (typeof value !== 'number' || !isFinite(value)) return 0;
    if (value < 0) return 0;
    if (value > 1) return 1;
    return value;
  }

  function parseColor(hex) {
    var text = String(hex).replace('#', '');
    if (text.length === 3) {
      text = text.charAt(0) + text.charAt(0) + text.charAt(1) + text.charAt(1) + text.charAt(2) + text.charAt(2);
    }
    var value = parseInt(text, 16);
    if (!isFinite(value)) return [255, 255, 255];
    return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
  }

  function rgba(color, alpha) {
    return 'rgba(' + color[0] + ',' + color[1] + ',' + color[2] + ',' + alpha + ')';
  }

  function mixColor(a, b, t) {
    return [
      Math.round(a[0] + (b[0] - a[0]) * t),
      Math.round(a[1] + (b[1] - a[1]) * t),
      Math.round(a[2] + (b[2] - a[2]) * t)
    ];
  }

  function roundRectPath(ctx, x, y, w, h, radiusLeft, radiusRight) {
    var maxR = Math.min(w, h) / 2;
    var rl = Math.max(0, Math.min(radiusLeft, maxR));
    var rr = Math.max(0, Math.min(radiusRight, maxR));
    ctx.beginPath();
    ctx.moveTo(x + rl, y);
    ctx.lineTo(x + w - rr, y);
    if (rr > 0) ctx.arcTo(x + w, y, x + w, y + rr, rr); else ctx.lineTo(x + w, y);
    ctx.lineTo(x + w, y + h);
    if (rl > 0) ctx.arcTo(x + w, y + h, x + w - rl, y + h, rl); else ctx.lineTo(x + w - rl, y + h);
    ctx.lineTo(x + rl, y + h);
    if (rl > 0) ctx.arcTo(x, y + h, x, y + h - rl, rl); else ctx.lineTo(x, y + h - rl);
    ctx.lineTo(x, y + rl);
    if (rl > 0) ctx.arcTo(x, y, x + rl, y, rl); else ctx.lineTo(x + rl, y);
    ctx.closePath();
  }

  function readRadiusPx(text, w, h) {
    if (!text) return 0;
    var value = parseFloat(text);
    if (!isFinite(value) || value <= 0) return 0;
    if (String(text).indexOf('%') >= 0) value = (value / 100) * Math.min(w, h);
    return value;
  }

  function DisplayOSVoiceBeam(container, options) {
    if (!container || typeof container.appendChild !== 'function') {
      throw new Error('DisplayOSVoiceBeam needs a container element');
    }
    var provided = options || {};
    var opts = {};
    for (var key in OPTION_DEFAULTS) {
      if (Object.prototype.hasOwnProperty.call(OPTION_DEFAULTS, key)) {
        if (Object.prototype.hasOwnProperty.call(provided, key) && provided[key] !== undefined) opts[key] = provided[key];
        else opts[key] = OPTION_DEFAULTS[key];
      }
    }

    var variantName = typeof opts.colorVariant === 'string' && VARIANT_PALETTES[opts.colorVariant] ? opts.colorVariant : 'colorful';
    var variant = VARIANT_PALETTES[variantName];
    opts.colorVariant = variantName;

    var lobeHex = [];
    if (Object.prototype.toString.call(opts.colors) === '[object Array]' && opts.colors.length > 0) {
      for (var ci = 0; ci < 7; ci++) lobeHex.push(opts.colors[ci % opts.colors.length]);
    } else {
      for (var vi = 0; vi < 7; vi++) lobeHex.push(variant.colors[vi]);
    }
    opts.colors = lobeHex;

    var bandHex = { core: variant.bandColors.core, above: variant.bandColors.above, mid: variant.bandColors.mid, below: variant.bandColors.below };
    if (opts.bandColors && typeof opts.bandColors === 'object') {
      if (opts.bandColors.core) bandHex.core = opts.bandColors.core;
      if (opts.bandColors.above) bandHex.above = opts.bandColors.above;
      if (opts.bandColors.mid) bandHex.mid = opts.bandColors.mid;
      if (opts.bandColors.below) bandHex.below = opts.bandColors.below;
    }
    opts.bandColors = bandHex;

    opts.sensitivity = typeof opts.sensitivity === 'number' ? opts.sensitivity : OPTION_DEFAULTS.sensitivity;
    opts.threshold = typeof opts.threshold === 'number' ? opts.threshold : OPTION_DEFAULTS.threshold;
    opts.attack = clamp01(typeof opts.attack === 'number' ? opts.attack : OPTION_DEFAULTS.attack);
    opts.release = clamp01(typeof opts.release === 'number' ? opts.release : OPTION_DEFAULTS.release);
    opts.reach = typeof opts.reach === 'number' ? opts.reach : OPTION_DEFAULTS.reach;
    opts.spread = typeof opts.spread === 'number' ? opts.spread : OPTION_DEFAULTS.spread;
    opts.flow = typeof opts.flow === 'number' ? opts.flow : OPTION_DEFAULTS.flow;
    opts.bend = typeof opts.bend === 'number' ? opts.bend : OPTION_DEFAULTS.bend;
    opts.idle = typeof opts.idle === 'number' ? opts.idle : OPTION_DEFAULTS.idle;
    opts.theme = opts.theme === 'light' ? 'light' : 'dark';
    opts.strength = clamp01(typeof opts.strength === 'number' ? opts.strength : OPTION_DEFAULTS.strength);
    opts.active = opts.active !== false;
    opts.paused = opts.paused === true;
    opts.processing = opts.processing === true;
    opts.scale = typeof opts.scale === 'number' && opts.scale > 0 ? opts.scale : OPTION_DEFAULTS.scale;

    var lobeColors = [];
    for (var li = 0; li < lobeHex.length; li++) lobeColors.push(parseColor(lobeHex[li]));
    var band = {
      core: parseColor(bandHex.core),
      above: parseColor(bandHex.above),
      mid: parseColor(bandHex.mid),
      below: parseColor(bandHex.below)
    };

    var typeW = 1;
    var typeH = 1;
    if (opts.type === 'default') { typeW = 1.15; typeH = 1.12; }
    else if (opts.type === 'mobile') { typeW = 0.82; typeH = 0.85; }

    var canvas = document.createElement('canvas');
    canvas.style.position = 'absolute';
    canvas.style.left = '0px';
    canvas.style.top = '0px';
    canvas.style.width = '0px';
    canvas.style.height = '0px';
    canvas.style.pointerEvents = 'none';
    canvas.setAttribute('aria-hidden', 'true');
    container.appendChild(canvas);

    if (window.getComputedStyle) {
      var containerPosition = window.getComputedStyle(container).position;
      if (!containerPosition || containerPosition === 'static') container.style.position = 'relative';
    }

    var ctx = canvas.getContext('2d');
    var dpr = 1;
    var cssW = -1;
    var cssH = -1;
    var radiusLeft = 0;
    var radiusRight = 0;
    var env = 0;
    var destroyed = false;
    var rafId = 0;
    var audioCtx = null;
    var sourceNode = null;
    var analyser = null;
    var freqData = null;

    var motionQuery = null;
    if (window.matchMedia) {
      try { motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)'); } catch (mqError) { motionQuery = null; }
    }

    function softBlob(xc, yc, rx, ry, alpha, color) {
      if (rx < 0.5 || ry < 0.5 || alpha <= 0.002) return;
      ctx.save();
      ctx.translate(xc, yc);
      ctx.scale(rx, ry);
      var gradient = ctx.createRadialGradient(0, 0, 0, 0, 0, 1);
      gradient.addColorStop(0, rgba(color, alpha));
      gradient.addColorStop(0.38, rgba(color, alpha * 0.52));
      gradient.addColorStop(0.68, rgba(color, alpha * 0.16));
      gradient.addColorStop(1, rgba(color, 0));
      ctx.fillStyle = gradient;
      ctx.fillRect(-1, -1, 2, 2);
      ctx.restore();
    }

    function coreLine(x, yBottom, height, width, lean, alpha, color) {
      if (height < 2 || width < 0.8 || alpha <= 0.002) return;
      var gradient = ctx.createLinearGradient(0, yBottom, 0, yBottom - height);
      gradient.addColorStop(0, rgba(color, 0));
      gradient.addColorStop(0.18, rgba(color, alpha * 0.45));
      gradient.addColorStop(0.46, rgba(color, alpha));
      gradient.addColorStop(0.74, rgba(color, alpha * 0.5));
      gradient.addColorStop(0.94, rgba(color, 0));
      ctx.fillStyle = gradient;
      var topWidth = width * 0.8;
      ctx.beginPath();
      ctx.moveTo(x - width / 2, yBottom);
      ctx.lineTo(x + lean - topWidth / 2, yBottom - height);
      ctx.lineTo(x + lean + topWidth / 2, yBottom - height);
      ctx.lineTo(x + width / 2, yBottom);
      ctx.closePath();
      ctx.fill();
    }

    function edgeBeam(cx, yBottom, spanHalf, height, alpha, color) {
      if (height < 1 || spanHalf < 1 || alpha <= 0.002) return;
      var gradient = ctx.createLinearGradient(cx - spanHalf, 0, cx + spanHalf, 0);
      gradient.addColorStop(0, rgba(color, 0));
      gradient.addColorStop(0.26, rgba(color, alpha * 0.32));
      gradient.addColorStop(0.5, rgba(color, alpha));
      gradient.addColorStop(0.74, rgba(color, alpha * 0.32));
      gradient.addColorStop(1, rgba(color, 0));
      ctx.fillStyle = gradient;
      ctx.fillRect(cx - spanHalf, yBottom - height, spanHalf * 2, height);
    }

    function teardownAudio() {
      if (sourceNode) {
        try { sourceNode.disconnect(); } catch (disconnectError) { /* already gone */ }
        sourceNode = null;
      }
      analyser = null;
      freqData = null;
      if (audioCtx) {
        try { audioCtx.close(); } catch (closeError) { /* already gone */ }
        audioCtx = null;
      }
      opts.stream = null;
    }

    function setStream(stream) {
      if (destroyed) return;
      teardownAudio();
      if (!stream) return;
      try {
        var AudioCtor = window.AudioContext || window.webkitAudioContext;
        if (!AudioCtor) return;
        audioCtx = new AudioCtor();
        if (audioCtx.state === 'suspended' && audioCtx.resume) {
          var resumed = audioCtx.resume();
          if (resumed && resumed.catch) resumed.catch(function () {});
        }
        sourceNode = audioCtx.createMediaStreamSource(stream);
        analyser = audioCtx.createAnalyser();
        analyser.smoothingTimeConstant = 0.65;
        analyser.fftSize = 256;
        freqData = new Uint8Array(analyser.frequencyBinCount);
        sourceNode.connect(analyser);
        opts.stream = stream;
      } catch (audioError) {
        teardownAudio();
      }
    }

    function setLevel(value) {
      if (destroyed) return;
      opts.level = clamp01(value);
    }

    function setProcessing(value) {
      if (destroyed) return;
      opts.processing = value === true;
    }

    function setPaused(value) {
      if (destroyed) return;
      opts.paused = value === true;
    }

    function destroy() {
      if (destroyed) return;
      destroyed = true;
      if (rafId) {
        if (window.cancelAnimationFrame) window.cancelAnimationFrame(rafId);
        rafId = 0;
      }
      teardownAudio();
      if (canvas && canvas.parentNode) canvas.parentNode.removeChild(canvas);
      canvas = null;
      ctx = null;
      container = null;
    }

    function readLevelOption() {
      var level = opts.level;
      if (typeof level === 'function') {
        try { return clamp01(level()); } catch (levelError) { return 0; }
      }
      return clamp01(level);
    }

    function currentRaw() {
      var raw = 0;
      if (analyser && freqData) {
        analyser.getByteFrequencyData(freqData);
        var sum = 0;
        var bins = 16;
        if (freqData.length < bins) bins = freqData.length;
        for (var i = 0; i < bins; i++) sum += freqData[i];
        raw = (sum / bins) / 255;
      } else {
        raw = readLevelOption();
      }
      return raw;
    }

    function stepEnvelope(raw) {
      var scaled = raw * opts.sensitivity;
      var target = scaled < opts.threshold ? 0 : clamp01(scaled);
      env += (target - env) * (target > env ? opts.attack : opts.release);
      if (env < 0.0008) env = 0;
      if (env > 1) env = 1;
      return env;
    }

    function syncSize(rect) {
      var nextW = Math.round(rect.width);
      var nextH = Math.round(rect.height);
      if (nextW < 0) nextW = 0;
      if (nextH < 0) nextH = 0;
      if (nextW === cssW && nextH === cssH) return;
      cssW = nextW;
      cssH = nextH;
      dpr = Math.min(window.devicePixelRatio || 1, 1.5);
      canvas.width = Math.round(cssW * dpr);
      canvas.height = Math.round(cssH * dpr);
      canvas.style.width = cssW + 'px';
      canvas.style.height = cssH + 'px';
      if (window.getComputedStyle && cssW > 0 && cssH > 0) {
        var style = window.getComputedStyle(container);
        radiusLeft = readRadiusPx(style.borderBottomLeftRadius, cssW, cssH);
        radiusRight = readRadiusPx(style.borderBottomRightRadius, cssW, cssH);
      } else {
        radiusLeft = 0;
        radiusRight = 0;
      }
    }

    function drawBottomBeam(level01, strength, cx, fanHalf, h) {
      softBlob(cx, h, fanHalf * 1.3, h * 0.3, (0.05 + 0.06 * level01) * strength, band.below);
      softBlob(cx, h, fanHalf * 1.1, h * 0.16, (0.06 + 0.09 * level01) * strength, band.mid);
      softBlob(cx, h, fanHalf * 0.95, h * 0.085, (0.09 + 0.13 * level01) * strength, band.above);
      edgeBeam(cx, h, fanHalf * 1.05, Math.max(3, h * 0.055), (0.1 + 0.12 * level01) * strength, band.above);
      edgeBeam(cx, h, fanHalf * 0.95, Math.max(1.5, h * 0.02), (0.16 + 0.28 * level01) * strength, band.core);
    }

    function drawLobes(w, h, levelEnv, t) {
      var strength = opts.strength * (opts.theme === 'light' ? 1.18 : 1);
      var cx = w / 2;
      var fanHalf = w * opts.spread * 0.5 * typeW;
      var spacing = fanHalf / 3;
      drawBottomBeam(levelEnv, strength, cx, fanHalf, h);
      for (var i = 0; i < 7; i++) {
        var d = (i - 3) / 3;
        var absD = d < 0 ? -d : d;
        var weight = 1 - 0.42 * absD;
        var shimmer = 0.84 + 0.16 * Math.sin(t * (1.1 + opts.flow * 1.6) + i * 0.85 + i * i * 0.11);
        var breath = 0.5 + 0.5 * Math.sin(t * (0.35 + opts.flow * 0.3) + i * 0.55);
        var level01 = clamp01(levelEnv * weight * shimmer + opts.idle * breath * (1 - levelEnv));
        var x = cx + d * fanHalf;
        var lobeH = h * (0.12 + opts.reach * level01 * 0.9) * typeH * opts.scale;
        if (lobeH > h * 1.02) lobeH = h * 1.02;
        var lean = d * opts.bend * lobeH * 0.5;
        var halfWidth = spacing * (0.55 + 0.5 * level01) * typeW * opts.scale;
        var lobe = lobeColors[i % lobeColors.length];
        var halo = (0.14 + 0.18 * level01) * strength;
        var below = (0.12 + 0.15 * level01) * strength;
        var mid = (0.14 + 0.18 * level01) * strength;
        var above = (0.11 + 0.14 * level01) * strength;
        var core = (0.2 + 0.38 * level01) * strength;
        softBlob(x + lean * 0.5, h - lobeH * 0.5, halfWidth * 2.2, lobeH * 0.6, halo, lobe);
        softBlob(x + lean * 0.25, h - lobeH * 0.2, halfWidth * 1.15, lobeH * 0.34, below, mixColor(lobe, band.below, 0.45));
        softBlob(x + lean * 0.5, h - lobeH * 0.5, halfWidth * 0.95, lobeH * 0.36, mid, mixColor(lobe, band.mid, 0.45));
        softBlob(x + lean * 0.8, h - lobeH * 0.78, halfWidth * 0.8, lobeH * 0.3, above, mixColor(lobe, band.above, 0.45));
        coreLine(x, h, lobeH * 0.8, Math.max(1.2, halfWidth * 0.06), lean, core, mixColor(band.core, lobe, 0.3));
      }
    }

    function drawComet(w, h, levelEnv, t) {
      var strength = opts.strength * (opts.theme === 'light' ? 1.18 : 1);
      var cx = w / 2;
      var pulse = 0.72 + 0.28 * levelEnv;
      softBlob(cx, h, w * 0.46, h * 0.12, 0.05 * strength * pulse, band.mid);
      edgeBeam(cx, h, w * 0.46, Math.max(1.5, h * 0.022), 0.12 * strength * pulse, band.core);
      var tail = w * (0.32 + opts.flow * 0.3);
      var speed = w * (0.15 + opts.flow * 0.4);
      var head = (t * speed) % w;
      var blobs = 10;
      var offsets = [0, -w, w];
      for (var o = 0; o < offsets.length; o++) {
        var shift = offsets[o];
        var h0 = head + shift;
        var x0 = h0 - tail;
        if (h0 < -tail * 0.2 || x0 > w + tail * 0.2) continue;
        for (var k = 0; k < blobs; k++) {
          var u = k / (blobs - 1);
          var pos = x0 + tail * u;
          var size = 0.3 + 0.7 * u;
          var alpha = (0.06 + 0.4 * u * u) * strength * pulse;
          var color = mixColor(band.mid, band.core, u);
          softBlob(pos, h * 0.96, tail * 0.16 * size + h * 0.05, h * 0.1 * size, alpha, color);
        }
        var gradient = ctx.createLinearGradient(x0, 0, h0, 0);
        gradient.addColorStop(0, rgba(band.core, 0));
        gradient.addColorStop(0.6, rgba(band.core, 0.12 * strength * pulse));
        gradient.addColorStop(1, rgba(band.core, 0.65 * strength * pulse));
        ctx.fillStyle = gradient;
        ctx.fillRect(x0, h - Math.max(2, h * 0.032), tail, Math.max(2, h * 0.032));
        softBlob(h0, h * 0.94, h * 0.34, h * 0.3, 0.4 * strength * pulse, band.core);
        softBlob(h0, h * 0.94, h * 0.2, h * 0.18, 0.32 * strength * pulse, band.core);
      }
    }

    function drawStatic(w, h, levelEnv) {
      var strength = opts.strength * (opts.theme === 'light' ? 1.18 : 1);
      var cx = w / 2;
      var fanHalf = w * 0.3 * typeW;
      drawBottomBeam(levelEnv, strength, cx, fanHalf, h);
      var level01 = clamp01(levelEnv + opts.idle * 0.5);
      var lobeH = h * (0.14 + opts.reach * level01 * 0.8) * typeH * opts.scale;
      var halfWidth = w * 0.13 * typeW * opts.scale;
      var lobe = lobeColors[3];
      softBlob(cx, h - lobeH * 0.5, halfWidth * 2.2, lobeH * 0.6, (0.11 + 0.14 * level01) * strength, lobe);
      softBlob(cx, h - lobeH * 0.2, halfWidth * 1.15, lobeH * 0.34, (0.13 + 0.15 * level01) * strength, mixColor(lobe, band.below, 0.45));
      softBlob(cx, h - lobeH * 0.5, halfWidth * 0.95, lobeH * 0.36, (0.15 + 0.17 * level01) * strength, mixColor(lobe, band.mid, 0.45));
      softBlob(cx, h - lobeH * 0.78, halfWidth * 0.8, lobeH * 0.3, (0.12 + 0.13 * level01) * strength, mixColor(lobe, band.above, 0.45));
      coreLine(cx, h, lobeH * 0.8, Math.max(1.2, halfWidth * 0.06), 0, (0.24 + 0.4 * level01) * strength, mixColor(band.core, lobe, 0.3));
    }

    function drawStaticProcessing(w, h) {
      var strength = opts.strength * (opts.theme === 'light' ? 1.18 : 1);
      softBlob(w / 2, h, w * 0.42, h * 0.16, 0.08 * strength, band.mid);
      softBlob(w / 2, h, w * 0.3, h * 0.1, 0.14 * strength, band.above);
      edgeBeam(w / 2, h, w * 0.34, Math.max(2, h * 0.04), 0.4 * strength, band.core);
    }

    function frame(now) {
      if (destroyed) return;
      rafId = window.requestAnimationFrame(frame);
      if (opts.paused || opts.active === false) return;
      if (!ctx || !canvas || !container) return;
      if (!container.getBoundingClientRect) return;
      var rect = container.getBoundingClientRect();
      syncSize(rect);
      if (cssW < 1 || cssH < 1) return;
      var t = now * 0.001;
      var levelEnv = stepEnvelope(currentRaw());
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, cssW, cssH);
      ctx.save();
      roundRectPath(ctx, 0, 0, cssW, cssH, radiusLeft, radiusRight);
      ctx.clip();
      ctx.globalCompositeOperation = 'lighter';
      var reduced = motionQuery ? motionQuery.matches === true : false;
      if (reduced) {
        if (opts.processing) drawStaticProcessing(cssW, cssH);
        else drawStatic(cssW, cssH, levelEnv);
      } else if (opts.processing) {
        drawComet(cssW, cssH, levelEnv, t);
      } else {
        drawLobes(cssW, cssH, levelEnv, t);
      }
      ctx.restore();
    }

    if (provided.stream) setStream(provided.stream);
    rafId = window.requestAnimationFrame(frame);

    return {
      setLevel: setLevel,
      setStream: setStream,
      setProcessing: setProcessing,
      setPaused: setPaused,
      destroy: destroy,
      stop: destroy,
      options: opts
    };
  }

  window.DisplayOSVoiceBeam = DisplayOSVoiceBeam;
}());
