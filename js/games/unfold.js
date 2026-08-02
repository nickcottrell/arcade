/*
 * UNFOLD -- browser port of roms/unfold.sh
 *
 * Dimensional box-expansion platformer. You start in a tiny box; collect every
 * jewel to open the exit, reach it, and the walls dissolve so the room UNFOLDS
 * into a larger dimension. Five dimensions, each wider and taller, each hue
 * walking the color wheel (0 -> 30 -> 60 -> 120 -> 210).
 *
 * Faithful to the ROM:
 *   - Same DIM tables (widths, heights, hues, jewel/platform/enemy counts,
 *     gravity flag). Dim 0 is the flat no-gravity starter box.
 *   - Platforms thermally DECAY: heat 3(hot) -> 2(warm) -> 1(cold) -> gone,
 *     the same 5-heat cooling color ramp, then the cell drops out from under you.
 *   - Jump reaches ~3 cells up (ROM PVY=-3). Gravity accelerates to a terminal
 *     fall. Enemies patrol platforms, turn at edges/walls; stomp from above kills
 *     one (bounce), side/level contact costs a life. 3 lives.
 *   - Jewel pickup builds a chain multiplier; all jewels -> exit portal.
 *
 * The ROM emits cue-mem tokens (jewel/hit/stomp/unfold) hex-addressed by hue.
 * The public arcade has no substrate, so those become visible flashes + the
 * score/chain feel. VRGB identity kept as feel, not as a side effect.
 *
 * Physics run on a fixed-timestep accumulator so jump/gravity feel is stable on
 * a phone regardless of frame rate. The grid is discrete (like the ROM) but the
 * step cadence is time-based, not frame-based.
 */
