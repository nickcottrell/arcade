/*
 * HEAT TRAIL -- browser port of roms/heat-trail.sh
 *
 * Snake meets thermal decay. The body IS the provenance chain: every segment
 * carries heat that cools over time, and COLD tail segments shed off the end.
 * Eat food to add a hot segment and reheat; stop eating and the chain cools,
 * shrinks, and eventually breaks. Die on a wall, on yourself, or when the
 * whole chain has cooled to nothing.
 *
 * Faithful to the ROM: same 30x15 arena (with walls), 3-segment start heated
 * [15,12,9], head-heat = prev-head + 1 (cap 20), food heat 5..15 with
 * score += foodHeat * length and +2 pending growth, tail removed each tick
 * unless growing, and every DECAY_RATE ticks a global -1 cool + cold-tail shed.
 *
 * Movement is on a TICK, not per animation frame. Steering only sets the next
 * direction; the tick applies it. The ROM's cue-mem token emissions have no
 * substrate here, so "eat"/"shed" become a visible heat pulse + a Chain stat.
 */
(function () {
  "use strict";

  var ARENA_W = 30;   // includes the wall columns 0 and W-1
  var ARENA_H = 15;   // includes the wall rows 0 and H-1

  var TICK_BASE = 200;   // ms per tick at level 1 (stty time 2 in the ROM)
  var TICK_MIN = 90;     // fastest tick floor
  var DECAY_RATE = 3;    // ticks between global cool steps

  // Direction: 0=up 1=right 2=down 3=left
  var DX = [0, 1, 0, -1];
  var DY = [-1, 0, 1, 0];

  window.ArcadeShell.register("trail", {
    title: "Heat Trail",
    controls: ["up", "down", "left", "right"],
    keymap: {
      ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right"
    },
    create: function (host) { return new Trail(host); }
  });

  function Trail(host) {
    this.host = host;
    this.ctx = host.ctx;
    this.canvas = host.canvas;

    // Snake body: parallel arrays, head = index 0.
    this.bx = [];
    this.by = [];
    this.heat = [];

    this.dir = 1;
    this.nextDir = 1;

    this.foodX = 0;
    this.foodY = 0;
    this.foodHeat = 0;

    this.score = 0;
    this.tick = 0;
    this.growAmount = 0;
    this.maxChain = 0;
    this.eatFlash = 0;   // ms of white-hot pulse after eating

    this.over = false;
    this._announced = false;

    this.raf = null;
    this.stopped = false;
    this.lastT = 0;
    this.acc = 0;

    this.cell = 16;      // px per cell, set in resize()
    this.sized = false;  // true once the surface is measurable

    this._initState();
  }

  Trail.prototype._initState = function () {
    var cx = Math.floor(ARENA_W / 2);
    var cy = Math.floor(ARENA_H / 2);
    this.bx = [cx, cx - 1, cx - 2];
    this.by = [cy, cy, cy];
    this.heat = [15, 12, 9];
    this.dir = 1;
    this.nextDir = 1;
    this.score = 0;
    this.tick = 0;
    this.growAmount = 0;
    this.maxChain = this.bx.length;
    this._spawnFood();
  };

  Trail.prototype._isBody = function (x, y) {
    for (var i = 0; i < this.bx.length; i++) {
      if (this.bx[i] === x && this.by[i] === y) { return true; }
    }
    return false;
  };

  Trail.prototype._spawnFood = function () {
    for (var attempts = 0; attempts < 200; attempts++) {
      var fx = 1 + Math.floor(Math.random() * (ARENA_W - 2));
      var fy = 1 + Math.floor(Math.random() * (ARENA_H - 2));
      if (!this._isBody(fx, fy)) {
        this.foodX = fx;
        this.foodY = fy;
        this.foodHeat = 5 + Math.floor(Math.random() * 11);  // 5..15
        return;
      }
    }
  };

  // --- Tick: one step of snake movement + thermal bookkeeping -------------
  Trail.prototype._step = function () {
    this.dir = this.nextDir;

    var hx = this.bx[0] + DX[this.dir];
    var hy = this.by[0] + DY[this.dir];

    // Wall collision (interior is 1..W-2 / 1..H-2).
    if (hx <= 0 || hx >= ARENA_W - 1 || hy <= 0 || hy >= ARENA_H - 1) {
      this.over = true;
      return;
    }
    // Self collision.
    if (this._isBody(hx, hy)) {
      this.over = true;
      return;
    }

    // Insert new head. New head heat = prev head heat + 1, capped at 20.
    var newHeat = this.heat[0] + 1;
    if (newHeat > 20) { newHeat = 20; }
    this.bx.unshift(hx);
    this.by.unshift(hy);
    this.heat.unshift(newHeat);

    // Eat food.
    if (hx === this.foodX && hy === this.foodY) {
      this.heat[0] = this.foodHeat;
      this.score += this.foodHeat * this.bx.length;
      this.growAmount += 2;
      this.eatFlash = 220;
      this._spawnFood();
    }

    // Remove tail unless growing.
    if (this.growAmount > 0) {
      this.growAmount -= 1;
    } else {
      this.bx.pop();
      this.by.pop();
      this.heat.pop();
    }

    // Thermal decay every DECAY_RATE ticks: cool all, shed cold tail.
    if (this.tick % DECAY_RATE === 0) {
      for (var i = 0; i < this.heat.length; i++) { this.heat[i] -= 1; }
      while (this.heat.length > 0 && this.heat[this.heat.length - 1] <= 0) {
        this.bx.pop();
        this.by.pop();
        this.heat.pop();
      }
      if (this.bx.length === 0) { this.over = true; }
    }

    if (this.bx.length > this.maxChain) { this.maxChain = this.bx.length; }
    this.tick += 1;
  };

  // Tick interval speeds up as the score climbs -- longer chain, faster clock.
  Trail.prototype._tickMs = function () {
    var lvl = this._level();
    var ms = TICK_BASE - (lvl - 1) * 12;
    if (ms < TICK_MIN) { ms = TICK_MIN; }
    return ms;
  };

  Trail.prototype._level = function () {
    return 1 + Math.floor(this.score / 200);
  };

  // --- Shell contract ----------------------------------------------------
  Trail.prototype.action = function (a) {
    if (this.over) { return; }
    // Steering only sets nextDir; the tick applies it. Reject a 180 reversal
    // into your own neck (compare against the committed direction).
    if (a === "up" && this.dir !== 2) { this.nextDir = 0; }
    else if (a === "down" && this.dir !== 0) { this.nextDir = 2; }
    else if (a === "right" && this.dir !== 3) { this.nextDir = 1; }
    else if (a === "left" && this.dir !== 1) { this.nextDir = 3; }
  };

  Trail.prototype._sync = function () {
    this.host.setScore(this.score);
    this.host.setStat("Chain", this.bx.length);
    this.host.setStat("Level", this._level());
  };

  Trail.prototype.start = function () {
    this._sync();
    var self = this;
    this.lastT = performance.now();
    var loop = function (t) {
      if (self.stopped) { return; }
      // Self-heal: don't run or draw until the surface has a real size.
      if (!self.sized && !self.resize()) {
        self.lastT = t;
        self.raf = requestAnimationFrame(loop);
        return;
      }
      var dt = t - self.lastT;
      self.lastT = t;

      if (!self.over) {
        self.acc += dt;
        var interval = self._tickMs();
        var guard = 0;
        while (self.acc >= interval && !self.over && guard < 8) {
          self.acc -= interval;
          self._step();
          guard++;
        }
        self._sync();
      }

      if (self.eatFlash > 0) {
        self.eatFlash -= dt;
        if (self.eatFlash < 0) { self.eatFlash = 0; }
      }

      self._draw();

      if (self.over && !self._announced) {
        self._announced = true;
        self.host.gameOver({
          title: "Chain Broken",
          lines: ["Score " + self.score,
                  "Max chain " + self.maxChain,
                  "Level " + self._level()]
        });
      }
      self.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  };

  Trail.prototype.stop = function () {
    this.stopped = true;
    if (this.raf) { cancelAnimationFrame(this.raf); this.raf = null; }
  };

  // Self-healing resize -- copied from chromafall.js structure.
  Trail.prototype.resize = function () {
    var surface = this.canvas.parentElement;
    if (!surface) { return false; }
    var maxW = surface.clientWidth;
    var maxH = surface.clientHeight;
    if (maxW < 20 || maxH < 20) { return false; }
    var cell = Math.floor(Math.min(maxW / ARENA_W, maxH / ARENA_H));
    if (cell < 4) { cell = 4; }
    this.cell = cell;
    var dpr = window.devicePixelRatio || 1;
    this.canvas.width = ARENA_W * cell * dpr;
    this.canvas.height = ARENA_H * cell * dpr;
    this.canvas.style.width = (ARENA_W * cell) + "px";
    this.canvas.style.height = (ARENA_H * cell) + "px";
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.sized = true;
    return true;
  };

  // Heat -> color band, matching the ROM's thresholds.
  //   >=12 hot (red)  >=8 warm (orange)  >=4 cool (cyan)  else cold (dim grey)
  function heatColor(h) {
    if (h >= 12) { return "hsl(0, 85%, 55%)"; }
    if (h >= 8) { return "hsl(28, 90%, 52%)"; }
    if (h >= 4) { return "hsl(200, 70%, 50%)"; }
    return "hsl(210, 12%, 34%)";
  }

  Trail.prototype._draw = function () {
    var ctx = this.ctx, c = this.cell;
    var w = ARENA_W * c, h = ARENA_H * c;

    ctx.fillStyle = "#0a0a0a";
    ctx.fillRect(0, 0, w, h);

    // Walls (blue border ring).
    ctx.fillStyle = "hsl(220, 60%, 42%)";
    for (var x = 0; x < ARENA_W; x++) {
      this._cellRect(x, 0);
      this._cellRect(x, ARENA_H - 1);
    }
    for (var y = 1; y < ARENA_H - 1; y++) {
      this._cellRect(0, y);
      this._cellRect(ARENA_W - 1, y);
    }

    // Food -- pulses between magenta and white on the tick clock.
    var foodBright = (this.tick % 4) < 2;
    ctx.fillStyle = foodBright ? "hsl(300, 80%, 62%)" : "#ffffff";
    this._dot(this.foodX, this.foodY);

    // Body: tail-first so the bright head paints on top.
    for (var i = this.bx.length - 1; i >= 0; i--) {
      if (i === 0) {
        // Head: bright green, or white-hot right after eating.
        ctx.fillStyle = this.eatFlash > 0 ? "#ffffff" : "hsl(140, 80%, 58%)";
      } else {
        ctx.fillStyle = heatColor(this.heat[i]);
      }
      this._cellRect(this.bx[i], this.by[i]);
    }
  };

  Trail.prototype._cellRect = function (x, y) {
    var c = this.cell;
    this.ctx.fillRect(x * c + 1, y * c + 1, c - 2, c - 2);
  };

  Trail.prototype._dot = function (x, y) {
    var c = this.cell;
    var pad = Math.max(1, Math.floor(c * 0.2));
    this.ctx.fillRect(x * c + pad, y * c + pad, c - pad * 2, c - pad * 2);
  };
})();
