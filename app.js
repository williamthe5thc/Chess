/**
 * Chess for Dad — Father's Day Gift PWA
 * Vanilla JS · chess.js · Stockfish via blob-URL Worker
 */

/* ── 1. Bootstrap ── */
(function bootstrap() {
  const s = document.createElement('script');
  s.src = 'https://cdnjs.cloudflare.com/ajax/libs/chess.js/0.10.3/chess.min.js';
  s.onload = initApp;
  s.onerror = () => alert('Failed to load chess.js. Check your connection.');
  document.head.appendChild(s);
})();

/* ── 2. Piece Maps ── */
const UNICODE = {
  wK:'♔', wQ:'♕', wR:'♖', wB:'♗', wN:'♘', wP:'♙',
  bK:'♚', bQ:'♛', bR:'♜', bB:'♝', bN:'♞', bP:'♟',
};

// Base paths without extension — loader tries jpg, jpeg, png, svg in order
const FAMILY_IMGS = {
  K: 'pieces/family/king',        // king_white.png / king_black.png
  Q: 'pieces/family/queen',       // queen_white.png / queen_black.png (add when ready)
  N: { b:'pieces/family/knight_a', g:'pieces/family/knight_b' }, // knight_a/b_white/black.png
  B: { c:'pieces/family/bishop_a', f:'pieces/family/bishop_b' }, // c-file / f-file
  R: { a:'pieces/family/rook_a',  h:'pieces/family/rook_b'  }, // a-file / h-file
  P: { a:'pieces/family/pawn_a', b:'pieces/family/pawn_b',
       c:'pieces/family/pawn_c', d:'pieces/family/pawn_d',
       e:'pieces/family/pawn_e', f:'pieces/family/pawn_f',
       g:'pieces/family/pawn_g', h:'pieces/family/pawn_h' },
};
const IMG_EXTS = ['jpg','jpeg','png','svg'];

/* Try each path in order; onLoad(idx, resolvedSrc) fires on first success */
function tryPaths(img, paths, idx, onLoad, onFail) {
  if (idx >= paths.length) { onFail(); return; }
  img.onerror = () => tryPaths(img, paths, idx + 1, onLoad, onFail);
  img.onload  = () => onLoad(idx, paths[idx]);
  img.src = paths[idx];
}

/* Resolve image with color-specific first, then generic fallback.
   onResolved(resolvedSrc, isColorSpecific) — called when any image loads. */
function setFamilyImg(img, base, colorChar, onResolved, onFail) {
  const suffix = colorChar === 'w' ? '_white' : '_black';
  const paths = [
    ...IMG_EXTS.map(e => base + suffix + '.' + e),
    ...IMG_EXTS.map(e => base + '.' + e),
  ];
  tryPaths(img, paths, 0, (idx, src) => {
    onResolved(src, idx < IMG_EXTS.length);
  }, onFail);
}

/* Square → resolved absolute src URL; persists across renderBoard() calls */
let pieceImgMap = {};

/* Update pieceImgMap after a chess.js move result */
function applyMoveToImgMap(result) {
  const { from, to, flags } = result;
  pieceImgMap[to] = pieceImgMap[from];
  delete pieceImgMap[from];
  /* Promotion — clear the pawn's cached src so the new piece gets a fresh image */
  if (result.promotion) delete pieceImgMap[to];
  /* En passant — remove captured pawn's cached entry */
  if (flags && flags.includes('e')) {
    delete pieceImgMap[to[0] + from[1]];
  }
  /* Castling — move the rook too */
  const rank = from[1];
  if (flags && flags.includes('k')) { // kingside
    pieceImgMap['f' + rank] = pieceImgMap['h' + rank];
    delete pieceImgMap['h' + rank];
  }
  if (flags && flags.includes('q')) { // queenside
    pieceImgMap['d' + rank] = pieceImgMap['a' + rank];
    delete pieceImgMap['a' + rank];
  }
}

/* ── 3. ELO Tier Labels ── */
const ELO_TIERS = [
  { max:  700, label: 'Beginner' },
  { max: 1200, label: 'Casual' },
  { max: 1600, label: 'Intermediate' },
  { max: 2000, label: 'Advanced' },
  { max: 2500, label: 'Expert' },
  { max: 3000, label: 'Master' },
];

function eloTier(elo) {
  for (const t of ELO_TIERS) { if (elo <= t.max) return t.label; }
  return 'Master';
}

/* Blunder rate at given ELO (0 = never random, 1 = always random).
   Applies for ELO < 1320 where Stockfish UCI_LimitStrength floor kicks in. */
function blunderRate(elo) {
  if (elo >= 1320) return 0;
  return 0.85 * Math.pow((1320 - elo) / (1320 - 250), 1.3);
}

/* Depth to use for AI below 1320 ELO */
function lowEloDepth(elo) {
  if (elo >= 1000) return 2;
  if (elo >= 600)  return 1;
  return 1;
}

/* ── 4. Stockfish Worker ── */
let stockfish    = null;
let sfReady      = false;
let sfCallbacks  = [];
let sfBusy       = false;
let sfCancelFn   = null;   // call to cancel the current Stockfish task

function loadStockfish() {
  const url = 'https://cdnjs.cloudflare.com/ajax/libs/stockfish.js/10.0.2/stockfish.js';
  fetch(url)
    .then(r => r.text())
    .then(code => {
      const blob = new Blob([code], { type: 'application/javascript' });
      stockfish = new Worker(URL.createObjectURL(blob));
      stockfish.onmessage = e => { sfCallbacks = sfCallbacks.filter(cb => !cb(e.data)); };
      stockfish.onerror   = err => console.error('Stockfish error:', err);
      stockfish.postMessage('uci');
      stockfish.postMessage('isready');
      sfOnce(l => l === 'readyok', () => {
        sfReady = true;
        applyEloSettings(currentElo);
      });
    })
    .catch(() => {
      try {
        stockfish = new Worker(url);
        stockfish.onmessage = e => { sfCallbacks = sfCallbacks.filter(cb => !cb(e.data)); };
        stockfish.postMessage('uci');
        stockfish.postMessage('isready');
        sfOnce(l => l === 'readyok', () => { sfReady = true; applyEloSettings(currentElo); });
      } catch(_) { console.error('Stockfish unavailable — AI disabled.'); }
    });
}