(function () {
  "use strict";

  // Dimension tables, ported verbatim from the ROM.
  var DIM_W = [10, 16, 24, 32, 40];
  var DIM_H = [6, 10, 14, 18, 22];
  var DIM_HUE = [0, 30, 60, 120, 210];
  var DIM_JEWELS = [3, 6, 10, 16, 24];
  var DIM_PLATS = [0, 3, 5, 8, 12];
  var DIM_ENEMIES = [0, 0, 2, 4, 6];
  var DIM_GRAVITY = [0, 1, 1, 1, 1];
  var DIM_WRAP = [0, 0, 0, 1, 1];
  var DIM_MAX = 5;

  // Cell codes (match ROM): 0 empty, 1 wall, 2 plat-hot, 3 plat-warm,
  // 4 plat-cold, 5 jewel, 11 exit. Enemies/player are tracked separately.
  var EMPTY = 0, WALL = 1, JEWEL = 5, EXIT = 11;

  // Timestep. The ROM ran ~0.12s ticks; we run a smaller physics step so the
  // fall/jump reads smoothly, and gate the discrete moves off a walk cadence.
  var STEP_MS = 60;          // one physics substep
  var WALK_MS = 90;          // grid cell per this many ms while holding a dir
  var GRAV_MS = 60;          // gravity substep cadence

  window.ArcadeShell.register("unfold", {
    title: "Unfold",
    controls: ["left", "right", "jump"],
    keymap: {
      ArrowLeft: "left", ArrowRight: "right",
      ArrowUp: "jump", " ": "jump", Spacebar: "jump"
    },
    create: function (host) { return new Unfold(host); }
  });

  function Unfold(host) {
    this.host = host;
    this.ctx = host.ctx;
    this.canvas = host.canvas;

    this.raf = null;
    this.stopped = false;
    this.sized = false;
    this.cell = 20;          // px per grid cell, set in resize()
    this.lastT = 0;
    this.acc = 0;            // physics accumulator (ms)
    this.walkAcc = 0;        // step-move cadence
    this.gravAcc = 0;
    this.enemyAcc = 0;
    this.decayAcc = 0;

    // Per-frame movement intent (left/right auto-repeat while held).
    this.moveDir = 0;
    this.wantJump = false;

    // Score / progression.
    this.dim = 0;
    this.level = 0;          // dimensions completed
    this.lives = 3;
    this.score = 0;
    this.chain = 0;
    this.bestChain = 0;
    this.over = false;
    this._announced = false;

    // Feedback flash: { hue, ttl }
    this.flash = null;
    this.tick = 0;           // animation tick for jewel/exit pulse

    // Dissolve animation.
    this.dissolving = false;
    this.dissolveT = 0;
    this.DISSOLVE_MAX = 12;
    this.dissolveAcc = 0;

    this._generate();
  }

  // --- Level generation (ported from generate_level) ---------------------
  Unfold.prototype._generate = function () {
    var d = this.dim;
    if (d >= DIM_MAX) { d = DIM_MAX - 1; }
    var W = DIM_W[d], H = DIM_H[d];
    this.W = W; this.H = H;
    this.hue = DIM_HUE[d];
    this.gravity = DIM_GRAVITY[d];
    this.wrap = DIM_WRAP[d];

    this.cells = new Array(W * H).fill(EMPTY);

    // Border walls.
    for (var y = 0; y < H; y++) {
      for (var x = 0; x < W; x++) {
        if (y === 0 || y === H - 1 || x === 0 || x === W - 1) {
          this.cells[y * W + x] = WALL;
        }
      }
    }

    // Platforms (only in gravity dimensions with a target count).
    this.plats = [];   // { x, y, len, heat }
    var innerW = W - 2, innerH = H - 2;
    var platTarget = DIM_PLATS[d];
    if (this.gravity && platTarget > 0) {
      for (var p = 0; p < platTarget; p++) {
        var py = 2 + Math.floor((innerH - 2) * p / platTarget);
        if (py >= H - 2) { py = H - 3; }
        var plen = 3 + this._rand(Math.floor(innerW / 3) + 1);
        if (plen > innerW - 2) { plen = innerW - 2; }
        if (plen < 1) { plen = 1; }
        var maxStart = innerW - plen;
        if (maxStart < 1) { maxStart = 1; }
        var px = 1 + this._rand(maxStart);
        this.plats.push({ x: px, y: py, len: plen, heat: 3 });
        for (var pi = 0; pi < plen; pi++) {
          this.cells[py * W + (px + pi)] = 2; // hot
        }
      }
    }

    // Jewels: must be reachable (above a solid surface, within jump reach of a
    // floor in gravity dims; anywhere open in flat dims).
    this.jewelsTotal = DIM_JEWELS[d];
    var placed = 0, attempts = 0;
    while (placed < this.jewelsTotal && attempts < 400) {
      attempts++;
      var jx = 1 + this._rand(W - 2);
      var jy = 1 + this._rand(H - 2);
      var idx = jy * W + jx;
      if (this.cells[idx] !== EMPTY) { continue; }
      if (!this.gravity) {
        this.cells[idx] = JEWEL; placed++;
      } else {
        if (jy + 1 < H && this._solid(jx, jy + 1) && jy >= H - 5) {
          this.cells[idx] = JEWEL; placed++;
        }
      }
    }
    this.jewelsTotal = placed;
    this.jewelsLeft = placed;

    // Enemies.
    this.enemies = [];  // { x, y, dir, hue }
    var enemyTarget = DIM_ENEMIES[d];
    for (var e = 0; e < enemyTarget; e++) {
      for (var a = 0; a < 60; a++) {
        var ex = 2 + this._rand(W - 4);
        var ey = 1 + this._rand(H - 2);
        if (this.cells[ey * W + ex] !== EMPTY) { continue; }
        if (!this.gravity || (ey + 1 < H && this._solid(ex, ey + 1))) {
          this.enemies.push({
            x: ex, y: ey,
            dir: this._rand(2) === 0 ? -1 : 1,
            hue: (this.hue + 180) % 360
          });
          break;
        }
      }
    }

    // Player start.
    this.px = Math.floor(W / 2);
    if (this.gravity) {
      this.py = H - 2;
      while (this.py > 1) {
        if (this._solid(this.px, this.py + 1)) { break; }
        this.py--;
      }
    } else {
      this.py = Math.floor(H / 2);
    }
    this.pvy = 0;
    this.onGround = true;

    // Exit.
    this.exitOpen = false;
    this.exitX = 0; this.exitY = 0;

    this.sized = false;   // force a refit for the new box size
  };

  Unfold.prototype._rand = function (n) {
    if (n <= 0) { return 0; }
    return Math.floor(Math.random() * n);
  };

  Unfold.prototype._solid = function (x, y) {
    if (x < 0 || x >= this.W || y < 0 || y >= this.H) { return true; }
    var c = this.cells[y * this.W + x];
    return c === WALL || c === 2 || c === 3 || c === 4;
  };

  Unfold.prototype._isWall = function (x, y) {
    if (x < 0 || x >= this.W || y < 0 || y >= this.H) { return true; }
    return this.cells[y * this.W + x] === WALL;
  };

  // --- Input -------------------------------------------------------------
  // left/right auto-repeat while held: record intent, consumed by the step
  // cadence so movement speed is time-based (not one cell per key event).
  Unfold.prototype.action = function (a) {
    if (this.over || this.dissolving) { return; }
    if (a === "left") { this.moveDir = -1; this._walkNow(); }
    else if (a === "right") { this.moveDir = 1; this._walkNow(); }
    else if (a === "jump") { this.wantJump = true; }
  };

  // Fire the first step immediately on press so a tap feels responsive; the
  // accumulator handles the held-repeat cadence afterward.
  Unfold.prototype._walkNow = function () {
    if (this.walkAcc >= WALK_MS || this.walkAcc === 0) {
      this._stepMove(this.moveDir, 0);
      this.walkAcc = 0;
    }
  };

  // --- Movement (ported from move_player) --------------------------------
  Unfold.prototype._stepMove = function (dx, dy) {
    if (dx === 0 && dy === 0) { return; }
    var W = this.W, H = this.H;
    var nx = this.px + dx;
    var ny = this.py + dy;

    if (this.wrap) {
      if (nx < 1) { nx = W - 2; }
      if (nx >= W - 1) { nx = 1; }
    }
    if (nx < 1 || nx >= W - 1) { return; }
    if (ny < 1 || ny >= H - 1) { return; }
    if (this._isWall(nx, ny)) { return; }

    // Solid platform blocks sideways moves (walk on top, not through).
    var nc = this.cells[ny * W + nx];
    if (nc >= 2 && nc <= 4 && dy === 0) { return; }

    this.px = nx; this.py = ny;
    this._pickupJewel();
    this._checkExit();
    this._checkEnemyCollision();
  };

  Unfold.prototype._pickupJewel = function () {
    var idx = this.py * this.W + this.px;
    if (this.cells[idx] !== JEWEL) { return; }
    this.cells[idx] = EMPTY;
    this.jewelsLeft--;
    this.chain++;
    if (this.chain > this.bestChain) { this.bestChain = this.chain; }
    var mult = 1 + Math.floor(this.chain / 3);
    this.score += 50 * mult * (this.dim + 1);
    this.flash = { hue: (this.hue + 180) % 360, ttl: 200 };
    this._sync();
    if (this.jewelsLeft <= 0 && !this.exitOpen) { this._spawnExit(); }
  };

  Unfold.prototype._spawnExit = function () {
    var W = this.W, H = this.H;
    for (var a = 0; a < 300; a++) {
      var ex = 1 + this._rand(W - 2);
      var ey = 1 + this._rand(H - 2);
      var idx = ey * W + ex;
      if (this.cells[idx] !== EMPTY) { continue; }
      if (ex === this.px && ey === this.py) { continue; }
      if (!this.gravity) {
        this.cells[idx] = EXIT; this.exitX = ex; this.exitY = ey; this.exitOpen = true; return;
      }
      if (ey + 1 < H && this._solid(ex, ey + 1) && ey >= H - 5) {
        this.cells[idx] = EXIT; this.exitX = ex; this.exitY = ey; this.exitOpen = true; return;
      }
    }
    // Fallback near the player.
    var fx = this.px + 2;
    if (fx >= W - 1) { fx = this.px - 2; }
    if (fx < 1) { fx = 1; }
    var fy = this.py;
    this.cells[fy * W + fx] = EXIT;
    this.exitX = fx; this.exitY = fy; this.exitOpen = true;
  };

  Unfold.prototype._checkExit = function () {
    if (this.exitOpen && this.px === this.exitX && this.py === this.exitY) {
      this.exitOpen = false;
      this.dissolving = true;
      this.dissolveT = 0;
      this.dissolveAcc = 0;
      this.flash = { hue: this.hue, ttl: 400 };
    }
  };

  Unfold.prototype._checkEnemyCollision = function () {
    for (var i = 0; i < this.enemies.length; i++) {
      if (this.enemies[i].x === this.px && this.enemies[i].y === this.py) {
        this._playerHit();
        return;
      }
    }
  };

  Unfold.prototype._playerHit = function () {
    this.chain = 0;
    this.lives--;
    this.px = Math.floor(this.W / 2);
    this.py = this.H - 2;
    this.pvy = 0;
    this.flash = { hue: 0, ttl: 260 };  // red hit flash
    this._sync();
    if (this.lives <= 0) { this.over = true; }
  };

  // --- Physics (ported from apply_gravity / try_jump / check_stomp) ------
  Unfold.prototype._applyGravity = function () {
    if (!this.gravity) { return; }
    var H = this.H;

    // Ground check beneath the player.
    this.onGround = false;
    if (this._solid(this.px, this.py + 1) && this.pvy >= 0) {
      this.onGround = true;
      this.pvy = 0;
    }

    if (this.onGround) { return; }

    // Accelerate downward toward terminal velocity.
    this.pvy += 1;
    if (this.pvy > 3) { this.pvy = 3; }

    var newY = this.py + this.pvy;
    var step = this.pvy < 0 ? -1 : 1;
    var cy = this.py;
    while (cy !== newY) {
      cy += step;
      if (cy < 1) { cy = 1; this.pvy = 0; break; }
      if (cy >= H - 1) { cy = H - 2; this.pvy = 0; this.onGround = true; break; }
      if (this._solid(this.px, cy)) {
        if (step > 0) { cy -= 1; this.onGround = true; }
        else { cy += 1; }
        this.pvy = 0;
        break;
      }
    }
    this.py = cy;

    // Landing may land us on a jewel/exit/enemy cell.
    this._pickupJewel();
    this._checkExit();
    this._checkEnemyCollision();
    this._checkStomp();
  };

  Unfold.prototype._tryJump = function () {
    if (!this.gravity) { this._stepMove(0, -1); return; }
    if (this.onGround) {
      this.pvy = -3;         // jump reaches ~3 cells up
      this.onGround = false;
    }
  };

  Unfold.prototype._checkStomp = function () {
    for (var i = 0; i < this.enemies.length; i++) {
      var en = this.enemies[i];
      if (en.x === this.px && en.y === this.py + 1 && this.pvy > 0) {
        var pts = 100;
        // Hue proximity bonus (ROM's vrgb_color_distance shortcut).
        var dh = Math.abs(((this.hue - en.hue + 540) % 360) - 180);
        if (dh < 15) { pts = 300; }
        this.chain++;
        if (this.chain > this.bestChain) { this.bestChain = this.chain; }
        var mult = 1 + Math.floor(this.chain / 3);
        this.score += pts * mult;
        this.enemies.splice(i, 1);
        this.pvy = -2;       // bounce
        this.flash = { hue: en.hue, ttl: 180 };
        this._sync();
        return;
      }
    }
  };

  // --- Enemy AI (ported from move_enemies) -------------------------------
  Unfold.prototype._moveEnemies = function () {
    var W = this.W;
    for (var i = 0; i < this.enemies.length; i++) {
      var en = this.enemies[i];
      var nx = en.x + en.dir;
      var turn = false;
      if (nx < 1 || nx >= W - 1) { turn = true; }
      else if (this._isWall(nx, en.y)) { turn = true; }
      // Don't walk off a platform edge in gravity dims.
      if (this.gravity && !turn && !this._solid(nx, en.y + 1)) { turn = true; }

      if (turn) {
        en.dir = -en.dir;
        nx = en.x + en.dir;
        if (nx < 1 || nx >= W - 1) { nx = en.x; }
        if (this._isWall(nx, en.y)) { nx = en.x; }
      }
      en.x = nx;

      if (en.x === this.px && en.y === this.py) { this._playerHit(); }
    }
  };

  // --- Platform decay (ported from decay_platforms) ----------------------
  Unfold.prototype._decayPlatforms = function () {
    var W = this.W;
    for (var p = 0; p < this.plats.length; p++) {
      var pl = this.plats[p];
      if (pl.heat <= 0) { continue; }
      pl.heat--;
      for (var pi = 0; pi < pl.len; pi++) {
        var cx = pl.x + pi, cy = pl.y;
        // Preserve a jewel/exit sitting on the platform surface (rare).
        var cur = this.cells[cy * W + cx];
        if (cur === JEWEL || cur === EXIT) { continue; }
        if (pl.heat === 0) { this.cells[cy * W + cx] = EMPTY; }
        else { this.cells[cy * W + cx] = (5 - pl.heat); } // 2->3->4 cooling
      }
    }
  };

  // --- Dissolve -> next dimension (ported from update_dissolve) ----------
  Unfold.prototype._updateDissolve = function () {
    this.dissolveT++;
    if (this.dissolveT >= this.DISSOLVE_MAX) {
      this.dissolving = false;
      this.dissolveT = 0;
      this.level++;
      this.dim++;
      this._generate();
      this._sync();
    }
  };

  Unfold.prototype._sync = function () {
    this.host.setScore(this.score);
    this.host.setStat("Dim", (this.dim + 1) + " / " + DIM_MAX);
    this.host.setStat("Jewels", (this.jewelsTotal - this.jewelsLeft) + " / " + this.jewelsTotal);
    this.host.setStat("Chain", this.chain);
    this.host.setStat("Lives", this.lives);
  };

  // --- Shell contract ----------------------------------------------------
  Unfold.prototype.start = function () {
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
      if (dt > 200) { dt = 200; }  // clamp after a tab-away
      self._update(dt);
      self._draw();
      if (self.over && !self._announced) {
        self._announced = true;
        self.host.gameOver({
          title: "Collapsed",
          lines: [
            "Score " + self.score,
            "Reached dimension " + (self.dim + 1) + " / " + DIM_MAX,
            "Best chain " + self.bestChain,
            "Levels unfolded " + self.level
          ]
        });
      }
      self.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  };

  Unfold.prototype.stop = function () {
    this.stopped = true;
    if (this.raf) { cancelAnimationFrame(this.raf); this.raf = null; }
  };

  Unfold.prototype._update = function (dt) {
    this.tick += dt / STEP_MS;

    if (this.flash) { this.flash.ttl -= dt; if (this.flash.ttl <= 0) { this.flash = null; } }

    if (this.over) { return; }

    if (this.dissolving) {
      this.dissolveAcc += dt;
      var dstep = this.DISSOLVE_MAX ? 900 / this.DISSOLVE_MAX : 75;
      while (this.dissolveAcc >= dstep && this.dissolving) {
        this.dissolveAcc -= dstep;
        this._updateDissolve();
      }
      return;
    }

    // Held move cadence.
    if (this.moveDir !== 0) {
      this.walkAcc += dt;
      while (this.walkAcc >= WALK_MS) {
        this.walkAcc -= WALK_MS;
        this._stepMove(this.moveDir, 0);
        if (this.over || this.dissolving) { break; }
      }
    } else {
      this.walkAcc = WALK_MS;  // primed so next press fires instantly
    }
    // moveDir is a one-frame intent; the shell re-dispatches while held.
    this.moveDir = 0;

    // Jump (one press per fire).
    if (this.wantJump) {
      this.wantJump = false;
      this._tryJump();
    }

    // Gravity substeps.
    if (this.gravity) {
      this.gravAcc += dt;
      while (this.gravAcc >= GRAV_MS) {
        this.gravAcc -= GRAV_MS;
        this._applyGravity();
        if (this.over || this.dissolving) { break; }
      }
    }

    if (this.over || this.dissolving) { return; }

    // Enemies: cadence quickens with dimension (ROM 5 - DIM, min 2 ticks).
    var enemyRate = 5 - this.dim;
    if (enemyRate < 2) { enemyRate = 2; }
    this.enemyAcc += dt;
    while (this.enemyAcc >= enemyRate * 120) {
      this.enemyAcc -= enemyRate * 120;
      this._moveEnemies();
      if (this.over || this.dissolving) { break; }
    }

    if (this.over || this.dissolving) { return; }

    // Platform decay (ROM 50 - DIM*8, min 15 ticks).
    if (this.plats.length > 0) {
      var decayRate = 50 - this.dim * 8;
      if (decayRate < 15) { decayRate = 15; }
      this.decayAcc += dt;
      while (this.decayAcc >= decayRate * 120) {
        this.decayAcc -= decayRate * 120;
        this._decayPlatforms();
      }
    }
  };

  // --- Resize (self-healing, per chromafall) -----------------------------
  Unfold.prototype.resize = function () {
    var surface = this.canvas.parentElement;
    if (!surface) { return false; }
    var maxW = surface.clientWidth;
    var maxH = surface.clientHeight;
    if (maxW < 20 || maxH < 20) { return false; }
    var W = this.W, H = this.H;
    var cell = Math.floor(Math.min(maxW / W, maxH / H));
    if (cell < 4) { cell = 4; }
    this.cell = cell;
    var dpr = window.devicePixelRatio || 1;
    this.canvas.width = W * cell * dpr;
    this.canvas.height = H * cell * dpr;
    this.canvas.style.width = (W * cell) + "px";
    this.canvas.style.height = (H * cell) + "px";
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.sized = true;
    return true;
  };

  // --- Render ------------------------------------------------------------
  function hsl(h, s, l) {
    return "hsl(" + Math.round(h) + ", " + s + "%, " + l + "%)";
  }

  Unfold.prototype._draw = function () {
    var ctx = this.ctx, c = this.cell, W = this.W, H = this.H;
    var hue = this.hue;

    ctx.fillStyle = "#08080c";
    ctx.fillRect(0, 0, W * c, H * c);

    for (var y = 0; y < H; y++) {
      for (var x = 0; x < W; x++) {
        var code = this.cells[y * W + x];
        if (code === EMPTY) { continue; }
        if (code === WALL) {
          this._block(x, y, hsl(hue, 60, 42), 0);
        } else if (code === 2) {         // hot platform
          this._block(x, y, hsl(hue, 70, 52), 1);
        } else if (code === 3) {         // warm (cooling)
          this._block(x, y, hsl(hue, 45, 38), 1);
        } else if (code === 4) {         // cold (about to fall)
          this._block(x, y, hsl(hue, 22, 26), 1);
        } else if (code === JEWEL) {
          this._jewel(x, y);
        } else if (code === EXIT) {
          this._exit(x, y);
        }
      }
    }

    // Enemies.
    if (!this.dissolving) {
      for (var i = 0; i < this.enemies.length; i++) {
        var en = this.enemies[i];
        this._enemy(en.x, en.y, en.hue);
      }
    }

    // Player.
    if (!this.dissolving) {
      this._player(this.px, this.py, hue);
    }

    // Dissolve wash: fade the whole box toward the hue as walls "unfold".
    if (this.dissolving) {
      var a = Math.min(1, this.dissolveT / this.DISSOLVE_MAX);
      ctx.globalAlpha = a * 0.7;
      ctx.fillStyle = hsl(hue, 60, 45);
      ctx.fillRect(0, 0, W * c, H * c);
      ctx.globalAlpha = 1;
    }

    // Feedback flash.
    if (this.flash) {
      var alpha = Math.max(0, this.flash.ttl / 260);
      ctx.globalAlpha = alpha * 0.4;
      ctx.fillStyle = hsl(this.flash.hue, 85, 55);
      ctx.fillRect(0, 0, W * c, H * c);
      ctx.globalAlpha = 1;
    }
  };

  Unfold.prototype._block = function (x, y, color, inset) {
    var ctx = this.ctx, c = this.cell;
    ctx.fillStyle = color;
    if (inset) {
      ctx.fillRect(x * c + 1, y * c + Math.floor(c * 0.25),
                   c - 2, Math.max(2, Math.floor(c * 0.5)));
    } else {
      ctx.fillRect(x * c, y * c, c, c);
    }
  };

  Unfold.prototype._player = function (x, y, hue) {
    var ctx = this.ctx, c = this.cell;
    var m = Math.max(2, Math.floor(c * 0.15));
    ctx.fillStyle = hsl((hue + 30) % 360, 90, 62);
    ctx.fillRect(x * c + m, y * c + m, c - 2 * m, c - 2 * m);
    ctx.fillStyle = "rgba(255,255,255,0.85)";
    ctx.fillRect(x * c + m, y * c + m, c - 2 * m, Math.max(1, Math.floor(c * 0.12)));
  };

  Unfold.prototype._enemy = function (x, y, hue) {
    var ctx = this.ctx, c = this.cell;
    var m = Math.max(2, Math.floor(c * 0.18));
    ctx.fillStyle = hsl(hue, 75, 52);
    // Diamond-ish body.
    ctx.beginPath();
    var cx = x * c + c / 2, cy = y * c + c / 2, r = c / 2 - m;
    ctx.moveTo(cx, cy - r);
    ctx.lineTo(cx + r, cy);
    ctx.lineTo(cx, cy + r);
    ctx.lineTo(cx - r, cy);
    ctx.closePath();
    ctx.fill();
  };

  Unfold.prototype._jewel = function (x, y) {
    var ctx = this.ctx, c = this.cell;
    var jhue = (this.hue + 180) % 360;
    var pulse = (Math.floor(this.tick) % 4) < 2;
    ctx.fillStyle = pulse ? hsl(jhue, 85, 62) : "#ffffff";
    var cx = x * c + c / 2, cy = y * c + c / 2, r = c * 0.3;
    ctx.beginPath();
    ctx.moveTo(cx, cy - r);
    ctx.lineTo(cx + r, cy);
    ctx.lineTo(cx, cy + r);
    ctx.lineTo(cx - r, cy);
    ctx.closePath();
    ctx.fill();
  };

  Unfold.prototype._exit = function (x, y) {
    var ctx = this.ctx, c = this.cell;
    var pulse = (Math.floor(this.tick) % 6) < 3;
    ctx.fillStyle = pulse ? "#ffdc32" : "#fffcc8";
    var cx = x * c + c / 2, cy = y * c + c / 2;
    var r = c * 0.42;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#08080c";
    ctx.beginPath();
    ctx.arc(cx, cy, r * 0.45, 0, Math.PI * 2);
    ctx.fill();
  };
})();
