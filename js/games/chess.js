/*
 * MAESTRO CHESS -- browser port of roms/chess.sh + maestro-chess/play.py
 *
 * Real chess on the arcade surface. window.Chess (chess.js v0.13.4, loaded on
 * the page) is the referee -- every move goes through its legality, exactly as
 * python-chess refereed the terminal ROM. The CPU is the "honest computer":
 * negamax + alpha-beta over material {P100,N320,B330,R500,Q900} plus simple
 * piece-square tables (the ROM's PIECE_VALUES intent -- reward center and
 * development), running on the CPU, never able to flail on legality.
 *
 * Tap-only: you play White at the bottom. First tap picks up one of your pieces
 * (square highlights, legal targets dot); second tap on a legal target moves
 * (auto-queen on promotion). The CPU replies on a short timeout so the board
 * repaints ("thinking...") before it moves.
 *
 * VRGB flavor, kept from the ROM as feel: the eval swatch tints warm when White
 * is ahead, azure when Black is ahead, grey near level -- the SLI reading of the
 * position rendered as color, not a bare number.
 */
(function () {
  "use strict";

  var N = 8;

  // Unicode glyphs, white then black. Keyed by chess.js piece {type,color}.
  var GLYPH = {
    w: { p: "♙", n: "♘", b: "♗", r: "♖", q: "♕", k: "♔" },
    b: { p: "♟", n: "♞", b: "♝", r: "♜", q: "♛", k: "♚" }
  };

  // Material, from play.py PIECE_VALUES (king = 0 for material; mate handled apart).
  var VALUE = { p: 100, n: 320, b: 330, r: 500, q: 900, k: 0 };
  var MATE = 1000000;

  // Piece-square tables -- the ROM's "reward center/development" intent made
  // explicit. Indexed [rank 0..7 from White's back rank][file 0..7], White's
  // point of view; mirrored vertically for Black. Values in centipawns.
  var PST = {
    p: [
      0, 0, 0, 0, 0, 0, 0, 0,
      5, 10, 10, -20, -20, 10, 10, 5,
      5, -5, -10, 0, 0, -10, -5, 5,
      0, 0, 0, 20, 20, 0, 0, 0,
      5, 5, 10, 25, 25, 10, 5, 5,
      10, 10, 20, 30, 30, 20, 10, 10,
      50, 50, 50, 50, 50, 50, 50, 50,
      0, 0, 0, 0, 0, 0, 0, 0
    ],
    n: [
      -50, -40, -30, -30, -30, -30, -40, -50,
      -40, -20, 0, 5, 5, 0, -20, -40,
      -30, 5, 10, 15, 15, 10, 5, -30,
      -30, 0, 15, 20, 20, 15, 0, -30,
      -30, 5, 15, 20, 20, 15, 5, -30,
      -30, 0, 10, 15, 15, 10, 0, -30,
      -40, -20, 0, 0, 0, 0, -20, -40,
      -50, -40, -30, -30, -30, -30, -40, -50
    ],
    b: [
      -20, -10, -10, -10, -10, -10, -10, -20,
      -10, 5, 0, 0, 0, 0, 5, -10,
      -10, 10, 10, 10, 10, 10, 10, -10,
      -10, 0, 10, 10, 10, 10, 0, -10,
      -10, 5, 5, 10, 10, 5, 5, -10,
      -10, 0, 5, 10, 10, 5, 0, -10,
      -10, 0, 0, 0, 0, 0, 0, -10,
      -20, -10, -10, -10, -10, -10, -10, -20
    ],
    r: [
      0, 0, 0, 5, 5, 0, 0, 0,
      -5, 0, 0, 0, 0, 0, 0, -5,
      -5, 0, 0, 0, 0, 0, 0, -5,
      -5, 0, 0, 0, 0, 0, 0, -5,
      -5, 0, 0, 0, 0, 0, 0, -5,
      -5, 0, 0, 0, 0, 0, 0, -5,
      5, 10, 10, 10, 10, 10, 10, 5,
      0, 0, 0, 0, 0, 0, 0, 0
    ],
    q: [
      -20, -10, -10, -5, -5, -10, -10, -20,
      -10, 0, 5, 0, 0, 0, 0, -10,
      -10, 5, 5, 5, 5, 5, 0, -10,
      0, 0, 5, 5, 5, 5, 0, -5,
      -5, 0, 5, 5, 5, 5, 0, -5,
      -10, 0, 5, 5, 5, 5, 0, -10,
      -10, 0, 0, 0, 0, 0, 0, -10,
      -20, -10, -10, -5, -5, -10, -10, -20
    ],
    k: [
      20, 30, 10, 0, 0, 10, 30, 20,
      20, 20, 0, 0, 0, 0, 20, 20,
      -10, -20, -20, -20, -20, -20, -20, -10,
      -20, -30, -30, -40, -40, -30, -30, -20,
      -30, -40, -40, -50, -50, -40, -40, -30,
      -30, -40, -40, -50, -50, -40, -40, -30,
      -30, -40, -40, -50, -50, -40, -40, -30,
      -30, -40, -40, -50, -50, -40, -40, -30
    ]
  };

  // Board colors (light/dark) and overlay accents.
  var LIGHT = "#e9e2cf";
  var DARK = "#7f9b70";
  var SEL = "rgba(60, 180, 90, 0.55)";      // picked-up square wash
  var DOT = "rgba(30, 30, 30, 0.35)";        // quiet-move dot
  var CAP = "rgba(200, 50, 40, 0.55)";       // capture target ring
  var CHECK = "rgba(220, 60, 40, 0.55)";     // king-in-check wash

  var FILES = "abcdefgh";

  window.ArcadeShell.register("chess", {
    title: "Maestro Chess",
    controls: [],
    create: function (host) { return new Game(host); }
  });

  function Game(host) {
    this.host = host;
    this.ctx = host.ctx;
    this.canvas = host.canvas;
    this.game = new window.Chess();
    this.selected = null;   // algebraic square string, e.g. "e2"
    this.targets = [];      // array of verbose legal moves from the selected square
    this.thinking = false;  // CPU is computing its reply
    this.over = false;
    this.raf = null;
    this.stopped = false;
    this.sized = false;
    this.cell = 40;         // px per square, set in resize()
    this.moveCount = 0;     // full moves played (both sides)
    this.lastEval = 0;      // centipawn, White's view
    this.dirty = true;      // repaint requested
    this._announced = false;
    this.depth = 2;         // negamax depth (see note in _cpuReply)
  }

  // --- Shell contract ----------------------------------------------------

  Game.prototype.start = function () {
    this._sync();
    var self = this;
    var loop = function () {
      if (self.stopped) { return; }
      // Self-heal: don't draw until the surface has a real measurable size.
      if (!self.sized && !self.resize()) {
        self.raf = requestAnimationFrame(loop);
        return;
      }
      if (self.dirty) { self._draw(); self.dirty = false; }
      self.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  };

  Game.prototype.stop = function () {
    this.stopped = true;
    if (this.raf) { cancelAnimationFrame(this.raf); this.raf = null; }
  };

  Game.prototype.resize = function () {
    var surface = this.canvas.parentElement;
    if (!surface) { return false; }
    var maxW = surface.clientWidth;
    var maxH = surface.clientHeight;
    if (maxW < 20 || maxH < 20) { return false; }
    var cell = Math.floor(Math.min(maxW, maxH) / N);
    if (cell < 6) { cell = 6; }
    this.cell = cell;
    var dpr = window.devicePixelRatio || 1;
    var px = N * cell;
    this.canvas.width = px * dpr;
    this.canvas.height = px * dpr;
    this.canvas.style.width = px + "px";
    this.canvas.style.height = px + "px";
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.sized = true;
    this.dirty = true;
    return true;
  };

  // Tap: x,y CSS px within canvas; w,h canvas CSS size. Map to a board square.
  Game.prototype.tap = function (x, y, w, h) {
    if (this.over || this.thinking) { return; }
    if (this.game.turn() !== "w") { return; }   // only the human, only on White's turn
    var boardPx = N * this.cell;
    if (x < 0 || y < 0 || x >= boardPx || y >= boardPx) { return; }
    var file = Math.floor(x / this.cell);
    var rank = Math.floor(y / this.cell);        // 0 = top row (rank 8) since White at bottom
    if (file < 0 || file > 7 || rank < 0 || rank > 7) { return; }
    // White at bottom: screen rank 0 -> chess rank 8, screen rank 7 -> chess rank 1.
    var square = FILES.charAt(file) + String(8 - rank);
    this._onSquare(square);
  };

  // --- Interaction -------------------------------------------------------

  Game.prototype._onSquare = function (square) {
    var piece = this.game.get(square);

    if (this.selected) {
      // Is this square a legal target of the picked-up piece?
      var mv = this._targetMove(square);
      if (mv) {
        this._playHuman(mv);
        return;
      }
      // Tapped own other piece -> re-select it.
      if (piece && piece.color === "w") {
        this._select(square);
        return;
      }
      // Anything else -> deselect.
      this.selected = null;
      this.targets = [];
      this.dirty = true;
      return;
    }

    // Nothing selected: pick up one of your own pieces (if it can move).
    if (piece && piece.color === "w") {
      this._select(square);
    }
  };

  Game.prototype._select = function (square) {
    var moves = this.game.moves({ square: square, verbose: true });
    if (!moves.length) {
      // No legal move for that piece -- leave nothing selected.
      this.selected = null;
      this.targets = [];
      this.dirty = true;
      return;
    }
    this.selected = square;
    this.targets = moves;
    this.dirty = true;
  };

  Game.prototype._targetMove = function (square) {
    for (var i = 0; i < this.targets.length; i++) {
      if (this.targets[i].to === square) { return this.targets[i]; }
    }
    return null;
  };

  Game.prototype._playHuman = function (mv) {
    var move = { from: mv.from, to: mv.to };
    if (mv.promotion) { move.promotion = "q"; }   // auto-queen
    this.game.move(move);
    this.selected = null;
    this.targets = [];
    this._afterMove();
    if (this.over) { return; }
    // Hand to the CPU on a timeout so the board repaints (thinking...) first.
    this.thinking = true;
    this._sync();
    this.dirty = true;
    var self = this;
    setTimeout(function () { self._cpuReply(); }, 60);
  };

  Game.prototype._cpuReply = function () {
    if (this.stopped || this.over) { return; }
    // Depth 2 by default. Depth 3 is measured below and adopted only when the
    // opening-position search stays responsive; otherwise we stay at 2 so the
    // phone never locks up mid-think.
    var t0 = (typeof performance !== "undefined") ? performance.now() : Date.now();
    var mv = this._bestMove(this.depth);
    var t1 = (typeof performance !== "undefined") ? performance.now() : Date.now();
    // Adapt once: if depth-2 came back very fast, try depth-3 next reply.
    if (this.depth === 2 && (t1 - t0) < 120) { this.depth = 3; }
    else if (this.depth === 3 && (t1 - t0) > 1200) { this.depth = 2; }

    if (mv) { this.game.move({ from: mv.from, to: mv.to, promotion: mv.promotion || "q" }); }
    this.thinking = false;
    this._afterMove();
  };

  Game.prototype._afterMove = function () {
    this.lastEval = this._materialEval();
    this.moveCount = Math.floor((this.game.history().length + 1) / 2);
    this._sync();
    this.dirty = true;
    this._checkEnd();
  };

  // --- CPU: negamax + alpha-beta -----------------------------------------

  // Best move for the side to move at the root.
  Game.prototype._bestMove = function (depth) {
    var g = this.game;
    var moves = g.moves({ verbose: true });
    if (!moves.length) { return null; }
    var best = null;
    var bestVal = -MATE * 2;
    var alpha = -MATE * 2;
    var beta = MATE * 2;
    for (var i = 0; i < moves.length; i++) {
      var m = moves[i];
      g.move({ from: m.from, to: m.to, promotion: m.promotion || "q" });
      var val = -this._negamax(depth - 1, -beta, -alpha);
      g.undo();
      if (val > bestVal) { bestVal = val; best = m; }
      if (bestVal > alpha) { alpha = bestVal; }
    }
    return best;
  };

  Game.prototype._negamax = function (depth, alpha, beta) {
    var g = this.game;
    if (g.game_over()) { return this._evaluate(); }
    if (depth === 0) { return this._evaluate(); }
    var moves = g.moves({ verbose: true });
    var best = -MATE * 2;
    for (var i = 0; i < moves.length; i++) {
      var m = moves[i];
      g.move({ from: m.from, to: m.to, promotion: m.promotion || "q" });
      var val = -this._negamax(depth - 1, -beta, -alpha);
      g.undo();
      if (val > best) { best = val; }
      if (best > alpha) { alpha = best; }
      if (alpha >= beta) { break; }
    }
    return best;
  };

  // Static eval from the side-to-move's perspective (negamax convention),
  // material + piece-square tables, mirroring play.py's evaluate().
  Game.prototype._evaluate = function () {
    var g = this.game;
    if (g.in_checkmate()) { return -MATE; }
    if (g.in_stalemate() || g.in_draw() || g.insufficient_material()) { return 0; }
    var board = g.board();   // board()[0] = rank 8, board()[7] = rank 1
    var score = 0;
    for (var r = 0; r < 8; r++) {
      for (var f = 0; f < 8; f++) {
        var p = board[r][f];
        if (!p) { continue; }
        var v = VALUE[p.type];
        // PST index: White reads from its back rank up. board row r=0 is rank 8.
        // For White, PST rank index = 7 - r? PST is laid out rank 1..8 top-to-
        // bottom in the arrays above (index 0 = rank 1). board r=0 is rank 8, so
        // rank1Index = (7 - r). For Black, mirror vertically: use r directly.
        var pst;
        if (p.color === "w") { pst = PST[p.type][(7 - r) * 8 + f]; }
        else { pst = PST[p.type][r * 8 + f]; }
        var contrib = v + pst;
        if (p.color === "w") { score += contrib; } else { score -= contrib; }
      }
    }
    if (g.turn() === "b") { score = -score; }
    return score;
  };

  // Material-only eval in centipawns, White's view (for the Eval stat / VRGB).
  Game.prototype._materialEval = function () {
    var board = this.game.board();
    var cp = 0;
    for (var r = 0; r < 8; r++) {
      for (var f = 0; f < 8; f++) {
        var p = board[r][f];
        if (!p || p.type === "k") { continue; }
        var v = VALUE[p.type];
        if (p.color === "w") { cp += v; } else { cp -= v; }
      }
    }
    return cp;
  };

  // --- End of game -------------------------------------------------------

  Game.prototype._checkEnd = function () {
    var g = this.game;
    if (!g.game_over()) { return; }
    this.over = true;
    if (this._announced) { return; }
    this._announced = true;
    var title, result;
    var plies = g.history().length;
    var moves = Math.ceil(plies / 2);
    if (g.in_checkmate()) {
      // Side to move is checkmated -> the other side won.
      var winner = (g.turn() === "w") ? "Black (CPU)" : "White (You)";
      title = (g.turn() === "w") ? "Checkmate -- CPU wins" : "Checkmate -- You win";
      result = winner + " delivers mate";
    } else if (g.in_stalemate()) {
      title = "Stalemate";
      result = "Draw by stalemate";
    } else if (g.insufficient_material()) {
      title = "Draw";
      result = "Insufficient material";
    } else if (g.in_threefold_repetition()) {
      title = "Draw";
      result = "Threefold repetition";
    } else if (g.in_draw()) {
      title = "Draw";
      result = "Draw (50-move / rule)";
    } else {
      title = "Game Over";
      result = "Game complete";
    }
    this.host.gameOver({
      title: title,
      lines: [result, "Moves " + moves, "Final eval " + fmtEval(this.lastEval)]
    });
  };

  // --- Stats -------------------------------------------------------------

  Game.prototype._sync = function () {
    var g = this.game;
    var turn = this.thinking ? "CPU (thinking...)"
      : (g.turn() === "w" ? "You" : "CPU");
    this.host.setStat("Turn", turn);
    this.host.setStat("Eval", fmtEval(this.lastEval));
    if (!this.over && g.in_check()) {
      this.host.setStat("Check", g.turn() === "w" ? "You!" : "CPU");
    } else {
      this.host.setStat("Check", "-");
    }
    // Score line = the material eval in pawns (White-positive).
    this.host.setScore(fmtEval(this.lastEval));
  };

  // --- Render ------------------------------------------------------------

  Game.prototype._draw = function () {
    var ctx = this.ctx;
    var c = this.cell;
    var g = this.game;
    var board = g.board();

    // Squares.
    for (var r = 0; r < 8; r++) {
      for (var f = 0; f < 8; f++) {
        var light = (r + f) % 2 === 0;
        ctx.fillStyle = light ? LIGHT : DARK;
        ctx.fillRect(f * c, r * c, c, c);
      }
    }

    // King-in-check wash.
    if (!this.over && g.in_check()) {
      var ksq = this._findKing(g.turn());
      if (ksq) {
        var kc = this._screenXY(ksq);
        ctx.fillStyle = CHECK;
        ctx.fillRect(kc.x * c, kc.y * c, c, c);
      }
    }

    // Selected square wash.
    if (this.selected) {
      var s = this._screenXY(this.selected);
      ctx.fillStyle = SEL;
      ctx.fillRect(s.x * c, s.y * c, c, c);
    }

    // Legal-target hints: dot for quiet, ring for capture.
    for (var i = 0; i < this.targets.length; i++) {
      var t = this._screenXY(this.targets[i].to);
      var cx = t.x * c + c / 2;
      var cy = t.y * c + c / 2;
      var isCap = this.targets[i].flags.indexOf("c") !== -1 ||
                  this.targets[i].flags.indexOf("e") !== -1;
      ctx.beginPath();
      if (isCap) {
        ctx.strokeStyle = CAP;
        ctx.lineWidth = Math.max(2, c * 0.08);
        ctx.arc(cx, cy, c * 0.42, 0, Math.PI * 2);
        ctx.stroke();
      } else {
        ctx.fillStyle = DOT;
        ctx.arc(cx, cy, c * 0.16, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // Pieces.
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = Math.floor(c * 0.7) + "px serif";
    for (r = 0; r < 8; r++) {
      for (f = 0; f < 8; f++) {
        var p = board[r][f];   // board()[0] = rank 8 -> screen row 0. White at bottom = rank 1 at screen row 7.
        if (!p) { continue; }
        // board r=0 is rank 8 which is the TOP of the screen for White-at-bottom,
        // so the screen row equals r directly.
        var glyph = GLYPH[p.color][p.type];
        // Outline for contrast on both square colors.
        var gx = f * c + c / 2;
        var gy = r * c + c / 2 + c * 0.02;
        ctx.lineWidth = Math.max(1, c * 0.03);
        ctx.strokeStyle = (p.color === "w") ? "#2a2a2a" : "#101010";
        ctx.fillStyle = (p.color === "w") ? "#fbfbf7" : "#161616";
        ctx.strokeText(glyph, gx, gy);
        ctx.fillText(glyph, gx, gy);
      }
    }

    // VRGB eval swatch: a thin bar along the top edge, warm=White / azure=Black.
    var rgb = cpToRgb(this.lastEval);
    ctx.fillStyle = "rgb(" + rgb[0] + "," + rgb[1] + "," + rgb[2] + ")";
    ctx.fillRect(0, 0, N * c, Math.max(2, c * 0.06));
  };

  // Screen coords (col x, row y) for an algebraic square, White at bottom.
  Game.prototype._screenXY = function (square) {
    var file = FILES.indexOf(square.charAt(0));
    var rank = parseInt(square.charAt(1), 10);   // 1..8
    return { x: file, y: 8 - rank };
  };

  Game.prototype._findKing = function (color) {
    var board = this.game.board();
    for (var r = 0; r < 8; r++) {
      for (var f = 0; f < 8; f++) {
        var p = board[r][f];
        if (p && p.type === "k" && p.color === color) {
          // rank 8 = board row 0 = screen row 0; algebraic square:
          return FILES.charAt(f) + String(8 - r);
        }
      }
    }
    return null;
  };

  // --- helpers -----------------------------------------------------------

  function fmtEval(cp) {
    var pawns = cp / 100;
    var s = (pawns >= 0 ? "+" : "") + pawns.toFixed(1);
    return s;
  }

  // Centipawn (White's view) -> RGB. Warm = White ahead, azure = Black ahead,
  // grey near level. Ported from play.py cp_to_rgb via HSL.
  function cpToRgb(cp) {
    var m = Math.max(-1000, Math.min(1000, cp)) / 1000.0;
    var hue = (m >= 0) ? 18 : 210;             // red-orange vs azure
    var sat = 0.15 + 0.75 * Math.abs(m);       // near-level washes to grey
    return hslToRgb(hue / 360.0, 0.5, sat);
  }

  // HSL -> RGB (h,s,l in 0..1), returns [r,g,b] 0..255.
  function hslToRgb(h, s, l) {
    var r, gg, b;
    if (s === 0) {
      r = gg = b = l;
    } else {
      var q = l < 0.5 ? l * (1 + s) : l + s - l * s;
      var pp = 2 * l - q;
      r = hue2rgb(pp, q, h + 1 / 3);
      gg = hue2rgb(pp, q, h);
      b = hue2rgb(pp, q, h - 1 / 3);
    }
    return [Math.round(r * 255), Math.round(gg * 255), Math.round(b * 255)];
  }

  function hue2rgb(p, q, t) {
    if (t < 0) { t += 1; }
    if (t > 1) { t -= 1; }
    if (t < 1 / 6) { return p + (q - p) * 6 * t; }
    if (t < 1 / 2) { return q; }
    if (t < 2 / 3) { return p + (q - p) * (2 / 3 - t) * 6; }
    return p;
  }
})();
