/* =========================================================================
   audio.js - procedural soundtrack for 서영이와 춤을!
   Four tracks, each generated live with the Web Audio API. The chart is
   authored against the same beat grid, so notes and music can never drift
   apart (no media decoding / buffering jitter on any device).
   ========================================================================= */
(function (global) {
  'use strict';

  function mtof(m) { return 440 * Math.pow(2, (m - 69) / 12); }

  // Headroom: with pad + bass + lead + drums stacked in a chorus the bus was
  // peaking just over full scale, so the master sits well below unity.
  var MASTER_GAIN = 0.58;

  /* =======================================================================
     SONG BOOK
     map  - bar ranges and the arrangement section each one plays
     fever/warn - bars that drive the FEVER windows and their warning banner
     ======================================================================= */
  var SONGS = [
    {
      id: 'neon', name: 'NEON STEP', genre: 'SYNTHWAVE', bpm: 128, bars: 40,
      stars: 2, accent: '#ff2d95', style: 'synthwave',
      chords: [[57, 60, 64], [53, 57, 60], [48, 52, 55], [55, 59, 62]],   // Am F C G
      bass:   [33, 29, 36, 31],
      map: [[2, 'verse'], [10, 'build'], [14, 'chorus'], [22, 'verse'],
            [26, 'build'], [30, 'chorus'], [38, 'outro'], [40, 'end']],
      fever: [[14, 22], [30, 38]], warn: [13, 29]
    },
    {
      id: 'rocket', name: 'ROCKET POP', genre: 'EURODANCE', bpm: 150, bars: 48,
      stars: 3, accent: '#ffd21e', style: 'happy',
      chords: [[48, 52, 55], [55, 59, 62], [57, 60, 64], [53, 57, 60]],   // C G Am F
      bass:   [36, 31, 33, 29],
      map: [[2, 'verse'], [10, 'build'], [18, 'chorus'], [26, 'verse'],
            [30, 'build'], [38, 'chorus'], [46, 'outro'], [48, 'end']],
      fever: [[18, 26], [38, 46]], warn: [17, 37]
    },
    {
      id: 'city', name: 'CITY LIGHTS', genre: 'CITY FUNK', bpm: 112, bars: 36,
      stars: 1, accent: '#22e3ff', style: 'funk',
      chords: [[53, 57, 60, 64], [52, 55, 59, 62], [50, 53, 57, 60], [55, 59, 62, 65]],
      bass:   [29, 28, 26, 31],
      map: [[2, 'verse'], [10, 'build'], [14, 'chorus'], [22, 'verse'],
            [26, 'build'], [30, 'chorus'], [34, 'outro'], [36, 'end']],
      fever: [[14, 22], [30, 34]], warn: [13, 29]
    },
    {
      id: 'turbo', name: 'TURBO RUSH', genre: 'DRUM & BASS', bpm: 174, bars: 44,
      stars: 4, accent: '#4fe36b', style: 'dnb',
      chords: [[50, 53, 57], [46, 50, 53], [53, 57, 60], [48, 52, 55]],   // Dm Bb F C
      bass:   [26, 22, 29, 24],
      map: [[4, 'verse'], [12, 'build'], [20, 'chorus'], [28, 'verse'],
            [32, 'build'], [40, 'chorus'], [42, 'outro'], [44, 'end']],
      fever: [[20, 28], [40, 42]], warn: [19, 39]
    }
  ];

  var ARP = [0, 2, 1, 2, 0, 1, 2, 1];

  /* -----------------------------------------------------------------------
     Silent-switch handling (iOS)

     iOS plays Web Audio through the "ambient" audio session, which the ringer
     switch silences - so the game went quiet on a muted phone. Declaring
     playback intent moves it to the category that ignores the switch.
     Safari 16.4+ exposes navigator.audioSession for exactly this; older iOS
     needs an HTMLAudioElement to actually be playing, which flips the session
     category as a side effect.

     Because this overrides a hardware switch, the game carries its own mute
     button - see the speaker toggle in the HUD.
     ----------------------------------------------------------------------- */
  function silentWavUrl(seconds) {
    var sr = 8000, n = Math.round(sr * seconds);
    var buf = new ArrayBuffer(44 + n), v = new DataView(buf), i;
    function str(off, t) { for (var k = 0; k < t.length; k++) v.setUint8(off + k, t.charCodeAt(k)); }
    str(0, 'RIFF');  v.setUint32(4, 36 + n, true);
    str(8, 'WAVEfmt ');
    v.setUint32(16, 16, true);          // fmt chunk size
    v.setUint16(20, 1, true);           // PCM
    v.setUint16(22, 1, true);           // mono
    v.setUint32(24, sr, true);
    v.setUint32(28, sr, true);          // byte rate
    v.setUint16(32, 1, true);           // block align
    v.setUint16(34, 8, true);           // bits per sample
    str(36, 'data'); v.setUint32(40, n, true);
    for (i = 0; i < n; i++) v.setUint8(44 + i, 128);   // 8-bit silence
    return URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
  }

  /* ------------------------------------------------------------------ */
  var Snd = {
    ctx: null, master: null, musicBus: null, sfxBus: null, noise: null,
    _silent: null, muted: false,
    startedAt: 0, playing: false,
    _timer: null, _step: 0,

    song: SONGS[0],
    spb: 0, spbar: 0, duration: 0,

    songs: SONGS,

    /* ---------------------------------------------------------------- */
    init: function () {
      this.claimPlayback();
      if (this.ctx) return this.ctx;
      var AC = global.AudioContext || global.webkitAudioContext;
      var ctx = this.ctx = new AC();

      var comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -16; comp.knee.value = 22; comp.ratio.value = 9;
      comp.attack.value = 0.003;  comp.release.value = 0.2;

      this.master = ctx.createGain();   this.master.gain.value = MASTER_GAIN;
      this.musicBus = ctx.createGain(); this.musicBus.gain.value = 0.9;
      this.sfxBus = ctx.createGain();   this.sfxBus.gain.value = 0.7;

      this.musicBus.connect(comp); this.sfxBus.connect(comp);
      comp.connect(this.master); this.master.connect(ctx.destination);

      var n = ctx.sampleRate * 1.2, buf = ctx.createBuffer(1, n, ctx.sampleRate), d = buf.getChannelData(0);
      for (var i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
      this.noise = buf;
      return ctx;
    },

    resume: function () {
      this.claimPlayback();
      if (this.ctx && this.ctx.state === 'suspended') return this.ctx.resume();
      return Promise.resolve();
    },

    /** ask iOS for the audio session that ignores the ringer switch */
    claimPlayback: function () {
      try {
        if (global.navigator && navigator.audioSession) {
          navigator.audioSession.type = 'playback';   // Safari 16.4+
          return;
        }
      } catch (e) { /* not supported - fall through */ }

      if (this._silent) {                              // older iOS
        if (this._silent.paused) { var r = this._silent.play(); if (r && r.catch) r.catch(function () {}); }
        return;
      }
      try {
        var a = this._silent = new Audio(silentWavUrl(0.25));
        a.loop = true;
        a.volume = 0.001;
        a.setAttribute('playsinline', '');
        var p = a.play();
        if (p && p.catch) p.catch(function () {});
      } catch (e2) { this._silent = null; }
    },

    setSong: function (id) {
      for (var i = 0; i < SONGS.length; i++) if (SONGS[i].id === id) this.song = SONGS[i];
      var s = this.song;
      this.spb = 60 / s.bpm;
      this.spbar = this.spb * 4;
      this.duration = s.bars * this.spbar;
      return s;
    },

    /** arrangement section playing at this bar */
    sectionAt: function (bar) {
      var m = this.song.map;
      if (bar < m[0][0]) return 'intro';
      for (var i = 0; i < m.length; i++) if (bar < m[i][0]) return m[i - 1 < 0 ? 0 : i - 1][1];
      return 'end';
    },

    setMuted: function (m) {
      this.muted = !!m;
      if (this.master) this.master.gain.value = m ? 0 : MASTER_GAIN;
      try { localStorage.setItem('ad_muted', m ? '1' : '0'); } catch (e) {}
      return this.muted;
    },

    loadMuted: function () {
      try { this.muted = localStorage.getItem('ad_muted') === '1'; } catch (e) { this.muted = false; }
      if (this.master) this.master.gain.value = this.muted ? 0 : MASTER_GAIN;
      return this.muted;
    },

    /** song position in seconds (negative during the lead-in) */
    time: function () { return this.ctx ? this.ctx.currentTime - this.startedAt : 0; },

    /* ---------------------------------------------------------------- */
    start: function (leadIn) {
      this.init();
      this.startedAt = this.ctx.currentTime + (leadIn || 0.12);
      this._step = 0; this.playing = true;
      var self = this;
      clearInterval(this._timer);
      this._timer = setInterval(function () { self._schedule(); }, 25);
      this._schedule();
    },

    stop: function () {
      this.playing = false;
      clearInterval(this._timer); this._timer = null;
      if (this.musicBus && this.ctx) {
        var g = this.musicBus.gain, t = this.ctx.currentTime;
        g.cancelScheduledValues(t); g.setValueAtTime(g.value, t);
        g.linearRampToValueAtTime(0, t + 0.25);
        var self = this;
        setTimeout(function () { if (self.musicBus) self.musicBus.gain.value = 0.9; }, 320);
      }
    },

    pause: function () {
      this.playing = false;
      clearInterval(this._timer); this._timer = null;
      if (this.musicBus) this.musicBus.gain.value = 0;
    },

    unpause: function (songPos) {
      if (!this.ctx) return;
      this.musicBus.gain.value = 0.9;
      this.startedAt = this.ctx.currentTime - songPos;
      this._step = Math.max(0, Math.ceil(songPos / (this.spb / 4)));
      this.playing = true;
      var self = this;
      clearInterval(this._timer);
      this._timer = setInterval(function () { self._schedule(); }, 25);
    },

    /* ------------------------- the scheduler -------------------------- */
    _schedule: function () {
      if (!this.playing) return;
      var step16 = this.spb / 4;
      var ahead = this.ctx.currentTime + 0.14;
      while (this.startedAt + this._step * step16 < ahead) {
        var t = this.startedAt + this._step * step16;
        if (t >= this.ctx.currentTime - 0.01) this._voiceStep(this._step, t);
        this._step++;
        if (this._step * step16 > this.duration + 2) { this.playing = false; break; }
      }
    },

    /** one 16th-note tick of the arrangement */
    _voiceStep: function (s, t) {
      var song = this.song;
      var bar = Math.floor(s / 16), inBar = s % 16;
      var sec = this.sectionAt(bar);
      var chord = song.chords[bar % song.chords.length];
      var root = song.bass[bar % song.bass.length];
      var hot = (sec === 'chorus');
      var on = (sec === 'verse' || sec === 'build' || sec === 'chorus');

      this._drums(song.style, sec, inBar, bar, t, hot, on);

      // riser into every chorus
      var m = song.map;
      for (var i = 0; i < m.length; i++) {
        if (m[i][1] === 'chorus' && bar === m[i][0] - 1 && inBar === 0) this.riser(t, this.spbar);
      }

      if (on) this._bass(song.style, root, inBar, t, hot);

      if (inBar === 0 && on) {
        this.pad(t, chord, this.spbar * 0.96, hot ? 0.13 : 0.095, song.style);
      }

      this._lead(song.style, chord, sec, inBar, t, hot);
    },

    /* ----------------------- style: drums ----------------------------- */
    _drums: function (style, sec, i, bar, t, hot, on) {
      if (sec === 'intro') {
        if (i % 4 === 0) this.kick(t, 0.6);
        if (i % 4 === 2) this.hat(t, 0.12, 0.03);
        return;
      }
      if (sec === 'outro' || sec === 'end') {
        if (i % 8 === 0) this.kick(t, 0.9);
        if (bar === this.song.bars - 2 && i === 0) this.crash(t);
        return;
      }
      if (!on) return;

      if (style === 'synthwave') {
        if (i % 4 === 0) this.kick(t, hot ? 1 : 0.85);
        if (i === 4 || i === 12) this.snare(t, hot ? 0.9 : 0.7);
        if (sec !== 'verse' && i === 14) this.snare(t, 0.4);
        if (i % 2 === 1) this.hat(t, hot ? 0.26 : 0.17, 0.028);
        if (hot && i % 4 === 2) this.hat(t, 0.2, 0.05);

      } else if (style === 'happy') {
        if (i % 4 === 0) this.kick(t, hot ? 1.05 : 0.9);
        if (i === 4 || i === 12) this.clap(t, hot ? 0.75 : 0.6);
        if (i % 4 === 2) this.hat(t, hot ? 0.3 : 0.2, 0.07);           // open hat offbeat
        if (i % 2 === 1 && i % 4 !== 2) this.hat(t, 0.13, 0.02);
        if (hot && i === 14) this.kick(t, 0.8);

      } else if (style === 'funk') {
        if (i === 0 || i === 6 || i === 10) this.kick(t, i === 0 ? 0.95 : 0.7);
        if (i === 4 || i === 12) this.snare(t, hot ? 0.8 : 0.65);
        if (i % 2 === 1) this.hat(t, 0.16, 0.022);
        if (hot && (i === 7 || i === 15)) this.hat(t, 0.24, 0.06);
        if (i === 14) this.snare(t, 0.25);

      } else if (style === 'dnb') {
        if (i === 0 || i === 10) this.kick(t, 1.0);
        if (i === 8) this.snare(t, 0.9);
        if (hot && i === 14) this.snare(t, 0.5);
        if (i % 4 === 2) this.hat(t, hot ? 0.22 : 0.15, 0.025);
        if (hot && i === 6) this.hat(t, 0.18, 0.05);
      }
    },

    /* ----------------------- style: bass ------------------------------ */
    _bass: function (style, root, i, t, hot) {
      if (style === 'synthwave') {
        var pat = hot ? [0, 3, 6, 8, 11, 14] : [0, 6, 8, 14];
        if (pat.indexOf(i) >= 0) this.bass(t, mtof(root + 12 + (i === 8 && hot ? 12 : 0)), 0.22, hot ? 0.5 : 0.42);

      } else if (style === 'happy') {
        if (i % 4 === 2) this.bass(t, mtof(root + 12), 0.14, hot ? 0.52 : 0.42);   // offbeat stabs
        if (i === 0) this.bass(t, mtof(root), 0.2, 0.5);

      } else if (style === 'funk') {
        var p = [0, 3, 6, 7, 10, 13];
        if (p.indexOf(i) >= 0) this.bass(t, mtof(root + 12 + (i === 7 ? 7 : 0)), 0.13, 0.5, true);

      } else if (style === 'dnb') {
        if (i === 0 || i === 10) this.reese(t, mtof(root + 12), i === 0 ? 0.6 : 0.34, hot ? 0.4 : 0.3);
      }
    },

    /* ----------------------- style: lead ------------------------------ */
    _lead: function (style, chord, sec, i, t, hot) {
      if (sec !== 'build' && sec !== 'chorus') {
        if (sec === 'verse' && i % 8 === 0) this.pluck(t, mtof(chord[0] + 12), 0.1, style);
        return;
      }
      if (style === 'happy') {
        if (i % 2 === 0) {
          var a = ARP[(i / 2) % ARP.length];
          this.pluck(t, mtof(chord[a] + 24), hot ? 0.17 : 0.12, style);
        }
        if (hot && i % 8 === 0) this.stab(t, chord, 0.2, 0.1);

      } else if (style === 'funk') {
        if (i === 0 || i === 6 || i === 10) this.stab(t, chord, 0.26, hot ? 0.11 : 0.08);
        if (hot && i % 4 === 2) this.pluck(t, mtof(chord[(i / 2) % chord.length] + 12), 0.1, style);

      } else if (style === 'dnb') {
        if (i === 0 || i === 8) this.stab(t, chord, 0.3, hot ? 0.12 : 0.09);
        if (hot && (i === 4 || i === 12)) this.pluck(t, mtof(chord[2] + 24), 0.13, style);

      } else {
        if (i % 2 === 0) {
          var b = ARP[(i / 2) % ARP.length];
          this.pluck(t, mtof(chord[b] + 12 + (hot ? 12 : 0)), hot ? 0.2 : 0.14, style);
        }
      }
    },

    /* ---------------------------- voices ----------------------------- */
    kick: function (t, g) {
      var c = this.ctx, o = c.createOscillator(), a = c.createGain();
      o.type = 'sine';
      o.frequency.setValueAtTime(160, t);
      o.frequency.exponentialRampToValueAtTime(44, t + 0.09);
      a.gain.setValueAtTime(0, t);
      a.gain.linearRampToValueAtTime(g, t + 0.004);
      a.gain.exponentialRampToValueAtTime(0.0001, t + 0.34);
      o.connect(a); a.connect(this.musicBus); o.start(t); o.stop(t + 0.36);
      var n = c.createBufferSource(), nf = c.createBiquadFilter(), ng = c.createGain();
      n.buffer = this.noise; nf.type = 'highpass'; nf.frequency.value = 1200;
      ng.gain.setValueAtTime(g * 0.25, t);
      ng.gain.exponentialRampToValueAtTime(0.0001, t + 0.02);
      n.connect(nf); nf.connect(ng); ng.connect(this.musicBus); n.start(t); n.stop(t + 0.03);
    },

    snare: function (t, g) {
      var c = this.ctx;
      var n = c.createBufferSource(), f = c.createBiquadFilter(), a = c.createGain();
      n.buffer = this.noise; f.type = 'bandpass'; f.frequency.value = 1900; f.Q.value = 0.7;
      a.gain.setValueAtTime(g, t);
      a.gain.exponentialRampToValueAtTime(0.0001, t + 0.17);
      n.connect(f); f.connect(a); a.connect(this.musicBus); n.start(t); n.stop(t + 0.2);
      var o = c.createOscillator(), og = c.createGain();
      o.type = 'triangle'; o.frequency.setValueAtTime(220, t);
      o.frequency.exponentialRampToValueAtTime(140, t + 0.1);
      og.gain.setValueAtTime(g * 0.35, t);
      og.gain.exponentialRampToValueAtTime(0.0001, t + 0.11);
      o.connect(og); og.connect(this.musicBus); o.start(t); o.stop(t + 0.13);
    },

    /* layered noise bursts - brighter and wider than the snare */
    clap: function (t, g) {
      var c = this.ctx;
      for (var k = 0; k < 3; k++) {
        var tt = t + k * 0.011;
        var n = c.createBufferSource(), f = c.createBiquadFilter(), a = c.createGain();
        n.buffer = this.noise;
        f.type = 'bandpass'; f.frequency.value = 1500 + k * 420; f.Q.value = 1.1;
        a.gain.setValueAtTime(g * (k === 2 ? 1 : 0.55), tt);
        a.gain.exponentialRampToValueAtTime(0.0001, tt + (k === 2 ? 0.2 : 0.045));
        n.connect(f); f.connect(a); a.connect(this.musicBus);
        n.start(tt); n.stop(tt + 0.22);
      }
    },

    hat: function (t, g, dur) {
      var c = this.ctx;
      var n = c.createBufferSource(), f = c.createBiquadFilter(), a = c.createGain();
      n.buffer = this.noise; f.type = 'highpass'; f.frequency.value = 7200;
      a.gain.setValueAtTime(g, t);
      a.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      n.connect(f); f.connect(a); a.connect(this.musicBus); n.start(t); n.stop(t + dur + 0.02);
    },

    crash: function (t) {
      var c = this.ctx;
      var n = c.createBufferSource(), f = c.createBiquadFilter(), a = c.createGain();
      n.buffer = this.noise; f.type = 'highpass'; f.frequency.value = 4000;
      a.gain.setValueAtTime(0.5, t);
      a.gain.exponentialRampToValueAtTime(0.0001, t + 1.4);
      n.connect(f); f.connect(a); a.connect(this.musicBus); n.start(t); n.stop(t + 1.5);
    },

    bass: function (t, f, dur, g, snappy) {
      var c = this.ctx;
      var o = c.createOscillator(), o2 = c.createOscillator();
      var flt = c.createBiquadFilter(), a = c.createGain();
      o.type = 'sawtooth'; o.frequency.value = f;
      o2.type = 'square'; o2.frequency.value = f / 2; o2.detune.value = 6;
      flt.type = 'lowpass';
      flt.frequency.setValueAtTime(snappy ? 420 : 260, t);
      flt.frequency.exponentialRampToValueAtTime(snappy ? 2600 : 1500, t + (snappy ? 0.025 : 0.05));
      flt.frequency.exponentialRampToValueAtTime(320, t + dur);
      flt.Q.value = snappy ? 11 : 7;
      a.gain.setValueAtTime(0, t);
      a.gain.linearRampToValueAtTime(g, t + 0.01);
      a.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(flt); o2.connect(flt); flt.connect(a); a.connect(this.musicBus);
      o.start(t); o2.start(t); o.stop(t + dur + 0.02); o2.stop(t + dur + 0.02);
    },

    /* detuned saw pair sweeping a resonant lowpass - the drum & bass growl */
    reese: function (t, f, dur, g) {
      var c = this.ctx, flt = c.createBiquadFilter(), a = c.createGain();
      flt.type = 'lowpass'; flt.Q.value = 9;
      flt.frequency.setValueAtTime(220, t);
      flt.frequency.exponentialRampToValueAtTime(1500, t + dur * 0.45);
      flt.frequency.exponentialRampToValueAtTime(260, t + dur);
      a.gain.setValueAtTime(0, t);
      a.gain.linearRampToValueAtTime(g, t + 0.015);
      a.gain.setValueAtTime(g, t + dur * 0.8);
      a.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      flt.connect(a); a.connect(this.musicBus);
      [-14, 0, 13].forEach(function (d) {
        var o = c.createOscillator();
        o.type = 'sawtooth'; o.frequency.value = f; o.detune.value = d;
        o.connect(flt); o.start(t); o.stop(t + dur + 0.03);
      });
    },

    pluck: function (t, f, g, style) {
      var c = this.ctx;
      var o = c.createOscillator(), o2 = c.createOscillator();
      var flt = c.createBiquadFilter(), a = c.createGain(), dly = c.createDelay(), fb = c.createGain();
      o.type = style === 'funk' ? 'triangle' : 'square'; o.frequency.value = f;
      o2.type = 'sawtooth'; o2.frequency.value = f; o2.detune.value = style === 'happy' ? 16 : 11;
      flt.type = 'lowpass';
      flt.frequency.setValueAtTime(style === 'happy' ? 6400 : 5200, t);
      flt.frequency.exponentialRampToValueAtTime(900, t + 0.26);
      a.gain.setValueAtTime(0, t);
      a.gain.linearRampToValueAtTime(g, t + 0.006);
      a.gain.exponentialRampToValueAtTime(0.0001, t + 0.3);
      dly.delayTime.value = this.spb * 0.75; fb.gain.value = 0.26;
      o.connect(flt); o2.connect(flt); flt.connect(a);
      a.connect(this.musicBus);
      a.connect(dly); dly.connect(fb); fb.connect(dly); dly.connect(this.musicBus);
      o.start(t); o2.start(t); o.stop(t + 0.33); o2.stop(t + 0.33);
    },

    /* short bright chord hit */
    stab: function (t, notes, dur, g) {
      var c = this.ctx, flt = c.createBiquadFilter(), a = c.createGain();
      flt.type = 'lowpass'; flt.Q.value = 2;
      flt.frequency.setValueAtTime(4800, t);
      flt.frequency.exponentialRampToValueAtTime(700, t + dur);
      a.gain.setValueAtTime(0, t);
      a.gain.linearRampToValueAtTime(g, t + 0.008);
      a.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      flt.connect(a); a.connect(this.musicBus);
      notes.forEach(function (nn) {
        [-6, 6].forEach(function (d) {
          var o = c.createOscillator();
          o.type = 'sawtooth'; o.frequency.value = mtof(nn + 12); o.detune.value = d;
          o.connect(flt); o.start(t); o.stop(t + dur + 0.03);
        });
      });
    },

    pad: function (t, notes, dur, g, style) {
      var c = this.ctx, flt = c.createBiquadFilter(), a = c.createGain();
      flt.type = 'lowpass'; flt.frequency.value = style === 'funk' ? 2400 : 1700; flt.Q.value = 0.6;
      a.gain.setValueAtTime(0, t);
      a.gain.linearRampToValueAtTime(g, t + 0.25);
      a.gain.setValueAtTime(g, t + dur * 0.65);
      a.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      flt.connect(a); a.connect(this.musicBus);
      for (var i = 0; i < notes.length; i++) {
        for (var d = -1; d <= 1; d += 2) {
          var o = c.createOscillator();
          o.type = style === 'funk' ? 'triangle' : 'sawtooth';
          o.frequency.value = mtof(notes[i] + 12);
          o.detune.value = d * 7;
          o.connect(flt); o.start(t); o.stop(t + dur + 0.05);
        }
      }
    },

    riser: function (t, dur) {
      var c = this.ctx;
      var n = c.createBufferSource(), f = c.createBiquadFilter(), a = c.createGain();
      n.buffer = this.noise; n.loop = true;
      f.type = 'bandpass'; f.Q.value = 3;
      f.frequency.setValueAtTime(400, t);
      f.frequency.exponentialRampToValueAtTime(9000, t + dur);
      a.gain.setValueAtTime(0.001, t);
      a.gain.exponentialRampToValueAtTime(0.3, t + dur * 0.92);
      a.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      n.connect(f); f.connect(a); a.connect(this.musicBus); n.start(t); n.stop(t + dur + 0.05);
    },

    /* ----------------------------- SFX ------------------------------- */
    sfx: function (kind, arg) {
      if (!this.ctx) return;
      var c = this.ctx, t = c.currentTime, o, a, f, self = this;

      if (kind === 'perfect' || kind === 'great' || kind === 'good') {
        var base = kind === 'perfect' ? 1320 : kind === 'great' ? 990 : 740;
        o = c.createOscillator(); a = c.createGain();
        o.type = kind === 'perfect' ? 'square' : 'triangle';
        o.frequency.setValueAtTime(base, t);
        o.frequency.exponentialRampToValueAtTime(base * 1.6, t + 0.05);
        a.gain.setValueAtTime(0.16, t);
        a.gain.exponentialRampToValueAtTime(0.0001, t + 0.09);
        o.connect(a); a.connect(this.sfxBus); o.start(t); o.stop(t + 0.1);
        return;
      }
      if (kind === 'miss') {
        o = c.createOscillator(); a = c.createGain(); f = c.createBiquadFilter();
        o.type = 'sawtooth';
        o.frequency.setValueAtTime(190, t);
        o.frequency.exponentialRampToValueAtTime(70, t + 0.18);
        f.type = 'lowpass'; f.frequency.value = 900;
        a.gain.setValueAtTime(0.2, t);
        a.gain.exponentialRampToValueAtTime(0.0001, t + 0.2);
        o.connect(f); f.connect(a); a.connect(this.sfxBus); o.start(t); o.stop(t + 0.22);
        return;
      }
      if (kind === 'ui') {
        o = c.createOscillator(); a = c.createGain();
        o.type = 'square'; o.frequency.setValueAtTime(680, t);
        a.gain.setValueAtTime(0.1, t);
        a.gain.exponentialRampToValueAtTime(0.0001, t + 0.07);
        o.connect(a); a.connect(this.sfxBus); o.start(t); o.stop(t + 0.08);
        return;
      }
      // short taste of a track when it is picked on the song list
      if (kind === 'preview') {
        var song = arg || this.song, sp = 60 / song.bpm;
        song.chords[0].forEach(function (nn, k) {
          var oo = c.createOscillator(), aa = c.createGain();
          oo.type = 'sawtooth'; oo.frequency.value = mtof(nn + 12); oo.detune.value = k * 5;
          aa.gain.setValueAtTime(0, t);
          aa.gain.linearRampToValueAtTime(0.09, t + 0.02);
          aa.gain.exponentialRampToValueAtTime(0.0001, t + 0.45);
          oo.connect(aa); aa.connect(self.sfxBus); oo.start(t); oo.stop(t + 0.5);
        });
        for (var kk = 0; kk < 4; kk++) this.kick(t + kk * sp, 0.5);
        return;
      }
      if (kind === 'fever') {
        [0, 4, 7, 12, 16, 19].forEach(function (semi, i) {
          var oo = c.createOscillator(), aa = c.createGain();
          oo.type = 'square'; oo.frequency.value = mtof(69 + semi);
          var tt = t + i * 0.055;
          aa.gain.setValueAtTime(0, tt);
          aa.gain.linearRampToValueAtTime(0.14, tt + 0.01);
          aa.gain.exponentialRampToValueAtTime(0.0001, tt + 0.22);
          oo.connect(aa); aa.connect(self.sfxBus); oo.start(tt); oo.stop(tt + 0.24);
        });
        return;
      }
      if (kind === 'count') {
        o = c.createOscillator(); a = c.createGain();
        o.type = 'square'; o.frequency.setValueAtTime(440, t);
        a.gain.setValueAtTime(0.18, t);
        a.gain.exponentialRampToValueAtTime(0.0001, t + 0.16);
        o.connect(a); a.connect(this.sfxBus); o.start(t); o.stop(t + 0.18);
        return;
      }
      if (kind === 'clear') {
        [0, 4, 7, 12].forEach(function (semi, i) {
          var oo = c.createOscillator(), aa = c.createGain();
          oo.type = 'triangle'; oo.frequency.value = mtof(72 + semi);
          var tt = t + i * 0.1;
          aa.gain.setValueAtTime(0, tt);
          aa.gain.linearRampToValueAtTime(0.2, tt + 0.02);
          aa.gain.exponentialRampToValueAtTime(0.0001, tt + 0.6);
          oo.connect(aa); aa.connect(self.sfxBus); oo.start(tt); oo.stop(tt + 0.65);
        });
      }
    }
  };

  Snd.setSong('neon');
  global.Snd = Snd;
  global.SONGS = SONGS;
})(window);