function sfOnce(predicate, resolve) {
  sfCallbacks.push(line => { if (predicate(line)) { resolve(line); return true; } return false; });
}

function sfStop() {
  if (stockfish) stockfish.postMessage('stop');
  sfCallbacks = [];
  sfBusy = false;
  if (sfCancelFn) { sfCancelFn(); sfCancelFn = null; }
}

function applyEloSettings(elo) {
  if (!stockfish || !sfReady) return;
  if (elo >= 1320) {
    stockfish.postMessage('setoption name UCI_LimitStrength value true');
    stockfish.postMessage('setoption name UCI_Elo value ' + Math.min(3190, elo));
  } else {
    stockfish.postMessage('setoption name UCI_LimitStrength value false');
  }
}

/* Ask Stockfish for best move. Returns promise resolving to UCI string or null. */
function sfBestMove(fen, depth) {
  return new Promise(resolve => {
    if (!stockfish || !sfReady) { resolve(null); return; }
    sfBusy = true;
    sfCancelFn = () => resolve(null);

    stockfish.postMessage('position fen ' + fen);
    stockfish.postMessage('go depth ' + depth);

    sfOnce(
      line => line.startsWith('bestmove'),
      line => {
        sfBusy = false;
        sfCancelFn = null;
        const p = line.split(' ');
        resolve(p[1] === '(none)' ? null : p[1]);
      }
    );
  });
}

/* Evaluate a position. Returns {type:'cp'|'mate', value:number} or null.
   Uses movetime (ms) so it doesn't block indefinitely.
   From White's perspective: positive = White ahead, negative = Black ahead. */
function sfEvaluate(fen, movetime) {
  return new Promise(resolve => {
    if (!stockfish || !sfReady || sfBusy) { resolve(null); return; }
    sfBusy = true;
    sfCancelFn = () => { resolve(null); };

    let bestScore = null;

    stockfish.postMessage('position fen ' + fen);
    stockfish.postMessage('go movetime ' + movetime);

    const listener = line => {
      if (line.startsWith('info') && line.includes(' score ')) {
        const cpM   = line.match(/score cp (-?\d+)/);
        const mateM = line.match(/score mate (-?\d+)/);
        if (cpM)   bestScore = { type: 'cp',   value: parseInt(cpM[1],   10) };
        if (mateM) bestScore = { type: 'mate', value: parseInt(mateM[1], 10) };
      }
      if (line.startsWith('bestmove')) {
        sfBusy = false;
        sfCancelFn = null;
        resolve(bestScore);
        return true;
      }
      return false;
    };

    sfCallbacks.push(listener);
  });
}

/* Format an eval score for display */
function formatScore(score, turn) {
  if (!score) return '0.0';
  /* Flip sign if it's black's perspective (info lines from Stockfish are
     always from the side to move, but we normalise to White = positive) */
  let val = score.value;
  if (turn === 'b') val = -val;  // after White's move the stored FEN has Black to move

  if (score.type === 'mate') {
    const sign = val > 0 ? '+' : '';
    return sign + 'M' + Math.abs(val);
  }
  const pawns = val / 100;
  const sign  = pawns > 0 ? '+' : '';
  return sign + pawns.toFixed(1);
}

/* Convert centipawn score to a win-percentage for the eval bar (0–1).
   Uses a sigmoid centred at 0. */
function cpToWinPct(score, turn) {
  if (!score) return 0.5;
  if (score.type === 'mate') {
    let v = score.value;
    if (turn === 'b') v = -v;
    return v > 0 ? 0.97 : 0.03;
  }
  let cp = score.value;
  if (turn === 'b') cp = -cp;
  return 1 / (1 + Math.exp(-cp / 400));
}

/* ── 5. Move Quality (Expected Points model, like Chess.com) ──
   EP loss thresholds: how much win-probability the mover lost (0–1 scale).
   Best ≤0, Excellent ≤0.02, Good ≤0.05, Inaccuracy ≤0.10, Mistake ≤0.20, Blunder >0.20 */
const QUALITY = [
  { maxEP: 0.000, label: 'Best',        cls: 'quality-best',        symbol: '★'  },
  { maxEP: 0.020, label: 'Excellent',   cls: 'quality-great',       symbol: '!'  },
  { maxEP: 0.050, label: 'Good',        cls: 'quality-good',        symbol: ''   },
  { maxEP: 0.100, label: 'Inaccuracy',  cls: 'quality-inaccuracy',  symbol: '?!' },
  { maxEP: 0.200, label: 'Mistake',     cls: 'quality-mistake',     symbol: '?'  },
  { maxEP: 1.000, label: 'Blunder',     cls: 'quality-blunder',     symbol: '??' },
];

/* Win probability for the side to move, given a Stockfish score (always from mover's POV) */
function scoreToMoverWP(score) {
  if (!score) return 0.5;
  if (score.type === 'mate') return score.value > 0 ? 1.0 : 0.0;
  return 1 / (1 + Math.exp(-score.value / 400));
}

function normToWhite(score, turn) {
  if (!score) return 0;
  const cp = score.type === 'mate'
    ? (score.value > 0 ? 10000 : -10000)
    : score.value;
  return turn === 'w' ? cp : -cp;
}

function getQuality(epLoss) {
  for (const q of QUALITY) { if (epLoss <= q.maxEP) return q; }
  return QUALITY[QUALITY.length - 1];
}

/* ── Piece values for sacrifice detection ── */
const PIECE_VALS = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };

