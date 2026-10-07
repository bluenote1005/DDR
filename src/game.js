/* =========================================================================
   game.js - 서영이와 춤을! (ARCADE DANCE)
   4-pad touch rhythm game. Canvas highway + DOM stage.
   ========================================================================= */
(function () {
  'use strict';

  /* ----------------------------- config ----------------------------- */
  var LANE_COLORS = ['#ff2d95', '#22e3ff', '#4fe36b', '#ffd21e'];   // L D U R
  var LANE_DIM    = ['#5c1140', '#0d4a57', '#174a20', '#5c4a06'];
  var DIRS        = ['left', 'down', 'up', 'right'];
  var KEYMAP = {
    ArrowLeft: 0, ArrowDown: 1, ArrowUp: 2, ArrowRight: 3,
    KeyA: 0, KeyS: 1, KeyD: 2, KeyF: 3,
    Digit1: 0, Digit2: 1, Digit3: 2, Digit4: 3
  };

  // judgement windows in seconds (generous — this is a thumb, not a foot)
  var W_PERFECT = 0.060, W_GREAT = 0.105, W_GOOD = 0.150, W_MISS = 0.190;

  var SCORE_BASE = { perfect: 1000, great: 600, good: 250, bad: 60 };
  var GROOVE_DELTA = { perfect: 1.4, great: 0.9, good: 0.3, bad: -2.2, miss: -4.5 };

  var INPUT_OFFSET = 0;   // seconds; positive = your taps register later

  /* ------------------------------ dom ------------------------------- */
  var $ = function (id) { return document.getElementById(id); };
  var app = $('app');
  var cvs = $('highway'), ctx = cvs.getContext('2d');
  var elScore = $('scoreVal'), elGroove = $('grooveFill'), elPips = $('groovePips');
  var elJudge = $('judge'), elCombo = $('combo'), elComboNum = $('comboNum');
  var elBanner = $('banner'), elBannerText = $('bannerText');
  var elBig = $('bigtext'), elCount = $('countdown');
  var elPoses = $('poses'), elDancer = $('dancer');
  var elSkyline = $('skyline'), elBpm = $('bpmBadge'), elPause = $('pauseBtn');
  var elSongTitle = $('songTitle'), elBpmVal = $('bpmVal'), elSongList = $('songList');
  var titleScreen = $('titleScreen'), resultScreen = $('resultScreen'), pauseScreen = $('pauseScreen');

  /* ----------------------------- state ------------------------------ */
  var S = {
    phase: 'title',          // title | playing | paused | result
    chart: null,
    difficulty: 'normal',
    scrollDir: 'down',
    speedMult: 1,

    score: 0, combo: 0, maxCombo: 0,
    counts: { perfect: 0, great: 0, good: 0, bad: 0, miss: 0 },
    groove: 55,
    fever: false,
    alive: true,

    noteCursor: 0,           // first note not yet past the miss window
    fx: [],                  // hit bursts
    laneFlash: [0, 0, 0, 0],
    held: [false, false, false, false],
    events: [],              // scripted timeline
    pauseAt: 0,
    lastFrameT: null,        // song time of the previous frame (stall guard)
    lastBeat: -1,
    rafId: 0
  };

  /* ------------------------- canvas geometry ------------------------ */
  var G = { w: 0, h: 0, dpr: 1, laneW: 0, size: 0, recY: 0, pps: 0, lead: 0 };

  function layout() {
    var r = cvs.getBoundingClientRect();
    if (!r.width || !r.height) return;
    var dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    G.dpr = dpr;
    G.w = r.width; G.h = r.height;
    cvs.width = Math.round(r.width * dpr);
    cvs.height = Math.round(r.height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    G.laneW = G.w / 4;
    G.size = Math.min(G.laneW * 0.76, G.h * 0.22, 92);

    var margin = G.size * 0.72 + 8;
    G.recY = (S.scrollDir === 'down') ? G.h - margin : margin;
    app.classList.toggle('scrollup', S.scrollDir === 'up');

    var travel = (S.scrollDir === 'down') ? G.recY + G.size : (G.h - G.recY) + G.size;
    G.lead = 1.45 / S.speedMult;            // seconds a note stays on screen
    G.pps = travel / G.lead;

    // move the pad glow origin onto the receptor row
    document.documentElement.style.setProperty('--padY', (G.recY / G.h * 100) + '%');
  }
  window.addEventListener('resize', layout);
  window.addEventListener('orientationchange', function () { setTimeout(layout, 220); });

  /* --------------------------- arrow path --------------------------- */
  // chunky block arrow, drawn pointing up then rotated
  var ARROW = [
    [0, -0.50], [0.50, 0.02], [0.23, 0.02],
    [0.23, 0.50], [-0.23, 0.50], [-0.23, 0.02], [-0.50, 0.02]
  ];
  var ROT = { up: 0, right: Math.PI / 2, down: Math.PI, left: -Math.PI / 2 };

  function arrowPath(cx, cy, size, dir) {
    var a = ROT[dir], ca = Math.cos(a), sa = Math.sin(a);
    ctx.beginPath();
    for (var i = 0; i < ARROW.length; i++) {
      var x = ARROW[i][0] * size, y = ARROW[i][1] * size;
      var rx = x * ca - y * sa, ry = x * sa + y * ca;
      if (i === 0) ctx.moveTo(cx + rx, cy + ry); else ctx.lineTo(cx + rx, cy + ry);
    }
    ctx.closePath();
  }

  function drawReceptor(lane, lit) {
    var cx = G.laneW * (lane + 0.5), cy = G.recY, s = G.size;
    arrowPath(cx, cy, s, DIRS[lane]);
    ctx.lineWidth = Math.max(2.5, s * 0.075);
    if (lit > 0.02) {
      ctx.save();
      ctx.globalAlpha = Math.min(1, lit);
      ctx.shadowColor = LANE_COLORS[lane];
      ctx.shadowBlur = 26 * lit;
      ctx.fillStyle = LANE_COLORS[lane];
      ctx.fill();
      ctx.restore();
    }
    ctx.strokeStyle = lit > 0.02 ? '#ffffff' : LANE_COLORS[lane];
    ctx.globalAlpha = lit > 0.02 ? 1 : 0.55;
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  function drawNote(lane, y, jump, alpha) {
    var cx = G.laneW * (lane + 0.5), s = G.size;
    ctx.save();
    ctx.globalAlpha = alpha;
    arrowPath(cx, y, s, DIRS[lane]);
    var grad = ctx.createLinearGradient(cx, y - s / 2, cx, y + s / 2);
    grad.addColorStop(0, '#ffffff');
    grad.addColorStop(0.28, LANE_COLORS[lane]);
    grad.addColorStop(1, LANE_DIM[lane]);
    ctx.fillStyle = grad;
    ctx.shadowColor = LANE_COLORS[lane];
    ctx.shadowBlur = jump ? 22 : 13;
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.lineWidth = Math.max(2, s * 0.06);
    ctx.strokeStyle = jump ? '#ffffff' : 'rgba(255,255,255,.8)';
    ctx.stroke();
    ctx.restore();
  }

  /* ----------------------------- render ----------------------------- */
  function render(songT) {
    if (!G.w) return;
    ctx.clearRect(0, 0, G.w, G.h);

    // lane beds + separators
    for (var i = 0; i < 4; i++) {
      var x = G.laneW * i;
      var f = S.laneFlash[i];
      if (f > 0) {
        ctx.save();
        var lg = ctx.createLinearGradient(0, S.scrollDir === 'down' ? G.h : 0, 0, S.scrollDir === 'down' ? 0 : G.h);
        lg.addColorStop(0, LANE_COLORS[i]);
        lg.addColorStop(1, 'transparent');
        ctx.globalAlpha = f * 0.22;
        ctx.fillStyle = lg;
        ctx.fillRect(x, 0, G.laneW, G.h);
        ctx.restore();
      }
      ctx.fillStyle = 'rgba(255,255,255,.07)';
      ctx.fillRect(x, 0, 1, G.h);
    }
    ctx.fillStyle = 'rgba(255,255,255,.07)';
    ctx.fillRect(G.w - 1, 0, 1, G.h);

    // receptor row rail
    ctx.save();
    ctx.globalAlpha = S.fever ? 0.5 : 0.25;
    ctx.strokeStyle = S.fever ? '#ffd21e' : '#ff2d95';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(0, G.recY); ctx.lineTo(G.w, G.recY);
    ctx.stroke();
    ctx.restore();

    // notes
    if (S.chart) {
      var notes = S.chart.notes;
      var dir = (S.scrollDir === 'down') ? -1 : 1;
      for (var k = S.noteCursor; k < notes.length; k++) {
        var n = notes[k];
        var dt = n.t - songT;
        if (dt > G.lead + 0.1) break;
        if (n.judged) continue;
        var y = G.recY + dir * dt * G.pps;
        if (y < -G.size || y > G.h + G.size) continue;
        var a = dt > G.lead * 0.9 ? Math.max(0, (G.lead - dt) / (G.lead * 0.1)) : 1;
        drawNote(n.lane, y, n.jump, a);
      }
    }

    // receptors on top
    for (var j = 0; j < 4; j++) drawReceptor(j, S.laneFlash[j]);

    // hit bursts
    var now = performance.now();
    for (var b = S.fx.length - 1; b >= 0; b--) {
      var fx = S.fx[b];
      var p = (now - fx.t0) / fx.life;
      if (p >= 1) { S.fx.splice(b, 1); continue; }
      var cx2 = G.laneW * (fx.lane + 0.5);
      ctx.save();
      ctx.globalAlpha = (1 - p) * 0.9;
      ctx.strokeStyle = fx.color;
      ctx.lineWidth = 3 * (1 - p) + 1;
      ctx.beginPath();
      ctx.arc(cx2, G.recY, G.size * (0.45 + p * 1.15), 0, Math.PI * 2);
      ctx.stroke();
      // spokes
      for (var sp = 0; sp < 6; sp++) {
        var ang = (sp / 6) * Math.PI * 2 + fx.seed;
        var r0 = G.size * (0.5 + p * 0.9), r1 = r0 + G.size * 0.26 * (1 - p);
        ctx.beginPath();
        ctx.moveTo(cx2 + Math.cos(ang) * r0, G.recY + Math.sin(ang) * r0);
        ctx.lineTo(cx2 + Math.cos(ang) * r1, G.recY + Math.sin(ang) * r1);
        ctx.stroke();
      }
      ctx.restore();
    }
  }

  /* --------------------------- judgement ---------------------------- */
  function judgeFor(absDt) {
    if (absDt <= W_PERFECT) return 'perfect';
    if (absDt <= W_GREAT) return 'great';
    if (absDt <= W_GOOD) return 'good';
    if (absDt <= W_MISS) return 'bad';
    return null;
  }

  function press(lane) {
    if (S.phase !== 'playing') return;
    S.held[lane] = true;
    S.laneFlash[lane] = 1;

    var songT = Snd.time() - INPUT_OFFSET;
    var notes = S.chart.notes;
    var best = -1, bestDt = 1e9;

    for (var k = S.noteCursor; k < notes.length; k++) {
      var n = notes[k];
      var dt = n.t - songT;
      if (dt > W_MISS) break;
      if (n.judged || n.lane !== lane) continue;
      var ad = Math.abs(dt);
      if (ad < bestDt) { bestDt = ad; best = k; }
    }

    if (best < 0) return;                    // free swing, no penalty
    var res = judgeFor(bestDt);
    if (!res) return;
    notes[best].judged = true;
    notes[best].result = res;
    applyResult(res, lane);
  }

  function release(lane) { S.held[lane] = false; }

  function applyResult(res, lane) {
    S.counts[res]++;

    if (res === 'miss' || res === 'bad') {
      S.combo = 0;
      elCombo.classList.remove('show');
      if (res === 'miss') { Snd.sfx('miss'); poseMiss(); }
    } else {
      S.combo++;
      if (S.combo > S.maxCombo) S.maxCombo = S.combo;
      var mult = 1 + Math.min(S.combo, 120) / 120 * 0.6;
      S.score += Math.round(SCORE_BASE[res] * mult * (S.fever ? 2 : 1));
      Snd.sfx(res);
      if (lane != null) pose(lane);
      if (S.combo >= 2) {
        elCombo.classList.add('show');
        elComboNum.textContent = S.combo;
        elCombo.classList.remove('bump'); void elCombo.offsetWidth; elCombo.classList.add('bump');
      }
      S.fx.push({ lane: lane, t0: performance.now(), life: res === 'perfect' ? 420 : 300, color: LANE_COLORS[lane], seed: Math.random() * 6 });
    }
    if (res === 'bad') { Snd.sfx('miss'); }

    S.groove = Math.max(0, Math.min(100, S.groove + GROOVE_DELTA[res]));
    showJudge(res);
    updateHud();

    if (S.groove <= 0 && S.alive) { S.alive = false; finish(true); }
  }

  var JUDGE_TEXT = { perfect: 'PERFECT!', great: 'GREAT!', good: 'GOOD', bad: 'BAD', miss: 'MISS' };
  function showJudge(res) {
    elJudge.textContent = JUDGE_TEXT[res];
    elJudge.className = 'judge ' + res;
    void elJudge.offsetWidth;
    elJudge.classList.add('pop');
  }

  /* ---------------------- character animation -----------------------
     12 sprites cut from the reference footage, all rendered onto one canvas
     with a shared ground line, so swapping them never makes her jump about.
     Each pad owns a rotating set of poses: hitting the same pad twice in a
     row gives two different moves.                                        */
  var POSES = ['peace', 'step', 'back', 'hips', 'armsout', 'cheer',
               'march', 'twist', 'point', 'spin', 'slide', 'jump'];
  var POSE_SRC = {};
  POSES.forEach(function (n) { POSE_SRC[n] = 'assets/pose_' + n + '.webp'; });

  // [pose, mirrored]
  var LANE_POSES = {
    0: [['step', 1], ['twist', 1], ['slide', 1], ['spin', 1], ['march', 1]],
    1: [['hips', 0], ['march', 0], ['peace', 0], ['point', 0]],
    2: [['jump', 0], ['cheer', 0], ['armsout', 0], ['jump', 1]],
    3: [['step', 0], ['twist', 0], ['slide', 0], ['spin', 0], ['march', 0]]
  };
  var LANE_ANIM = ['stepL', 'duck', 'jump', 'stepR'];
  var FEVER_POSES = [['jump', 0], ['cheer', 0], ['twist', 0], ['spin', 1], ['armsout', 0], ['twist', 1]];
  var IDLE_POSES  = [['hips', 0], ['peace', 0], ['armsout', 0], ['point', 0], ['hips', 1], ['cheer', 0]];
  var laneTick = [0, 0, 0, 0], idleTick = 0;

  // one <img> per pose, built once. Reassigning src on a single element made
  // it "unavailable" until the new bitmap was ready - measured at ~4-6 swaps a
  // second, that showed up as the character blinking out mid-song.
  var poseEl = {}, curPose = null;
  (function buildPoses() {
    POSES.forEach(function (n) {
      var im = new Image();
      im.src = POSE_SRC[n];
      im.alt = '';
      im.draggable = false;
      if (im.decode) im.decode().catch(function () {});
      poseEl[n] = im;
      elPoses.appendChild(im);
    });
  })();

  function setPose(name, flip) {
    var el = poseEl[name] || poseEl.peace;
    if (el !== curPose) {
      if (curPose) curPose.classList.remove('on');
      el.classList.add('on');
      curPose = el;
    }
    el.classList.toggle('flip', !!flip);
  }
  function animate() {
    elDancer.className = 'dancer';
    void elDancer.offsetWidth;
    for (var i = 0; i < arguments.length; i++) elDancer.classList.add(arguments[i]);
  }
  // let the idle bob take over again once a step animation has played out
  elDancer.addEventListener('animationend', function () { elDancer.className = 'dancer'; });

  function pose(lane) {
    // every 25th combo step she breaks into a flourish instead
    if (S.combo > 0 && S.combo % 25 === 0) {
      setPose('back', (S.combo / 25) % 2); animate('twirl', 'hot');
      return;
    }
    var set = S.fever ? FEVER_POSES : LANE_POSES[lane];
    var e = set[laneTick[lane]++ % set.length];
    setPose(e[0], e[1]);
    if (S.fever) animate(LANE_ANIM[lane], 'hot');
    else animate(LANE_ANIM[lane]);
  }
  function poseIdle() {
    var e = IDLE_POSES[idleTick++ % IDLE_POSES.length];
    setPose(e[0], e[1]);
    animate('bob');
  }
  function poseMiss() { setPose('point', 0); animate('miss'); }

  /* ------------------------------ hud ------------------------------- */
  var PIP_N = 24;
  (function buildPips() {
    var h = '';
    for (var i = 0; i < PIP_N; i++) h += '<i></i>';
    elPips.innerHTML = h;
  })();
  (function buildSkyline() {
    var h = '';
    for (var i = 0; i < 26; i++) h += '<i></i>';
    elSkyline.innerHTML = h;
  })();
  var pips = elPips.children, bars = elSkyline.children;

  function updateHud() {
    elScore.textContent = String(Math.min(S.score, 9999999)).padStart(7, '0');
    elGroove.style.width = S.groove + '%';
    var lit = Math.round(S.groove / 100 * PIP_N);
    for (var i = 0; i < PIP_N; i++) {
      var p = pips[i];
      p.className = i < lit ? ('on' + (i > PIP_N * 0.75 ? ' hi' : i > PIP_N * 0.45 ? ' mid' : '')) : '';
    }
  }

  var skyPhase = [];
  for (var sb = 0; sb < 26; sb++) skyPhase.push(Math.random() * 6.28);
  function updateSkyline(t) {
    for (var i = 0; i < 26; i++) {
      var v = 0.5 + 0.5 * Math.sin(t * 5.2 + skyPhase[i] + i * 0.7);
      var h = 10 + v * (S.fever ? 86 : 60);
      bars[i].style.height = h + '%';
      bars[i].style.color = LANE_COLORS[(i + (S.fever ? 3 : 0)) % 4];
    }
  }

  /* -------------------------- scripted fx --------------------------- */
  function showBig(main, sub, ms) {
    elBig.innerHTML = '<b>' + main + '</b>' + (sub ? '<i>' + sub + '</i>' : '');
    elBig.classList.remove('show'); void elBig.offsetWidth; elBig.classList.add('show');
    if (ms) setTimeout(function () { elBig.classList.remove('show'); }, ms);
  }
  function showBanner(text, ms) {
    elBannerText.textContent = text;
    elBanner.classList.remove('show'); void elBanner.offsetWidth; elBanner.classList.add('show');
    setTimeout(function () { elBanner.classList.remove('show'); }, ms || 1700);
  }
  function showCount(txt) {
    elCount.innerHTML = '<b>' + txt + '</b>';
    elCount.classList.add('show');
    Snd.sfx('count');
    setTimeout(function () { elCount.classList.remove('show'); }, 700);
  }

  function buildTimeline() {
    var b = Snd.spb, bar = Snd.spbar, ev = [];
    ev.push({ t: 0.05, fn: function () { showBig('서영이와 춤을!', null, 1500); } });
    ev.push({ t: b * 2, fn: function () { showCount('3'); } });
    ev.push({ t: b * 4, fn: function () { showCount('2'); } });
    ev.push({ t: b * 6, fn: function () { showCount('1'); } });
    ev.push({ t: b * 8 - 0.12, fn: function () { showCount('GO!'); } });

    S.chart.warnBars.forEach(function (wb) {
      ev.push({ t: wb * bar + 0.02, fn: function () { showBanner('FEVER INCOMING!', 1600); } });
    });
    S.chart.feverBars.forEach(function (fb) {
      ev.push({ t: fb[0] * bar, fn: function () { setFever(true); } });
      ev.push({ t: fb[1] * bar, fn: function () { setFever(false); } });
    });
    var lastT = S.chart.notes.length ? S.chart.notes[S.chart.notes.length - 1].t : S.chart.duration;
    ev.push({ t: lastT + b * 2, fn: function () { finish(false); } });
    ev.sort(function (a, c) { return a.t - c.t; });
    S.events = ev;
  }

  function setFever(on) {
    if (S.fever === on) return;
    S.fever = on;
    app.classList.toggle('fever', on);
    if (on) { Snd.sfx('fever'); showBanner('FEVER TIME!  SCORE x2', 1400); }
  }

  /* ---------------------------- game loop --------------------------- */
  function tick() {
    S.rafId = requestAnimationFrame(tick);
    if (S.phase !== 'playing') return;

    var songT = Snd.time();

    // A long gap between frames means we were backgrounded, throttled, or the
    // device stuttered. Pause rather than burning every note that went by as a
    // miss — on a phone this is an incoming call, not bad play.
    if (S.lastFrameT !== null && songT - S.lastFrameT > 0.4) {
      S.lastFrameT = null;
      togglePause(true);
      return;
    }
    S.lastFrameT = songT;

    // scripted events
    while (S.events.length && S.events[0].t <= songT) S.events.shift().fn();

    // miss detection + cursor advance
    var notes = S.chart.notes;
    while (S.noteCursor < notes.length) {
      var n = notes[S.noteCursor];
      if (n.judged) { S.noteCursor++; continue; }
      if (songT - n.t > W_MISS) {
        n.judged = true; n.result = 'miss';
        applyResult('miss', null);
        S.noteCursor++;
        continue;
      }
      break;
    }

    // beat-driven idle motion
    var beat = Math.floor(songT / Snd.spb);
    if (beat !== S.lastBeat) {
      S.lastBeat = beat;
      if (beat >= 0 && beat % 2 === 0 && !elDancer.className.match(/step|jump|duck|miss|twirl/)) {
        poseIdle();
      }
    }

    // decay flashes
    for (var i = 0; i < 4; i++) {
      S.laneFlash[i] = S.held[i] ? 1 : Math.max(0, S.laneFlash[i] - 0.075);
      var padEl = padEls[i];
      padEl.classList.toggle('hit', S.laneFlash[i] > 0.35);
    }

    updateSkyline(songT);
    render(songT);
  }

  /* --------------------------- flow control ------------------------- */
  function startGame() {
    S.chart = Chart.build(S.difficulty, Snd.song);
    S.score = 0; S.combo = 0; S.maxCombo = 0;
    S.counts = { perfect: 0, great: 0, good: 0, bad: 0, miss: 0 };
    S.groove = 55; S.alive = true; S.noteCursor = 0;
    S.fx = []; S.laneFlash = [0, 0, 0, 0]; S.held = [false, false, false, false];
    S.lastBeat = -1; S.lastFrameT = null;
    setFever(false);
    elCombo.classList.remove('show');
    elJudge.className = 'judge';
    elBig.classList.remove('show');
    laneTick = [0, 0, 0, 0]; idleTick = 0;
    setPose('hips');
    updateHud();
    buildTimeline();
    layout();

    titleScreen.classList.remove('show');
    resultScreen.classList.remove('show');
    elPause.classList.add('show');
    elBpm.classList.add('beating');

    S.phase = 'playing';
    Snd.start(0.35);
    cancelAnimationFrame(S.rafId);
    tick();
  }

  function finish(failed) {
    if (S.phase !== 'playing') return;
    S.phase = 'result';
    elPause.classList.remove('show');
    elBpm.classList.remove('beating');
    setFever(false);
    Snd.stop();

    var hit = S.counts.perfect + S.counts.great + S.counts.good;
    var total = S.chart.total;
    var acc = total ? (S.counts.perfect + S.counts.great * 0.75 + S.counts.good * 0.4) / total : 0;
    var full = !failed && S.counts.miss === 0 && S.counts.bad === 0 && hit === total;

    if (failed) {
      showBig('STAGE', 'FAILED');
      setPose('point'); animate('miss');
    } else {
      showBig(full ? 'FULL COMBO!!' : 'STAGE CLEAR', full ? 'STAGE CLEAR' : null);
      setPose(full ? 'cheer' : 'peace'); animate('jump');
      Snd.sfx('clear');
    }

    setTimeout(function () {
      elBig.classList.remove('show');
      var rank = failed ? 'F'
        : acc >= 0.97 ? 'S' : acc >= 0.92 ? 'A' : acc >= 0.82 ? 'B' : acc >= 0.70 ? 'C' : 'D';
      $('resultTitle').textContent = failed ? 'STAGE FAILED' : (full ? 'FULL COMBO!!' : 'STAGE CLEAR');
      $('rankBadge').textContent = rank;
      $('rPerfect').textContent = S.counts.perfect;
      $('rGreat').textContent = S.counts.great;
      $('rGood').textContent = S.counts.good;
      $('rMiss').textContent = S.counts.miss + S.counts.bad;
      $('rCombo').textContent = S.maxCombo;
      $('rScore').textContent = String(S.score).padStart(7, '0');
      $('rAcc').textContent = (acc * 100).toFixed(1) + '%';
      resultScreen.querySelector('.ov-card').classList.toggle('fail', !!failed);
      resultScreen.classList.add('show');
    }, 2200);
  }

  function toTitle() {
    S.phase = 'title';
    Snd.stop();
    elPause.classList.remove('show');
    elBpm.classList.remove('beating');
    setFever(false);
    resultScreen.classList.remove('show');
    pauseScreen.classList.remove('show');
    elBig.classList.remove('show');
    elCombo.classList.remove('show');
    titleScreen.classList.add('show');
    setPose('peace');
  }

  function togglePause(on) {
    if (on && S.phase === 'playing') {
      S.pauseAt = Snd.time();
      S.phase = 'paused';
      Snd.pause();
      pauseScreen.classList.add('show');
    } else if (!on && S.phase === 'paused') {
      pauseScreen.classList.remove('show');
      S.phase = 'playing';
      S.lastFrameT = null;
      Snd.unpause(S.pauseAt);
    }
  }

  /* ------------------------------ input ----------------------------- */
  var padEls = Array.prototype.slice.call(document.querySelectorAll('.pad'));
  padEls.forEach(function (el, i) {
    el.addEventListener('pointerdown', function (e) {
      e.preventDefault();
      if (el.setPointerCapture) { try { el.setPointerCapture(e.pointerId); } catch (_) {} }
      press(i);
    });
    // capture keeps the matching pointerup on this pad even if the finger
    // slides off it, so a held pad can never get stuck lit
    var up = function (e) { e.preventDefault(); release(i); };
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
    el.addEventListener('contextmenu', function (e) { e.preventDefault(); });
  });

  document.addEventListener('keydown', function (e) {
    if (e.repeat) return;
    if (e.code === 'Escape' || e.code === 'KeyP') {
      togglePause(S.phase === 'playing');
      return;
    }
    if (e.code === 'Space' || e.code === 'Enter') {
      if (S.phase === 'title') { e.preventDefault(); begin(); }
      return;
    }
    var lane = KEYMAP[e.code];
    if (lane !== undefined) { e.preventDefault(); press(lane); }
  });
  document.addEventListener('keyup', function (e) {
    var lane = KEYMAP[e.code];
    if (lane !== undefined) release(lane);
  });

  // stop iOS rubber banding, but leave the overlay cards scrollable on short screens
  document.addEventListener('touchmove', function (e) {
    if (e.target && e.target.closest && e.target.closest('.overlay')) return;
    e.preventDefault();
  }, { passive: false });
  document.addEventListener('gesturestart', function (e) { e.preventDefault(); });

  /* --------------------------- title options ------------------------ */
  /* ------------------------- song selection ------------------------- */
  function stars(n) {
    var s = '';
    for (var i = 0; i < 4; i++) s += i < n ? '★' : '☆';
    return s;
  }

  function buildSongList() {
    elSongList.innerHTML = Snd.songs.map(function (sg, i) {
      return '<button class="song' + (i === 0 ? ' on' : '') + '" data-id="' + sg.id + '"' +
             ' style="--sa:' + sg.accent + '">' +
             '<span class="s-main"><b>' + sg.name + '</b><i>' + sg.genre + '</i></span>' +
             '<span class="s-meta"><b>' + sg.bpm + '<em>BPM</em></b><i>' + stars(sg.stars) + '</i></span>' +
             '</button>';
    }).join('');

    elSongList.addEventListener('click', function (e) {
      var b = e.target.closest('button.song');
      if (!b) return;
      Array.prototype.forEach.call(elSongList.children, function (c) { c.classList.remove('on'); });
      b.classList.add('on');
      Snd.init();
      applySong(b.dataset.id);
      Snd.resume().then(function () { Snd.sfx('preview', Snd.song); });
    });
  }

  /** point the engine, HUD and the tempo-driven CSS at a song */
  function applySong(id) {
    var sg = Snd.setSong(id);
    elSongTitle.textContent = sg.name;
    elBpmVal.textContent = sg.bpm;
    var root = document.documentElement.style;
    root.setProperty('--beat', Snd.spb.toFixed(4) + 's');
    root.setProperty('--bar', Snd.spbar.toFixed(4) + 's');
    root.setProperty('--accent', sg.accent);
    document.title = sg.name + ' ' + sg.bpm + ' — 서영이와 춤을!';
    return sg;
  }

  function seg(id, set) {
    var root = $(id);
    root.addEventListener('click', function (e) {
      var b = e.target.closest('button');
      if (!b) return;
      Array.prototype.forEach.call(root.children, function (c) { c.classList.remove('on'); });
      b.classList.add('on');
      set(b.dataset.v);
      Snd.init(); Snd.sfx('ui');
    });
  }
  seg('diffSeg',  function (v) { S.difficulty = v; });
  seg('dirSeg',   function (v) { S.scrollDir = v; layout(); });
  seg('speedSeg', function (v) { S.speedMult = parseFloat(v); layout(); });

  function begin() {
    Snd.init();
    Snd.resume().then(startGame);
  }

  $('startBtn').addEventListener('click', begin);
  $('retryBtn').addEventListener('click', function () { Snd.sfx('ui'); startGame(); });
  $('backBtn').addEventListener('click', function () { Snd.sfx('ui'); toTitle(); });
  $('resumeBtn').addEventListener('click', function () { togglePause(false); });
  $('quitBtn').addEventListener('click', function () { toTitle(); });
  elPause.addEventListener('click', function () { togglePause(true); });

  document.addEventListener('visibilitychange', function () {
    if (document.hidden && S.phase === 'playing') togglePause(true);
  });

  /* ----------------------------- boot ------------------------------- */
  buildSongList();
  applySong(Snd.songs[0].id);
  setPose('peace');   // stage shows her behind the title overlay
  layout();
  updateHud();
  // idle attract-mode breathing on the title screen
  (function attract() {
    requestAnimationFrame(attract);
    if (S.phase === 'title') {
      var t = performance.now() / 1000;
      updateSkyline(t);
      render(0);
    }
  })();
  setTimeout(layout, 300);
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(layout);
})();
