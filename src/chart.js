/* =========================================================================
   chart.js - step charts for ARCADE DANCE
   Patterns are authored on a 16th-note grid against the same bar structure
   the arrangement in audio.js uses, so steps always land on the music.

   Grid legend (one char = one 16th note):
     -   rest          l d u r   single step on that pad
     x   L + R jump    y  D + U jump    z  L + D      w  U + R
   ========================================================================= */
(function (global) {
  'use strict';

  var L = 0, D = 1, U = 2, R = 3;
  var SYM = { l: [L], d: [D], u: [U], r: [R], x: [L, R], y: [D, U], z: [L, D], w: [U, R] };

  /* ---------------- pattern banks, one set per musical style ------------ */
  var BANKS = {
    synthwave: {
      verse:  ['l---d---u---r---', 'l---d---u---d---', 'r---u---d---l---', 'r---u---l-x-----'],
      build:  ['l-l-u---d-u-r---', 'r-r-u---d-u-l---', 'l-l-u---d-u-r---', 'y---x---u-d-r---'],
      chorus: ['l-u-d-r-u-l-r-d-', 'x---u-d-y---l-r-', 'l-r-u-d-r-l-d-u-', 'y---l-r-x---u-d-'],
      outro:  ['x---------------', 'y-------x-------']
    },
    // eurodance: downbeat then offbeat answer
    happy: {
      verse:  ['u---r---d---l---', 'u---r---d---r---', 'l---d---r---u---', 'l---d---u-x-----'],
      build:  ['u-u-r---d-r-l---', 'd-d-l---u-l-r---', 'u-u-r---d-r-l---', 'x---y---r-l-u---'],
      chorus: ['l---u-d-r---u-r-', 'x---d-u-r---l-u-', 'd---r-u-l---d-r-', 'y---l-r-x---u-d-'],
      outro:  ['x---------------', 'y-------x-------']
    },
    // city funk: syncopated, steps land off the grid
    funk: {
      verse:  ['l--d--u---r--u--', 'r--u--d---l--d--', 'l--d--u---r--l--', 'x--u--r---y-----'],
      build:  ['l--d-u-r--u-d---', 'r--u-d-l--d-u---', 'l--d-u-r--u-d---', 'x---u-d-y--l-r--'],
      chorus: ['l--d-u-r--u-d-r-', 'r--u-d-l--d-u-l-', 'l--r-u-d--r-l-u-', 'x---u-d-y---l-r-'],
      outro:  ['x-------y-------', 'x---------------']
    },
    // drum & bass: few notes per bar, but the bar goes by fast
    dnb: {
      verse:  ['l-------u-------', 'r-------d-------', 'u-------l-------', 'd-------r-------'],
      build:  ['l---u---d---r---', 'r---d---u---l---', 'l---u---d---r---', 'x---y---u-d-----'],
      chorus: ['l---u-d-r---u---', 'x---d---r-u-l---', 'd---r-u-l---d---', 'y---l-r-x---u---'],
      outro:  ['x-------y-------', 'x---------------']
    }
  };

  /* Minimum seconds between consecutive steps. Expressed against the beat as
     well as in absolute time, so a 174 BPM track never out-runs a thumb. */
  var GAP = {
    easy:   { beats: 0.75, floor: 0.34 },
    normal: { beats: 0.40, floor: 0.185 },
    hard:   { beats: 0.22, floor: 0.10 }   // must stay under a 16th, or HARD
  };                                       // collapses back into NORMAL

  /* ------------------------------------------------------------------ */
  function build(difficulty, song) {
    song = song || global.Snd.song;
    var spb = 60 / song.bpm, spbar = spb * 4, step16 = spb / 4;
    var bank = BANKS[song.style] || BANKS.synthwave;
    var map = song.map;

    /* -------- lay the patterns out over the song's section map -------- */
    var groups = [];                       // { t, lanes[], bar, step, kind }
    for (var mi = 0; mi < map.length; mi++) {
      var kind = map[mi][1];
      var from = map[mi][0];
      var to = (mi + 1 < map.length) ? map[mi + 1][0] : song.bars;
      var pats = bank[kind];
      if (!pats) continue;                 // intro / end carry no steps
      for (var bar = from; bar < to; bar++) {
        var pat = pats[(bar - from) % pats.length];
        for (var i = 0; i < 16; i++) {
          var ch = pat[i];
          if (!ch || ch === '-' || !SYM[ch]) continue;
          groups.push({
            t: (bar * 16 + i) * step16,
            lanes: SYM[ch].slice(),
            bar: bar, step: i, kind: kind
          });
        }
      }
    }
    groups.sort(function (a, b) { return a.t - b.t; });

    /* ----------------------- difficulty passes ------------------------ */
    if (difficulty === 'hard') {
      // 16th-note doubles trailing the downbeats of the busy sections
      var extra = [];
      groups.forEach(function (g) {
        if (g.kind !== 'chorus' && g.kind !== 'build') return;
        if (g.step % 4 !== 0 || g.lanes.length > 1) return;
        extra.push({ t: g.t + step16, lanes: [g.lanes[0]], bar: g.bar, step: g.step + 1, kind: g.kind });
      });
      groups = groups.concat(extra).sort(function (a, b) { return a.t - b.t; });
    }
    if (difficulty === 'easy') {
      // chords become single steps - alternate which pad survives so the
      // easy chart does not end up leaning on one side of the stage
      groups.forEach(function (g) {
        if (g.lanes.length > 1) g.lanes = [g.lanes[g.bar % g.lanes.length]];
      });
    }

    // density governor - thins whatever the patterns produced down to a rate
    // the chosen difficulty can actually be played at, whatever the BPM
    var gap = GAP[difficulty] || GAP.normal;
    var minGap = Math.max(gap.floor, gap.beats * spb);
    var kept = [], lastT = -1e9;
    groups.forEach(function (g) {
      if (g.t - lastT < minGap - 1e-6) return;
      kept.push(g); lastT = g.t;
    });

    /* ------------------------- flatten to notes ----------------------- */
    var notes = [], id = 0;
    kept.forEach(function (g) {
      g.lanes.forEach(function (lane) {
        notes.push({ id: id++, t: g.t, lane: lane, jump: g.lanes.length > 1, judged: false, result: null });
      });
    });
    notes.sort(function (a, b) { return a.t - b.t || a.lane - b.lane; });

    return {
      song: song,
      notes: notes,
      total: notes.length,
      duration: song.bars * spbar,
      feverBars: song.fever,
      warnBars: song.warn,
      difficulty: difficulty
    };
  }

  global.Chart = { build: build, LANES: { L: L, D: D, U: U, R: R }, BANKS: BANKS };
})(window);