/* Returns true if the move gave up material (or moved a piece that can now be recaptured) */
function detectSacrifice(result) {
  const movedVal    = PIECE_VALS[result.piece]    || 0;
  const capturedVal = PIECE_VALS[result.captured] || 0;
  if (movedVal <= capturedVal) return false; // gained or broke even — not a sacrifice
  // Confirm the moved piece can actually be recaptured (opponent has a reply to the destination)
  const opMoves = chess.moves({ verbose: true });
  return opMoves.some(m => m.to === result.to);
}

/* ── Opening Book ── */
/* A move is "Book" if the full game sequence so far is a prefix of a known opening line */
const OPENING_BOOK = [
  // 1.e4 openings
  'e2e4',
  'e2e4 e7e5',
  'e2e4 e7e5 g1f3',
  'e2e4 e7e5 g1f3 b8c6',
  'e2e4 e7e5 g1f3 b8c6 f1b5',          // Ruy Lopez
  'e2e4 e7e5 g1f3 b8c6 f1b5 a7a6',     // Morphy Defense
  'e2e4 e7e5 g1f3 b8c6 f1c4',          // Italian
  'e2e4 e7e5 g1f3 b8c6 f1c4 f8c5',     // Giuoco Piano
  'e2e4 e7e5 g1f3 b8c6 f1c4 g8f6',     // Two Knights
  'e2e4 e7e5 g1f3 b8c6 d2d4',          // Scotch
  'e2e4 e7e5 g1f3 b8c6 d2d4 e5d4',
  'e2e4 e7e5 g1f3 g8f6',               // Petrov
  'e2e4 e7e5 f2f4',                     // King's Gambit
  'e2e4 e7e5 f2f4 e5f4',
  'e2e4 e7e5 b1c3',                     // Vienna
  'e2e4 e7e5 b1c3 b8c6',
  // Sicilian
  'e2e4 c7c5',
  'e2e4 c7c5 g1f3',
  'e2e4 c7c5 g1f3 d7d6',
  'e2e4 c7c5 g1f3 b8c6',
  'e2e4 c7c5 g1f3 e7e6',
  'e2e4 c7c5 b1c3',
  'e2e4 c7c5 c2c3',                     // Alapin
  // French
  'e2e4 e7e6',
  'e2e4 e7e6 d2d4',
  'e2e4 e7e6 d2d4 d7d5',
  'e2e4 e7e6 d2d4 d7d5 b1c3',
  'e2e4 e7e6 d2d4 d7d5 b1d2',          // Tarrasch
  'e2e4 e7e6 d2d4 d7d5 e4e5',          // Advance
  // Caro-Kann
  'e2e4 c7c6',
  'e2e4 c7c6 d2d4',
  'e2e4 c7c6 d2d4 d7d5',
  'e2e4 c7c6 d2d4 d7d5 b1c3',
  'e2e4 c7c6 d2d4 d7d5 e4e5',
  // Pirc / Modern
  'e2e4 d7d6',
  'e2e4 g7g6',
  // 1.d4 openings
  'd2d4',
  'd2d4 d7d5',
  'd2d4 d7d5 c2c4',                     // Queen's Gambit
  'd2d4 d7d5 c2c4 e7e6',               // QGD
  'd2d4 d7d5 c2c4 c7c6',               // Slav
  'd2d4 d7d5 c2c4 d5c4',               // QGA
  'd2d4 d7d5 g1f3',
  'd2d4 d7d5 g1f3 g8f6',
  // Indian Defenses
  'd2d4 g8f6',
  'd2d4 g8f6 c2c4',
  'd2d4 g8f6 c2c4 g7g6',               // King's Indian
  'd2d4 g8f6 c2c4 g7g6 b1c3',
  'd2d4 g8f6 c2c4 e7e6',               // Nimzo / QID setup
  'd2d4 g8f6 c2c4 e7e6 b1c3 f8b4',    // Nimzo-Indian
  'd2d4 g8f6 c2c4 e7e6 g1f3 b7b6',    // Queen's Indian
  'd2d4 g8f6 c2c4 c7c5',              // Benoni
  'd2d4 f7f5',                          // Dutch
  // English
  'c2c4',
  'c2c4 e7e5',
  'c2c4 c7c5',
  'c2c4 g8f6',
  'c2c4 e7e6',
  // Reti
  'g1f3',
  'g1f3 d7d5',
  'g1f3 g8f6',
  'g1f3 d7d5 c2c4',
  // Other first moves
  'f2f4',                               // Bird's Opening
  'g2g3',
  'b2b3',                               // Larsen's
  'b1c3',                               // Van Geet
];

function isBookMove() {
  const hist = chess.history({ verbose: true });
  if (hist.length === 0) return false;
  const uciSeq = hist.map(m => m.from + m.to + (m.promotion || '')).join(' ');
  return OPENING_BOOK.some(line => line === uciSeq || line.startsWith(uciSeq + ' '));
}

function flashQuality(epLoss, cpLoss, playerSide, preWP, moverPostWP, wasSacrifice, isBook) {
  let q;
  const whoLabel = playerSide === 'w' ? 'White' : 'Black';
  const sign = cpLoss > 0 ? '-' : '+';
  const pawns = (Math.abs(cpLoss) / 100).toFixed(1);

  if (isBook) {
    $qualityBar.className = 'quality-bar quality-book';
    $qualityBar.textContent = `Book move (${whoLabel} ${sign}${pawns}♟)`;
    return;
  }

  if (wasSacrifice && epLoss <= 0.02 && preWP < 0.75 && moverPostWP > 0.50) {
    /* Brilliant: piece sacrifice that still leads to a good position */
    $qualityBar.className = 'quality-bar quality-brilliant';
    $qualityBar.textContent = `Brilliant!! (${whoLabel} ${sign}${pawns}♟)`;
    return;
  }

  if (preWP < 0.52 && moverPostWP > 0.58 && (moverPostWP - preWP) > 0.08) {
    /* Great: position flipped from losing/equal to winning */
    $qualityBar.className = 'quality-bar quality-great-move';
    $qualityBar.textContent = `Great! (${whoLabel} ${sign}${pawns}♟)`;
    return;
  }

  q = getQuality(Math.max(0, epLoss));
  const sym = q.symbol ? ` ${q.symbol}` : '';
  $qualityBar.className = `quality-bar ${q.cls}`;
  $qualityBar.textContent = `${q.label}${sym} (${whoLabel} ${sign}${pawns}♟)`;
}

