/*
 * ARCADE SHELL -- the public browser arcade frame.
 *
 * Separation of concerns: the shell owns everything that is NOT a game --
 * the dynamic manifest fetch, the picker, the cabinet frame, the scoreboard,
 * and a single input bus (keyboard + on-screen touch pad) that translates
 * device events into abstract actions. A game never touches the keyboard or
 * the DOM chrome; it registers a mechanic and receives actions. That keeps
 * every port composable -- the same contract for Chromafall, Heat Trail, Chess.
 *
 * Game contract (see js/games/chromafall.js):
 *   ArcadeShell.register(id, {
 *     title, controls: ['left','right','rotate','soft','drop'],
 *     create: function (host) { return instance; }
 *   });
 * Instance: { start(), stop(), action(name) }
 * Host (passed to create): { canvas, ctx, setScore, setStat, gameOver, palette }
 */
(function () {
  "use strict";

  var MANIFEST_URL = "data/manifest.json";

  var registry = {};       // id -> game definition
  var loaded = {};         // id -> true once its module script has run
  var active = null;       // current mounted instance
  var activeDef = null;
  var soloMode = false;    // true on game.html: one game, no picker

  // --- DOM handles -------------------------------------------------------
  var els = {};
  function $(id) { return document.getElementById(id); }

  // --- Public registration API (games call this) -------------------------
  var ArcadeShell = {
    register: function (id, def) { registry[id] = def; loaded[id] = true; }
  };
  window.ArcadeShell = ArcadeShell;

  // --- Boot: two surfaces, one shell -------------------------------------
  // index.html is the launcher (picker only). game.html?id=<id> is the game
  // host (one game, no picker) -- the launcher opens it in its own window.
  function boot() {
    cacheEls();
    var id = new URLSearchParams(window.location.search).get("id");
    if (id && els.surface) {
      soloMode = true;
      bootGame(id);
    } else {
      bootLauncher();
    }
  }

  function cacheEls() {
    els.picker = $("picker");
    els.grid = $("game-grid");
    els.cabinet = $("cabinet");
    els.title = $("cabinet-title");
    els.surface = $("surface");
    els.score = $("score-value");
    els.stats = $("stat-row");
    els.pad = $("control-pad");
    els.back = $("back-btn");
    els.tagline = $("arcade-tagline");
    if (els.back) { els.back.addEventListener("click", toPicker); }
  }

  function fetchManifest() {
    return fetch(MANIFEST_URL + "?v=" + Date.now()).then(function (r) { return r.json(); });
  }

  function bootLauncher() {
    if (!els.grid) { return; }
    fetchManifest().then(renderPicker).catch(function () {
      els.grid.innerHTML =
        '<p class="arcade-error">Could not load the game manifest.</p>';
    });
  }

  function bootGame(id) {
    fetchManifest().then(function (manifest) {
      var g = (manifest.games || []).filter(function (x) { return x.id === id; })[0];
      if (!g) {
        els.surface.innerHTML = '<p class="arcade-error">Unknown game: ' + esc(id) + "</p>";
        return;
      }
      document.title = (g.title || "Arcade");
      launch(g);
    }).catch(function () {
      els.surface.innerHTML = '<p class="arcade-error">Could not load the game.</p>';
    });
  }

  // Open a game in its own window (reused by name, so a new pick swaps it).
  function openGame(g) {
    if (window.ArcadeSFX) { window.ArcadeSFX.resume(); window.ArcadeSFX.play("select"); }
    announce(g.title);
    var url = "game.html?id=" + encodeURIComponent(g.id);
    var feats = "popup=yes,width=600,height=900,resizable=yes,scrollbars=no";
    var w = window.open(url, "arcade-game", feats);
    if (w) { w.focus(); } else { window.location.href = url; }
  }

  function renderPicker(manifest) {
    if (manifest.tagline && els.tagline) { els.tagline.textContent = manifest.tagline; }
    var games = (manifest.games || []).filter(function (g) {
      return g.status === "live";
    });
    els.grid.innerHTML = "";
    if (!games.length) {
      els.grid.innerHTML = '<p class="arcade-empty">No games live yet.</p>';
      return;
    }
    games.forEach(function (g) {
      // The card is a real <button> -- iOS Safari only fires tap->click reliably
      // on interactive elements, so an <article> here silently ignores taps.
      // Play is a styled <span> (a <button> can't nest inside a <button>).
      var card = document.createElement("button");
      card.className = "card game-card";
      card.type = "button";
      card.innerHTML =
        '<span class="card__header">' +
          '<span class="card__icon">' + esc(g.icon || "🎮") + "</span>" +
          '<span class="card__title">' + esc(g.title) + "</span>" +
        "</span>" +
        '<span class="card__body">' +
          '<span class="card__description">' + esc(g.blurb || "") + "</span>" +
        "</span>" +
        '<span class="card__actions">' +
          '<span class="btn btn--primary btn--sm">Play</span>' +
        "</span>";
      card.addEventListener("click", function () { openGame(g); });
      els.grid.appendChild(card);
    });
  }

  // --- Launch / mount ----------------------------------------------------
  function launch(g) {
    if (loaded[g.id]) { return mount(g); }
    var s = document.createElement("script");
    s.src = g.module + "?v=" + Date.now();
    s.onload = function () { mount(g); };
    s.onerror = function () {
      alert("Failed to load game: " + g.title);
    };
    document.body.appendChild(s);
  }

  function mount(g) {
    var def = registry[g.id];
    if (!def) { alert("Game did not register: " + g.id); return; }
    activeDef = def;

    els.title.textContent = def.title || g.title;
    els.score.textContent = "0";
    els.stats.innerHTML = "";

    // Fresh canvas each mount -- games own their pixels, not their chrome.
    els.surface.innerHTML = "";
    var canvas = document.createElement("canvas");
    canvas.className = "game-canvas";
    els.surface.appendChild(canvas);

    buildPad(def.controls || []);

    if (window.ArcadeSFX) { window.ArcadeSFX.resume(); }

    var host = makeHost(canvas);
    active = def.create(host);

    // Tap-driven games (e.g. Chess) receive canvas taps in CSS pixels; the game
    // maps pixels to its own grid. Games that don't define tap() ignore this.
    bindCanvasTap(canvas);

    if (els.picker) { show(els.cabinet, els.picker); }
    else if (els.cabinet) { els.cabinet.hidden = false; }
    // Size after the cabinet is visible so layout is measurable.
    if (active.resize) { active.resize(); }
    active.start();
    if (window.ArcadeSFX) { window.ArcadeSFX.play("start"); }
    announce("Go");
    bindKeys(true);
    bindResize(true);
  }

  function bindCanvasTap(canvas) {
    canvas.addEventListener("pointerdown", function (e) {
      if (!active || !active.tap) { return; }
      e.preventDefault();
      var r = canvas.getBoundingClientRect();
      active.tap(e.clientX - r.left, e.clientY - r.top, r.width, r.height);
    });
  }

  function toPicker() {
    bindKeys(false);
    bindResize(false);
    if (active && active.stop) { active.stop(); }
    active = null;
    activeDef = null;
    if (els.surface) { els.surface.innerHTML = ""; }
    // In its own window the game IS the window -- Menu closes it back to the
    // launcher. In a combined page, swap back to the picker.
    if (soloMode) { window.close(); return; }
    show(els.picker, els.cabinet);
  }

  // --- Host given to each game ------------------------------------------
  function makeHost(canvas) {
    var lastScore = null;
    return {
      canvas: canvas,
      ctx: canvas.getContext("2d"),
      sfx: window.ArcadeSFX || null,
      setScore: function (n) {
        els.score.textContent = String(n);
        if (lastScore != null && n > lastScore && window.ArcadeSFX) { window.ArcadeSFX.play("point"); }
        lastScore = n;
      },
      setStat: function (name, value) { renderStat(name, value); },
      gameOver: function (summary) { endCues(summary); showGameOver(summary); },
      palette: {}   // reserved for VRGB theme injection
    };
  }

  // Game end: a win/lose jingle + a spoken line (routed to cue-vox when hosted).
  function endCues(summary) {
    var title = (summary && summary.title) || "Game over";
    var win = /win|clear|complete|unfold/i.test(title);
    if (window.ArcadeSFX) { window.ArcadeSFX.play(win ? "win" : "lose"); }
    var first = (summary && summary.lines && summary.lines[0]) ? (". " + summary.lines[0]) : "";
    announce(title + first);
  }

  var statCells = {};
  function renderStat(name, value) {
    var cell = statCells[name];
    if (!cell) {
      cell = document.createElement("div");
      cell.className = "stat";
      cell.innerHTML =
        '<span class="stat__label">' + esc(name) + "</span>" +
        '<span class="stat__value"></span>';
      els.stats.appendChild(cell);
      statCells[name] = cell;
    }
    cell.querySelector(".stat__value").textContent = String(value);
  }

  function showGameOver(summary) {
    var over = document.createElement("div");
    over.className = "game-over";
    var lines = "";
    (summary.lines || []).forEach(function (l) {
      lines += "<li>" + esc(l) + "</li>";
    });
    over.innerHTML =
      '<div class="game-over__panel">' +
        '<h2 class="game-over__title">' + esc(summary.title || "Game Over") + "</h2>" +
        "<ul class=\"game-over__stats\">" + lines + "</ul>" +
        '<div class="game-over__actions">' +
          '<button class="btn btn--primary" id="go-again">Play again</button>' +
          '<button class="btn btn--secondary" id="go-menu">Menu</button>' +
        "</div>" +
      "</div>";
    els.surface.appendChild(over);
    $("go-again").addEventListener("click", function () {
      over.remove();
      if (active && active.stop) { active.stop(); }
      active = activeDef.create(makeHostFromCurrentCanvas());
      if (active.resize) { active.resize(); }
      active.start();
    });
    $("go-menu").addEventListener("click", toPicker);
  }

  function makeHostFromCurrentCanvas() {
    statCells = {};
    els.stats.innerHTML = "";
    els.score.textContent = "0";
    var canvas = els.surface.querySelector(".game-canvas");
    return makeHost(canvas);
  }

  // --- Input bus: keyboard + touch pad -> abstract actions ---------------
  // Default canonical map. A game may override via def.keymap (e.g. Chromafall
  // maps ArrowUp -> rotate). Keys are KeyboardEvent.key values.
  var DEFAULT_KEYMAP = {
    ArrowLeft: "left", ArrowRight: "right", ArrowUp: "up",
    ArrowDown: "down", " ": "action", Spacebar: "action"
  };

  function onKey(e) {
    var map = (activeDef && activeDef.keymap) || DEFAULT_KEYMAP;
    var a = map[e.key];
    if (!a) { return; }
    e.preventDefault();
    if (window.ArcadeSFX) { window.ArcadeSFX.resume(); }
    dispatch(a);
  }

  function bindKeys(on) {
    if (on) { document.addEventListener("keydown", onKey); }
    else { document.removeEventListener("keydown", onKey); }
  }

  function dispatch(action) {
    if (active && active.action) { active.action(action); }
  }

  // Refit the canvas when the visible viewport changes -- iOS Safari showing or
  // hiding its toolbar fires resize, as does rotation.
  function onResize() { if (active && active.resize) { active.resize(); } }
  function bindResize(on) {
    if (on) {
      window.addEventListener("resize", onResize);
      window.addEventListener("orientationchange", onResize);
    } else {
      window.removeEventListener("resize", onResize);
      window.removeEventListener("orientationchange", onResize);
    }
  }

  var LABELS = {
    left: "←", right: "→", up: "↑", down: "↓",
    rotate: "↺", soft: "↓", drop: "⤓", jump: "⤒", action: "●", shell: "◎"
  };
  // Which controls auto-repeat while the button is held down.
  var REPEATABLE = { left: 1, right: 1, down: 1, soft: 1, up: 1 };

  function buildPad(controls) {
    els.pad.innerHTML = "";
    // A full directional set lays out as a D-pad cross (left | up/down | right);
    // any other set stays a simple centered row.
    var isDpad = controls.indexOf("up") >= 0 && controls.indexOf("down") >= 0 &&
                 controls.indexOf("left") >= 0 && controls.indexOf("right") >= 0;
    els.pad.className = "control-pad" + (isDpad ? " control-pad--dpad" : "");
    controls.forEach(function (name) {
      var b = document.createElement("button");
      b.className = "pad-btn pad-btn--" + name;
      b.type = "button";
      b.textContent = LABELS[name] || name;
      b.setAttribute("aria-label", name);
      // Pointer events cover both touch and mouse; repeat while held for moves.
      var timer = null;
      var repeatable = !!REPEATABLE[name];
      b.addEventListener("pointerdown", function (e) {
        e.preventDefault();
        if (window.ArcadeSFX) { window.ArcadeSFX.resume(); }
        dispatch(name);
        if (repeatable) {
          timer = setInterval(function () { dispatch(name); }, 90);
        }
      });
      function release() {
        if (timer) { clearInterval(timer); timer = null; }
      }
      b.addEventListener("pointerup", release);
      b.addEventListener("pointerleave", release);
      b.addEventListener("pointercancel", release);
      els.pad.appendChild(b);
    });
  }

  // --- announce ----------------------------------------------------------
  // A short spoken cue for select / start / end. A host (maestro / cue-vox) can
  // take over by defining window.ArcadeAnnounce or listening for the postMessage;
  // standalone falls back to the browser's speech synth.
  function announce(text) {
    if (!text) { return; }
    var msg = { type: "arcade:announce", text: text };
    try { if (window.opener) { window.opener.postMessage(msg, "*"); } } catch (e) {}
    try { if (window.parent && window.parent !== window) { window.parent.postMessage(msg, "*"); } } catch (e) {}
    if (typeof window.ArcadeAnnounce === "function") {
      try { window.ArcadeAnnounce(text); return; } catch (e) {}
    }
    speak(text);
  }
  function speak(text) {
    if (!("speechSynthesis" in window)) { return; }
    try {
      var u = new SpeechSynthesisUtterance(text);
      u.rate = 1.0; u.pitch = 1.0; u.volume = 0.9;
      window.speechSynthesis.cancel();
      window.speechSynthesis.speak(u);
    } catch (e) {}
  }

  // --- helpers -----------------------------------------------------------
  function show(shown, hidden) {
    hidden.hidden = true;
    shown.hidden = false;
  }
  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  }

  document.addEventListener("DOMContentLoaded", boot);
})();
