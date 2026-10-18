/*
 * ARCADE SFX -- a tiny WebAudio chiptune engine. 8-bit but CHILL: soft triangle
 * tones, gentle attack/decay (no clicks), low master gain. One shared palette so
 * every cabinet sounds like the same machine.
 *
 * Games call ArcadeSFX.play("jump") for flavor; the shell also auto-fires the
 * baseline cues (point on score-up, win/lose on game end, select/start on
 * launch). WebAudio needs a user gesture, so the shell calls resume() on the
 * first key/tap.
 */
(function (global) {
  "use strict";
  var AC = global.AudioContext || global.webkitAudioContext;
  var ctx = null, master = null, enabled = true;

  function ensure() {
    if (!AC) { return null; }
    if (!ctx) {
      ctx = new AC();
      master = ctx.createGain();
      master.gain.value = 0.15;   // chill: quiet by default
      master.connect(ctx.destination);
    }
    return ctx;
  }

  function resume() {
    var c = ensure();
    if (c && c.state === "suspended") { c.resume(); }
  }

  // One note. freq may be a number or [from, to] for a glide. Soft envelope.
  function note(o) {
    var c = ensure(); if (!c || !enabled) { return; }
    var t0 = c.currentTime + (o.delay || 0);
    var dur = o.dur || 0.12;
    var osc = c.createOscillator();
    var g = c.createGain();
    osc.type = o.wave || "triangle";
    if (Object.prototype.toString.call(o.freq) === "[object Array]") {
      osc.frequency.setValueAtTime(o.freq[0], t0);
      osc.frequency.exponentialRampToValueAtTime(Math.max(1, o.freq[1]), t0 + dur);
    } else {
      osc.frequency.setValueAtTime(o.freq, t0);
    }
    var peak = (o.gain == null ? 0.9 : o.gain);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(peak, t0 + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(g); g.connect(master);
    osc.start(t0); osc.stop(t0 + dur + 0.03);
  }

  function seq(notes) { for (var i = 0; i < notes.length; i++) { note(notes[i]); } }

  var RECIPES = {
    select: function () { note({ freq: 720, dur: 0.09, gain: 0.6 }); },
    start:  function () { seq([{ freq: 523, dur: 0.10, gain: 0.6 }, { freq: 784, dur: 0.14, gain: 0.6, delay: 0.10 }]); },
    point:  function () { seq([{ freq: 660, dur: 0.06, gain: 0.5 }, { freq: 988, dur: 0.08, gain: 0.5, delay: 0.05 }]); },
    jump:   function () { note({ wave: "square", freq: [330, 660], dur: 0.14, gain: 0.35 }); },
    shell:  function () { seq([{ freq: 520, dur: 0.07, gain: 0.45 }, { freq: 392, dur: 0.07, gain: 0.45, delay: 0.06 }, { freq: 698, dur: 0.12, gain: 0.45, delay: 0.12 }]); },
    land:   function () { note({ freq: 160, dur: 0.07, gain: 0.45 }); },
    hurt:   function () { note({ wave: "square", freq: [300, 110], dur: 0.22, gain: 0.35 }); },
    stomp:  function () { seq([{ freq: 200, dur: 0.06, gain: 0.45 }, { freq: 440, dur: 0.10, gain: 0.45, delay: 0.05 }]); },
    win:    function () { seq([{ freq: 523, dur: 0.12, gain: 0.55 }, { freq: 659, dur: 0.12, gain: 0.55, delay: 0.12 }, { freq: 784, dur: 0.12, gain: 0.55, delay: 0.24 }, { freq: 1046, dur: 0.24, gain: 0.55, delay: 0.36 }]); },
    lose:   function () { seq([{ freq: 440, dur: 0.14, gain: 0.45 }, { freq: 349, dur: 0.14, gain: 0.45, delay: 0.14 }, { freq: 262, dur: 0.30, gain: 0.45, delay: 0.28 }]); },
    blip:   function () { note({ freq: 880, dur: 0.05, gain: 0.3 }); }
  };

  global.ArcadeSFX = {
    play: function (name) { var r = RECIPES[name]; if (r) { try { r(); } catch (e) {} } },
    resume: resume,
    setEnabled: function (on) { enabled = !!on; },
    toggle: function () { enabled = !enabled; return enabled; }
  };

  // M mutes/unmutes the whole cabinet.
  if (global.addEventListener) {
    global.addEventListener("keydown", function (e) {
      if (e.key === "m" || e.key === "M") { global.ArcadeSFX.toggle(); }
    });
  }
})(typeof window !== "undefined" ? window : globalThis);