function clearQualityBar() {
  $qualityBar.className = 'quality-bar';
  $qualityBar.textContent = '';
}

/* ── 6. Game State ── */
let chess;
let selectedSq       = null;
let legalMoves       = [];
let lastMove         = null;
let currentElo       = 800;
let gameOver         = false;
let gameMode         = 'computer'; // 'computer' | 'human'
let pieceSet         = 'classic';
let evalEnabled      = false;
let previewEnabled   = false;
let settingsOpen     = false;
let historyOpen      = false;
let hintTimeout      = null;
let promotionResolve = null;
let previewDebounce  = null;
let lastEvalScore    = null;
let preMoveEvalScore = null;  // eval just before the human's move (for quality calc)
let preMoveEvalTurn  = null;  // whose turn it was when preMoveEvalScore was stored

const FILES = ['a','b','c','d','e','f','g','h'];
const RANKS = ['8','7','6','5','4','3','2','1'];

/* ── 7. DOM Refs ── */
const $board          = document.getElementById('board');
const $status         = document.getElementById('status-bar');
const $qualityBar     = document.getElementById('quality-bar');
const $historyList    = document.getElementById('history-list');
const $historyPanel   = document.getElementById('history-panel');
const $historyArrow   = document.getElementById('history-arrow');
const $newGameBtn     = document.getElementById('new-game-btn');
const $historyToggle  = document.getElementById('history-toggle');
const $settingsToggle = document.getElementById('settings-toggle');
const $settingsPanel  = document.getElementById('settings-panel');
const $settingsArrow  = document.getElementById('settings-arrow');
const $splash         = document.getElementById('splash');
const $app            = document.getElementById('app');
const $splashBtn      = document.getElementById('splash-btn');
const $promoModal     = document.getElementById('promotion-modal');
const $hintBtn        = document.getElementById('hint-btn');
const $undoBtn        = document.getElementById('undo-btn');
const $eloSlider      = document.getElementById('elo-slider');
const $eloValue       = document.getElementById('elo-value');
const $eloTier        = document.getElementById('elo-tier');
const $toggleEval     = document.getElementById('toggle-eval');
const $togglePreview  = document.getElementById('toggle-preview');
const $evalBarWrap    = document.getElementById('eval-bar-wrap');
const $evalBarWhite   = document.getElementById('eval-bar-white');
const $evalScore      = document.getElementById('eval-score');

/* ── 8. Splash ── */
function enterApp(mode) {
  gameMode = mode;
  $splash.classList.add('fade-out');
  $splash.style.display = '';
  $app.classList.remove('hidden');
  setTimeout(() => { $splash.style.display = 'none'; }, 650);
  $hintBtn.style.display = '';
  startNewGame();
}

function returnToSplash() {
  sfStop();
  clearQualityBar();
  $app.classList.add('hidden');
  $splash.style.display = '';
  $splash.classList.remove('fade-out');
}

function initSplash() {
  document.getElementById('splash-vs-computer').addEventListener('click', () => enterApp('computer'));
  document.getElementById('splash-vs-human').addEventListener('click', () => enterApp('human'));
}

/* ── 9. Board Rendering ── */
function squareEl(sq) { return document.querySelector(`[data-sq="${sq}"]`); }

function makePieceEl(piece, sq) {
  if (pieceSet === 'family') {
    const wrapper = document.createElement('div');
    wrapper.className = `piece-wrapper ${piece.color === 'w' ? 'white' : 'black'}`;
    wrapper.dataset.sq = sq;

    const img = document.createElement('img');
    const type = piece.type.toUpperCase();
    const raw  = FAMILY_IMGS[type];
    const base = (typeof raw === 'object')
      ? (raw[sq[0]] || Object.values(raw)[0])  // file-keyed (P, N, etc.) with fallback
      : raw;
    img.className = `piece-img${piece.color === 'b' ? ' black-piece' : ''}`;
    img.alt = '';
    img.draggable = false;

    const cachedSrc = pieceImgMap[sq];
    if (cachedSrc) {
      /* Use the already-resolved src — no fallback chain, no flicker, piece identity preserved */
      img.src = cachedSrc;
      if (/_white\.|_black\./.test(cachedSrc)) img.classList.remove('black-piece');
    } else {
      const onFail = () => {
        wrapper.remove();
        const cell = squareEl(sq);
        if (!cell) return;
        const fb = document.createElement('div');
        fb.className = `piece ${piece.color === 'w' ? 'white' : 'black'}`;
        fb.textContent = UNICODE[(piece.color === 'w' ? 'w' : 'b') + piece.type.toUpperCase()];
        fb.dataset.sq = sq;
        cell.appendChild(fb);
      };
      setFamilyImg(img, base || '', piece.color, (resolvedSrc, isColorSpecific) => {
        if (isColorSpecific) img.classList.remove('black-piece');
        pieceImgMap[sq] = resolvedSrc; /* cache so next render is instant */
      }, onFail);
    }

    wrapper.appendChild(img);
    return wrapper;
  }

  const el = document.createElement('div');
  el.className = `piece ${piece.color === 'w' ? 'white' : 'black'}`;
  el.textContent = UNICODE[(piece.color === 'w' ? 'w' : 'b') + piece.type.toUpperCase()];
  el.dataset.sq = sq;
  return el;
}

function renderBoard() {
  $board.innerHTML = '';

  RANKS.forEach((rank, ri) => {
    FILES.forEach((file, fi) => {
      const sq = file + rank;
      const isLight = (ri + fi) % 2 === 0;

      const cell = document.createElement('div');
      cell.className = `square ${isLight ? 'light' : 'dark'}`;
      cell.dataset.sq = sq;

      if (fi === 0) {
        const r = document.createElement('span');
        r.className = 'coord coord-rank';
        r.textContent = rank;
        cell.appendChild(r);
      }
      if (ri === 7) {
        const f = document.createElement('span');
        f.className = 'coord coord-file';
        f.textContent = file;
        cell.appendChild(f);
      }

      const piece = chess.get(sq);
      if (piece) cell.appendChild(makePieceEl(piece, sq));

      if (lastMove) {
        if (sq === lastMove.from) cell.classList.add('last-move-from');
        if (sq === lastMove.to)   cell.classList.add('last-move-to');
      }

      if (chess.in_check()) {
        const turn = chess.turn();
        const board = chess.board();
        for (let r2 = 0; r2 < 8; r2++) {
          for (let f2 = 0; f2 < 8; f2++) {
            const p = board[r2][f2];
            if (p && p.type === 'k' && p.color === turn) {
              const kSq = FILES[f2] + (8 - r2);
              if (sq === kSq) cell.classList.add('in-check');
            }
          }
        }
      }

      cell.addEventListener('click', () => onSquareClick(sq));
      $board.appendChild(cell);
    });
  });

  updateBoardSize();
}

/* Dynamically set the board CSS variable based on current eval bar visibility */
function updateBoardSize() {
  const evalH   = evalEnabled ? 28 : 0;
  const fixedH  = 48 + 40 + 22 + evalH + 56 + 40 + 72 + 16; /* header+status+quality+eval+action-row+piece-row+section-toggles+padding */
  const size    = `min(920px, calc(100dvh - ${fixedH}px - 16px), calc(100vw - 16px))`;
  document.getElementById('board').style.setProperty('--board-size-calc', size);
  document.getElementById('board').style.width  = size;
  document.getElementById('board').style.height = size;
}

function applySelectionHighlights() {
  document.querySelectorAll('.square').forEach(el => {
    el.classList.remove('selected');
    el.querySelector('.move-dot')?.remove();
    el.querySelector('.capture-ring')?.remove();
    el.querySelector('.preview-badge')?.remove();
    el.classList.remove('preview-target');
  });

  if (!selectedSq) return;

  const selEl = squareEl(selectedSq);
  if (selEl) selEl.classList.add('selected');

  legalMoves.forEach(mv => {
    const el = squareEl(mv.to);
    if (!el) return;
    if (chess.get(mv.to)) {
      const ring = document.createElement('div');
      ring.className = 'capture-ring';
      el.appendChild(ring);
    } else {
      const dot = document.createElement('div');
      dot.className = 'move-dot';
      el.appendChild(dot);
    }
  });
}

/* ── 9. Status ── */
function updateStatus() {
  $status.className = 'status-bar';

  if (chess.in_checkmate()) {
    if (gameMode === 'human') {
      $status.textContent = (chess.turn() === 'b' ? 'White' : 'Black') + ' wins! 🏆';
    } else {
      $status.textContent = chess.turn() === 'b' ? 'Checkmate — You win! 🏆' : 'Checkmate — AI wins.';
    }
    $status.classList.add('game-over');
    gameOver = true; return;
  }
  if (chess.in_stalemate()) {
    $status.textContent = 'Stalemate — Draw';
    $status.classList.add('game-over');
    gameOver = true; return;
  }
  if (chess.in_draw()) {
    $status.textContent = 'Draw by rule';
    $status.classList.add('game-over');
    gameOver = true; return;
  }
  if (chess.in_check()) {
    if (gameMode === 'human') {
      $status.textContent = (chess.turn() === 'w' ? 'White' : 'Black') + ' is in check ⚠️';
    } else {
      $status.textContent = chess.turn() === 'w' ? '⚠️ Check — your move' : '⚠️ AI is in check';
    }
    $status.classList.add('check'); return;
  }
  if (gameMode === 'human') {
    $status.textContent = (chess.turn() === 'w' ? '♙ White' : '♟ Black') + "'s turn";
  } else {
    $status.textContent = chess.turn() === 'w' ? 'Your turn' : 'AI thinking…';
    if (chess.turn() === 'b') $status.classList.add('thinking');
  }
}

/* ── 10. Eval Bar ── */
function showEvalBar(score, turn) {
  if (!evalEnabled) return;
  lastEvalScore = score;
  const pct     = cpToWinPct(score, turn) * 100;
  $evalBarWhite.style.width = pct.toFixed(1) + '%';
  $evalScore.textContent    = formatScore(score, turn);
}

function resetEvalBar() {
  $evalBarWhite.style.width = '50%';
  $evalScore.textContent    = '0.0';
}

async function runEval() {
  if (!evalEnabled || sfBusy || chess.game_over()) return;
  const fen   = chess.fen();
  const turn  = chess.turn(); // who is to move AFTER the last move (i.e., next player)
  const score = await sfEvaluate(fen, 400);
  /* sfEvaluate returns score from the side to move, so we pass turn to formatScore/cpToWinPct */
  showEvalBar(score, turn);
}

/* ── 11. Move History ── */
function refreshHistory() {
  const history = chess.history({ verbose: false });
  $historyList.innerHTML = '';
  history.forEach((san, i) => {
    const isWhite = i % 2 === 0;
    const span = document.createElement('span');
    span.className = `history-move ${isWhite ? 'white-move' : 'black-move'}`;
    span.textContent = isWhite ? `${Math.floor(i/2)+1}. ${san}` : san;
    $historyList.appendChild(span);
  });
  $historyList.scrollLeft = $historyList.scrollWidth;
}

/* ── 12. Promotion ── */
function askPromotion() {
  return new Promise(resolve => {
    promotionResolve = resolve;
    $promoModal.classList.remove('hidden');
  });
}

/* ── 13. Make a Move ── */
async function makeMove(from, to, promoPiece) {
  const piece  = chess.get(from);
  const isPromo = piece && piece.type === 'p' &&
    ((piece.color === 'w' && to[1] === '8') || (piece.color === 'b' && to[1] === '1'));

  if (isPromo && !promoPiece) {
    const chosen = await askPromotion();
    return makeMove(from, to, chosen);
  }

  clearQualityBar();
  const moveObj = { from, to };
  if (promoPiece) moveObj.promotion = promoPiece;

  /* Snapshot whose turn it is and the pre-move eval for quality calc */
  const moverSide       = chess.turn();
  const savedPreScore   = preMoveEvalScore;
  const savedPreTurn    = preMoveEvalTurn;

  const result = chess.move(moveObj);
  if (!result) return false;

  applyMoveToImgMap(result);
  lastMove   = { from, to };
  selectedSq = null;
  legalMoves = [];
  gameOver   = false;

  /* Detect book / sacrifice now, while board is in post-move state */
  const moveIsBook      = isBookMove();
  const moveIsSacrifice = !moveIsBook && detectSacrifice(result);

  renderBoard();
  updateStatus();
  refreshHistory();

  if (!chess.game_over()) {
    /* Run post-move eval (quick, 300ms) then show quality and update bar */
    if (!sfBusy) {
      const postScore = await sfEvaluate(chess.fen(), 300);
      if (postScore && savedPreScore) {
        /* Expected Points — win-probability from mover's perspective */
        const preWP       = scoreToMoverWP(savedPreScore);
        const moverPostWP = 1 - scoreToMoverWP(postScore); // opponent to move now
        const epLoss      = preWP - moverPostWP;           // negative = position improved

        /* Centipawn change (White's perspective) for the display number */
        const preW   = normToWhite(savedPreScore, savedPreTurn || moverSide);
        const postW  = normToWhite(postScore, chess.turn());
        const cpLoss = moverSide === 'w' ? (preW - postW) : (postW - preW);

        flashQuality(epLoss, cpLoss, moverSide, preWP, moverPostWP, moveIsSacrifice, moveIsBook);
      }
      showEvalBar(postScore, chess.turn());
      /* Store as pre-move eval for the next player */
      preMoveEvalScore = postScore;
      preMoveEvalTurn  = chess.turn();
    }

    if (gameMode === 'computer') triggerAI();
  } else {
    runEval();
  }
  return true;
}

/* ── 14. AI Turn ── */
async function triggerAI() {
  if (gameMode === 'human' || chess.turn() !== 'b' || chess.game_over()) return;

  /* If eval is running, cancel it so AI can go */
  if (sfBusy) sfStop();

  updateStatus();

  const elo    = currentElo;
  const rate   = blunderRate(elo);
  let moveUci  = null;

  if (rate > 0 && Math.random() < rate) {
    /* Random legal move (simulates weak/blundering player) */
    const moves = chess.moves({ verbose: true });
    if (moves.length > 0) {
      const m = moves[Math.floor(Math.random() * moves.length)];
      moveUci = m.from + m.to + (m.promotion || '');
    }
  } else {
    const depth = elo >= 1320 ? 10 : lowEloDepth(elo);
    moveUci = await sfBestMove(chess.fen(), depth);
  }

  if (!moveUci || chess.game_over()) return;

  const from  = moveUci.slice(0, 2);
  const to    = moveUci.slice(2, 4);
  const promo = moveUci.length === 5 ? moveUci[4] : 'q';

  const result = chess.move({ from, to, promotion: promo });
  if (!result) return;

  applyMoveToImgMap(result);
  lastMove = { from, to };
  renderBoard();
  updateStatus();
  refreshHistory();

  const toEl = squareEl(to);
  if (toEl) {
    const pEl = toEl.querySelector('.piece, .piece-wrapper');
    if (pEl) { pEl.classList.add('just-moved'); setTimeout(() => pEl.classList.remove('just-moved'), 250); }
  }

  /* Always eval after AI move so next human move can get quality feedback */
  if (!sfBusy) {
    const aiPostScore = await sfEvaluate(chess.fen(), 300);
    preMoveEvalScore = aiPostScore;
    preMoveEvalTurn  = chess.turn();
    if (evalEnabled) showEvalBar(aiPostScore, chess.turn());
  } else {
    runEval();
  }
}

/* ── 15. Move Preview (hover eval) ── */
function getSquareFromPoint(clientX, clientY) {
  const rect = $board.getBoundingClientRect();
  if (clientX < rect.left || clientX > rect.right || clientY < rect.top || clientY > rect.bottom) return null;
  const col = Math.floor((clientX - rect.left) / (rect.width  / 8));
  const row = Math.floor((clientY - rect.top)  / (rect.height / 8));
  if (col < 0 || col > 7 || row < 0 || row > 7) return null;
  return FILES[col] + RANKS[row];
}

async function doMovePreview(targetSq) {
  if (!previewEnabled || !selectedSq || sfBusy || gameOver) return;
  if (!legalMoves.some(m => m.to === targetSq)) return;

  /* Quick eval of the position after this move */
  const tempChess = new Chess(chess.fen());
  const piece = tempChess.get(selectedSq);
  const isPromo = piece && piece.type === 'p' &&
    ((piece.color === 'w' && targetSq[1] === '8') || (piece.color === 'b' && targetSq[1] === '1'));

  const moveObj = { from: selectedSq, to: targetSq };
  if (isPromo) moveObj.promotion = 'q';
  const result = tempChess.move(moveObj);
  if (!result) return;

  /* Highlight the target */
  document.querySelectorAll('.preview-target').forEach(el => el.classList.remove('preview-target'));
  document.querySelectorAll('.preview-badge').forEach(el => el.remove());
  const targetEl = squareEl(targetSq);
  if (targetEl) targetEl.classList.add('preview-target');

  const prevStatus = $status.textContent;
  const prevClass  = $status.className;

  $status.textContent = '🔍 Evaluating ' + result.san + '…';
  $status.className   = 'status-bar thinking';

  const score = await sfEvaluate(tempChess.fen(), 200);

  $status.textContent = prevStatus;
  $status.className   = prevClass;

  if (!score) return;

  /* Show badge on the target square */
  const badgeEl = squareEl(targetSq);
  if (badgeEl) {
    const badge = document.createElement('div');
    badge.className = 'preview-badge';
    /* Score is from the side to move after the move (Black), flip for White perspective */
    badge.textContent = formatScore(score, tempChess.turn());
    badgeEl.appendChild(badge);
  }
}

function handleBoardHover(clientX, clientY) {
  if (!previewEnabled || !selectedSq || sfBusy) return;
  const sq = getSquareFromPoint(clientX, clientY);
  if (!sq || sq === selectedSq) return;
  if (!legalMoves.some(m => m.to === sq)) return;

  clearTimeout(previewDebounce);
  previewDebounce = setTimeout(() => doMovePreview(sq), 160);
}

/* ── 16. Hint ── */
async function doHint() {
  if (gameOver) return;
  if (gameMode === 'computer' && chess.turn() !== 'w') return;
  if (!sfReady) { $status.textContent = 'AI not ready yet…'; return; }
  if (sfBusy) return;

  $hintBtn.disabled = true;
  clearHintHighlights();

  const prevText  = $status.textContent;
  const prevClass = $status.className;
  $status.textContent = '💡 Calculating hint…';
  $status.className   = 'status-bar thinking';

  const depth    = Math.min(12, Math.max(6, Math.floor(currentElo / 200)));
  const bestMove = await sfBestMove(chess.fen(), depth);

  $status.textContent = prevText;
  $status.className   = prevClass;
  $hintBtn.disabled   = false;

  if (!bestMove) return;

  const hFrom = bestMove.slice(0, 2);
  const hTo   = bestMove.slice(2, 4);

  squareEl(hFrom)?.classList.add('hint-from');
  squareEl(hTo)?.classList.add('hint-to');

  if (hintTimeout) clearTimeout(hintTimeout);
  hintTimeout = setTimeout(() => { clearHintHighlights(); hintTimeout = null; }, 3500);
}

function clearHintHighlights() {
  document.querySelectorAll('.hint-from, .hint-to').forEach(el => {
    el.classList.remove('hint-from', 'hint-to');
  });
}

/* ── 17. Undo ── */
function doUndo() {
  if (chess.history().length === 0) {
    $status.textContent = 'Nothing to undo';
    setTimeout(updateStatus, 1200);
    return;
  }

  sfStop();

  if (gameMode === 'human') {
    /* Undo just the last half-move (one player's move) */
    chess.undo();
  } else {
    /* Undo AI move + player move (2 half-moves) so player is back in control */
    chess.undo();
    if (chess.history().length > 0 && chess.turn() === 'w') chess.undo();
    if (chess.turn() === 'b' && chess.history().length > 0) chess.undo();
  }

  selectedSq  = null;
  legalMoves  = [];
  gameOver    = false;
  lastMove    = null;
  pieceImgMap = {}; /* clear cache — pieces return to starting squares, re-resolve cleanly */

  const hist = chess.history({ verbose: true });
  if (hist.length > 0) {
    const last = hist[hist.length - 1];
    lastMove = { from: last.from, to: last.to };
  }

  clearHintHighlights();
  document.querySelectorAll('.preview-target').forEach(el => el.classList.remove('preview-target'));
  document.querySelectorAll('.preview-badge').forEach(el => el.remove());

  preMoveEvalScore = null;
  preMoveEvalTurn  = null;
  clearQualityBar();

  renderBoard();
  updateStatus();
  refreshHistory();
  resetEvalBar();

  /* Re-seed eval so the next human move gets quality feedback */
  setTimeout(async () => {
    if (sfReady && !sfBusy) {
      preMoveEvalScore = await sfEvaluate(chess.fen(), 300);
      preMoveEvalTurn  = chess.turn();
      if (evalEnabled) showEvalBar(preMoveEvalScore, chess.turn());
    }
  }, 400);
}

/* ── 18. Square Click ── */
function onSquareClick(sq) {
  /* In computer mode, only White can move; in human mode, whoever's turn it is */
  const currentTurn = chess.turn();
  if (gameOver) return;
  if (gameMode === 'computer' && currentTurn !== 'w') return;

  clearHintHighlights();
  document.querySelectorAll('.preview-target').forEach(el => el.classList.remove('preview-target'));
  document.querySelectorAll('.preview-badge').forEach(el => el.remove());

  if (selectedSq) {
    const isLegal = legalMoves.some(m => m.to === sq);
    if (isLegal) { makeMove(selectedSq, sq); return; }
  }

  const piece = chess.get(sq);
  if (piece && piece.color === currentTurn) {
    selectedSq = sq;
    legalMoves = chess.moves({ square: sq, verbose: true });
    applySelectionHighlights();
    return;
  }

  selectedSq = null;
  legalMoves = [];
  applySelectionHighlights();
}

/* ── 19. Drag & Drop ── */
let dragGhost = null;
let dragFrom  = null;
let dragOffX  = 0;
let dragOffY  = 0;

function pieceAt(clientX, clientY) {
  if (dragGhost) dragGhost.style.visibility = 'hidden';
  const el = document.elementFromPoint(clientX, clientY);
  if (dragGhost) dragGhost.style.visibility = '';
  const cell = el?.closest('[data-sq]');
  return cell ? cell.dataset.sq : null;
}

function startDrag(sq, clientX, clientY, originalEl) {
  const currentTurn = chess.turn();
  if (gameOver) return;
  if (gameMode === 'computer' && currentTurn !== 'w') return;
  const piece = chess.get(sq);
  if (!piece || piece.color !== currentTurn) return;

  dragFrom   = sq;
  selectedSq = sq;
  legalMoves = chess.moves({ square: sq, verbose: true });
  applySelectionHighlights();
  clearHintHighlights();

  dragGhost = originalEl.cloneNode(true);
  const rect = originalEl.getBoundingClientRect();
  dragOffX = clientX - rect.left;
  dragOffY = clientY - rect.top;

  dragGhost.classList.add('dragging');
  dragGhost.style.width  = rect.width  + 'px';
  dragGhost.style.height = rect.height + 'px';
  dragGhost.style.left   = (clientX - dragOffX) + 'px';
  dragGhost.style.top    = (clientY - dragOffY)  + 'px';
  document.body.appendChild(dragGhost);
}

function moveDrag(clientX, clientY) {
  if (!dragGhost) return;
  dragGhost.style.left = (clientX - dragOffX) + 'px';
  dragGhost.style.top  = (clientY - dragOffY)  + 'px';
  handleBoardHover(clientX, clientY);
}

function endDrag(clientX, clientY) {
  if (!dragGhost) return;
  const targetSq = pieceAt(clientX, clientY);
  dragGhost.remove();
  dragGhost = null;

  if (!targetSq || targetSq === dragFrom) { dragFrom = null; return; }
  const isLegal = legalMoves.some(m => m.to === targetSq);
  if (isLegal) makeMove(dragFrom, targetSq);
  dragFrom = null;
}

function setupDrag() {
  $board.addEventListener('mousedown', e => {
    const cell = e.target.closest('[data-sq]');
    if (!cell) return;
    const pEl = cell.querySelector('.piece, .piece-wrapper');
    if (!pEl) return;
    e.preventDefault();
    startDrag(cell.dataset.sq, e.clientX, e.clientY, pEl);
  });

  window.addEventListener('mousemove', e => {
    moveDrag(e.clientX, e.clientY);
    if (!dragGhost) handleBoardHover(e.clientX, e.clientY);
  });

  window.addEventListener('mouseup',  e => endDrag(e.clientX, e.clientY));

  $board.addEventListener('touchstart', e => {
    const touch = e.changedTouches[0];
    const cell  = e.target.closest('[data-sq]');
    if (!cell) return;
    const pEl = cell.querySelector('.piece, .piece-wrapper');
    if (!pEl) return;
    e.preventDefault();
    startDrag(cell.dataset.sq, touch.clientX, touch.clientY, pEl);
  }, { passive: false });

  window.addEventListener('touchmove', e => {
    const t = e.changedTouches[0];
    moveDrag(t.clientX, t.clientY);
  }, { passive: false });

  window.addEventListener('touchend', e => {
    endDrag(e.changedTouches[0].clientX, e.changedTouches[0].clientY);
  });
}

/* ── 20. ELO Slider UI ── */
function updateEloUI(elo) {
  $eloValue.textContent = elo;
  $eloTier.textContent  = eloTier(elo);
  /* Update slider fill gradient */
  const pct = ((elo - 250) / (3000 - 250) * 100).toFixed(1);
  $eloSlider.style.setProperty('--slider-pct', pct + '%');
}

/* ── 21. Controls Setup ── */
function setupControls() {
  /* ELO Slider */
  $eloSlider.addEventListener('input', () => {
    currentElo = parseInt($eloSlider.value, 10);
    updateEloUI(currentElo);
    applyEloSettings(currentElo);
  });

  /* Eval toggle */
  $toggleEval.addEventListener('click', () => {
    evalEnabled = !evalEnabled;
    $toggleEval.dataset.active = String(evalEnabled);
    $evalBarWrap.classList.toggle('visible', evalEnabled);
    updateBoardSize();
    if (evalEnabled && !sfBusy && !chess.game_over()) runEval();
    if (!evalEnabled) resetEvalBar();
  });

  /* Move preview toggle */
  $togglePreview.addEventListener('click', () => {
    previewEnabled = !previewEnabled;
    $togglePreview.dataset.active = String(previewEnabled);
  });

  /* Settings panel */
  $settingsToggle.addEventListener('click', () => {
    settingsOpen = !settingsOpen;
    $settingsPanel.classList.toggle('open', settingsOpen);
    $settingsArrow.textContent = settingsOpen ? '▲' : '▼';
  });

  /* History panel */
  $historyToggle.addEventListener('click', () => {
    historyOpen = !historyOpen;
    $historyPanel.classList.toggle('open', historyOpen);
    $historyArrow.textContent = historyOpen ? '▲' : '▼';
  });

  /* Action buttons */
  $hintBtn.addEventListener('click', doHint);
  $undoBtn.addEventListener('click', doUndo);
  $newGameBtn.addEventListener('click', returnToSplash);

  /* Piece set */
  document.querySelectorAll('.set-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.set-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      pieceSet = btn.dataset.set;
      renderBoard();
      applySelectionHighlights();
    });
  });

  /* Promotion modal */
  $promoModal.querySelectorAll('.promo-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      $promoModal.classList.add('hidden');
      if (promotionResolve) { promotionResolve(btn.dataset.piece); promotionResolve = null; }
    });
  });
}

/* ── 22. New Game ── */
function startNewGame() {
  sfStop();

  chess            = new Chess();
  selectedSq       = null;
  legalMoves       = [];
  lastMove         = null;
  gameOver         = false;
  preMoveEvalScore = null;
  preMoveEvalTurn  = null;
  pieceImgMap      = {};
  clearQualityBar();

  if (stockfish && sfReady) stockfish.postMessage('ucinewgame');

  clearHintHighlights();
  document.querySelectorAll('.preview-target').forEach(el => el.classList.remove('preview-target'));
  document.querySelectorAll('.preview-badge').forEach(el => el.remove());

  renderBoard();
  updateStatus();
  refreshHistory();
  resetEvalBar();

  /* Seed preMoveEvalScore so the very first human move gets quality feedback */
  setTimeout(async () => {
    if (sfReady && !sfBusy) {
      preMoveEvalScore = await sfEvaluate(chess.fen(), 300);
      preMoveEvalTurn  = chess.turn();
    }
  }, 800);
}

/* ── 23. Init ── */
function initApp() {
  if (typeof Chess === 'undefined') { setTimeout(initApp, 100); return; }

  initSplash();
  setupControls();
  setupDrag();
  loadStockfish();
  updateEloUI(currentElo);
}
