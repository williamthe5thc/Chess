/**
 * Chess for Dad — Father's Day Gift PWA
 * Vanilla JS · chess.js · Stockfish WASM via blob-URL Worker
 */

/* ── 1. Bootstrap: load chess.js then init ── */
(function bootstrap() {
  const s = document.createElement('script');
  s.src = 'https://cdnjs.cloudflare.com/ajax/libs/chess.js/0.10.3/chess.min.js';
  s.onload = initApp;
  s.onerror = () => alert('Failed to load chess.js. Check your connection.');
  document.head.appendChild(s);
})();

/* ── 2. Piece Unicode Map ── */
const UNICODE = {
  wK:'♔', wQ:'♕', wR:'♖', wB:'♗', wN:'♘', wP:'♙',
  bK:'♚', bQ:'♛', bR:'♜', bB:'♝', bN:'♞', bP:'♟',
};

/*
 * ── 3. Family Piece Image Map ──
 * Drop your photos into pieces/family/ with these exact filenames.
 * Supported extensions: jpg, jpeg, png, webp, svg (code tries jpg first).
 * Pawn images are keyed by the pawn's current file (a-h) so each dog
 * shows on its column. Files are relative to index.html.
 *
 * king.jpg   → Dad
 * queen.jpg  → Mom
 * knight.jpg → Kids / spouse on knight squares
 * bishop.jpg → Kids / spouse on bishop squares
 * rook.jpg   → Kids / spouse on rook squares
 * pawn_a.jpg through pawn_h.jpg → 8 dogs
 */
const FAMILY_IMGS = {
  K: 'pieces/family/king.svg',
  Q: 'pieces/family/queen.svg',
  N: 'pieces/family/knight.svg',
  B: 'pieces/family/bishop.svg',
  R: 'pieces/family/rook.svg',
  P: { a:'pieces/family/pawn_a.svg', b:'pieces/family/pawn_b.svg',
       c:'pieces/family/pawn_c.svg', d:'pieces/family/pawn_d.svg',
       e:'pieces/family/pawn_e.svg', f:'pieces/family/pawn_f.svg',
       g:'pieces/family/pawn_g.svg', h:'pieces/family/pawn_h.svg' },
};

/* ── 4. Stockfish Worker ── */
let stockfish = null;
let sfReady = false;
let sfCallbacks = [];

function loadStockfish() {
  const sfUrl = 'https://cdnjs.cloudflare.com/ajax/libs/stockfish.js/10.0.2/stockfish.js';
  fetch(sfUrl)
    .then(r => r.text())
    .then(code => {
      const blob = new Blob([code], { type: 'application/javascript' });
      stockfish = new Worker(URL.createObjectURL(blob));
      stockfish.onmessage = e => { sfCallbacks = sfCallbacks.filter(cb => !cb(e.data)); };
      stockfish.onerror   = err => console.error('Stockfish:', err);
      stockfish.postMessage('uci');
      stockfish.postMessage('isready');
      sfOnce(l => l === 'readyok', () => { sfReady = true; });
    })
    .catch(() => {
      try {
        stockfish = new Worker(sfUrl);
        stockfish.onmessage = e => { sfCallbacks = sfCallbacks.filter(cb => !cb(e.data)); };
        stockfish.postMessage('uci');
        stockfish.postMessage('isready');
        sfOnce(l => l === 'readyok', () => { sfReady = true; });
      } catch (_) { console.error('Stockfish unavailable.'); }
    });
}

function sfOnce(predicate, resolve) {
  sfCallbacks.push(line => { if (predicate(line)) { resolve(line); return true; } return false; });
}

function sfBestMove(fen, depthMin, depthMax) {
  return new Promise(resolve => {
    if (!stockfish || !sfReady) { resolve(null); return; }
    const depth = depthMin + Math.floor(Math.random() * (depthMax - depthMin + 1));
    stockfish.postMessage('position fen ' + fen);
    stockfish.postMessage('go depth ' + depth);
    sfOnce(
      line => line.startsWith('bestmove'),
      line => { const p = line.split(' '); resolve(p[1] === '(none)' ? null : p[1]); }
    );
  });
}

/* ── 5. Game State ── */
let chess;
let selectedSq   = null;
let legalMoves   = [];
let lastMove     = null;
let depthMin     = 1;
let depthMax     = 2;
let gameOver     = false;
let historyOpen  = false;
let pieceSet     = 'classic';   // 'classic' | 'family'
let hintTimeout  = null;
let promotionResolve = null;

const FILES = ['a','b','c','d','e','f','g','h'];
const RANKS = ['8','7','6','5','4','3','2','1'];

/* ── 6. DOM Refs ── */
const $board         = document.getElementById('board');
const $status        = document.getElementById('status-bar');
const $historyList   = document.getElementById('history-list');
const $historyPanel  = document.getElementById('history-panel');
const $historyArrow  = document.getElementById('history-arrow');
const $newGameBtn    = document.getElementById('new-game-btn');
const $historyToggle = document.getElementById('history-toggle');
const $splash        = document.getElementById('splash');
const $app           = document.getElementById('app');
const $splashBtn     = document.getElementById('splash-btn');
const $promoModal    = document.getElementById('promotion-modal');
const $hintBtn       = document.getElementById('hint-btn');
const $undoBtn       = document.getElementById('undo-btn');

/* ── 7. Splash ── */
function initSplash() {
  $splashBtn.addEventListener('click', () => {
    $splash.classList.add('fade-out');
    $app.classList.remove('hidden');
    setTimeout(() => { $splash.style.display = 'none'; }, 650);
  });
}

/* ── 8. Board Rendering ── */
function squareEl(sq) { return document.querySelector(`[data-sq="${sq}"]`); }

function makePieceEl(piece, sq) {
  if (pieceSet === 'family') {
    const wrapper = document.createElement('div');
    wrapper.className = `piece-wrapper ${piece.color === 'w' ? 'white' : 'black'}`;
    wrapper.dataset.sq = sq;

    const img = document.createElement('img');
    const type = piece.type.toUpperCase();
    const src  = type === 'P' ? FAMILY_IMGS.P[sq[0]] : FAMILY_IMGS[type];
    img.src = src || '';
    img.className = `piece-img ${piece.color === 'b' ? 'black-piece' : ''}`;
    img.alt = '';
    img.draggable = false;

    img.onerror = () => {
      /* Fallback to unicode if image missing */
      wrapper.remove();
      const cell = squareEl(sq);
      if (cell) {
        const fb = document.createElement('div');
        fb.className = `piece ${piece.color === 'w' ? 'white' : 'black'}`;
        fb.textContent = UNICODE[(piece.color === 'w' ? 'w' : 'b') + piece.type.toUpperCase()];
        fb.dataset.sq = sq;
        cell.appendChild(fb);
      }
    };

    wrapper.appendChild(img);
    return wrapper;
  }

  /* Classic unicode */
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
}

function applySelectionHighlights() {
  document.querySelectorAll('.square').forEach(el => {
    el.classList.remove('selected');
    el.querySelector('.move-dot')?.remove();
    el.querySelector('.capture-ring')?.remove();
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
    $status.textContent = chess.turn() === 'b' ? 'Checkmate — You win! 🏆' : 'Checkmate — AI wins.';
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
    $status.textContent = chess.turn() === 'w' ? '⚠️ Check — your move' : '⚠️ AI is in check';
    $status.classList.add('check'); return;
  }
  $status.textContent = chess.turn() === 'w' ? 'Your turn' : 'AI thinking…';
  if (chess.turn() === 'b') $status.classList.add('thinking');
}

/* ── 10. Move History ── */
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

/* ── 11. Promotion ── */
function askPromotion() {
  return new Promise(resolve => {
    promotionResolve = resolve;
    $promoModal.classList.remove('hidden');
  });
}

/* ── 12. Make a Move ── */
async function makeMove(from, to, promoPiece) {
  const piece = chess.get(from);
  const isPromo = piece && piece.type === 'p' &&
    ((piece.color === 'w' && to[1] === '8') || (piece.color === 'b' && to[1] === '1'));

  if (isPromo && !promoPiece) {
    const chosen = await askPromotion();
    return makeMove(from, to, chosen);
  }

  const moveObj = { from, to };
  if (promoPiece) moveObj.promotion = promoPiece;

  const result = chess.move(moveObj);
  if (!result) return false;

  lastMove  = { from, to };
  selectedSq = null;
  legalMoves = [];
  gameOver   = false;

  renderBoard();
  updateStatus();
  refreshHistory();

  if (!chess.game_over()) triggerAI();
  return true;
}

/* ── 13. AI Turn ── */
async function triggerAI() {
  if (chess.turn() !== 'b' || chess.game_over()) return;
  updateStatus();

  const fen      = chess.fen();
  const bestMove = await sfBestMove(fen, depthMin, depthMax);
  if (!bestMove || chess.game_over()) return;

  const from  = bestMove.slice(0, 2);
  const to    = bestMove.slice(2, 4);
  const promo = bestMove.length === 5 ? bestMove[4] : undefined;

  const result = chess.move({ from, to, promotion: promo || 'q' });
  if (!result) return;

  lastMove = { from, to };
  renderBoard();
  updateStatus();
  refreshHistory();

  const toEl = squareEl(to);
  if (toEl) {
    const pEl = toEl.querySelector('.piece, .piece-wrapper');
    if (pEl) { pEl.classList.add('just-moved'); setTimeout(() => pEl.classList.remove('just-moved'), 250); }
  }
}

/* ── 14. Hint ── */
async function doHint() {
  if (gameOver || chess.turn() !== 'w') return;
  if (!sfReady) { $status.textContent = 'AI not ready yet…'; return; }

  $hintBtn.disabled = true;

  const prevText = $status.textContent;
  const prevClass = $status.className;
  $status.textContent = '💡 Calculating hint…';
  $status.className = 'status-bar thinking';

  /* Clear any pending hint highlights */
  clearHintHighlights();

  const bestMove = await sfBestMove(chess.fen(), depthMin, depthMax);

  $status.textContent = prevText;
  $status.className   = prevClass;
  $hintBtn.disabled   = false;

  if (!bestMove) return;

  const hFrom = bestMove.slice(0, 2);
  const hTo   = bestMove.slice(2, 4);

  const fromEl = squareEl(hFrom);
  const toEl   = squareEl(hTo);
  if (fromEl) fromEl.classList.add('hint-from');
  if (toEl)   toEl.classList.add('hint-to');

  if (hintTimeout) clearTimeout(hintTimeout);
  hintTimeout = setTimeout(() => {
    clearHintHighlights();
    hintTimeout = null;
  }, 3500);
}

function clearHintHighlights() {
  document.querySelectorAll('.hint-from, .hint-to').forEach(el => {
    el.classList.remove('hint-from', 'hint-to');
  });
}

/* ── 15. Undo ── */
function doUndo() {
  if (chess.history().length === 0) {
    $status.textContent = 'Nothing to undo';
    $status.className = 'status-bar';
    setTimeout(updateStatus, 1200);
    return;
  }

  /* Undo AI move + player move (2 half-moves) */
  chess.undo();
  if (chess.history().length > 0) chess.undo();

  /* If it became AI's turn somehow, undo one more */
  if (chess.turn() === 'b' && chess.history().length > 0) chess.undo();

  selectedSq = null;
  legalMoves = [];
  gameOver   = false;
  lastMove   = null;

  /* Reconstruct lastMove from history */
  const hist = chess.history({ verbose: true });
  if (hist.length > 0) {
    const last = hist[hist.length - 1];
    lastMove = { from: last.from, to: last.to };
  }

  /* Cancel any in-flight Stockfish search */
  if (stockfish && sfReady) {
    stockfish.postMessage('stop');
    sfCallbacks = [];
  }

  clearHintHighlights();
  renderBoard();
  updateStatus();
  refreshHistory();
}

/* ── 16. Square Click ── */
function onSquareClick(sq) {
  if (gameOver || chess.turn() !== 'w') return;
  clearHintHighlights();

  if (selectedSq) {
    const isLegal = legalMoves.some(m => m.to === sq);
    if (isLegal) { makeMove(selectedSq, sq); return; }
  }

  const piece = chess.get(sq);
  if (piece && piece.color === 'w') {
    selectedSq = sq;
    legalMoves = chess.moves({ square: sq, verbose: true });
    applySelectionHighlights();
    return;
  }

  selectedSq = null;
  legalMoves = [];
  applySelectionHighlights();
}

/* ── 17. Drag & Drop ── */
let dragGhost = null;
let dragFrom  = null;
let dragOffX  = 0;
let dragOffY  = 0;

function pieceAt(clientX, clientY) {
  if (dragGhost) dragGhost.style.visibility = 'hidden';
  const el = document.elementFromPoint(clientX, clientY);
  if (dragGhost) dragGhost.style.visibility = '';
  if (!el) return null;
  const cell = el.closest('[data-sq]');
  return cell ? cell.dataset.sq : null;
}

function startDrag(sq, clientX, clientY, originalEl) {
  if (chess.turn() !== 'w' || gameOver) return;
  const piece = chess.get(sq);
  if (!piece || piece.color !== 'w') return;

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

  window.addEventListener('mousemove', e => moveDrag(e.clientX, e.clientY));
  window.addEventListener('mouseup',   e => endDrag(e.clientX, e.clientY));

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
    moveDrag(e.changedTouches[0].clientX, e.changedTouches[0].clientY);
  }, { passive: false });

  window.addEventListener('touchend', e => {
    endDrag(e.changedTouches[0].clientX, e.changedTouches[0].clientY);
  });
}

/* ── 18. Controls ── */
function setupControls() {
  document.querySelectorAll('.diff-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.diff-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      depthMin = parseInt(btn.dataset.depthMin, 10);
      depthMax = parseInt(btn.dataset.depthMax, 10);
    });
  });

  $newGameBtn.addEventListener('click', startNewGame);

  $hintBtn.addEventListener('click', doHint);
  $undoBtn.addEventListener('click', doUndo);

  $historyToggle.addEventListener('click', () => {
    historyOpen = !historyOpen;
    $historyPanel.classList.toggle('open', historyOpen);
    $historyArrow.textContent = historyOpen ? '▲' : '▼';
  });

  /* Piece set switcher */
  document.querySelectorAll('.set-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.set-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      pieceSet = btn.dataset.set;
      renderBoard();
      applySelectionHighlights();
    });
  });

  /* Promotion modal buttons */
  $promoModal.querySelectorAll('.promo-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      $promoModal.classList.add('hidden');
      if (promotionResolve) { promotionResolve(btn.dataset.piece); promotionResolve = null; }
    });
  });
}

/* ── 19. New Game ── */
function startNewGame() {
  chess     = new Chess();
  selectedSq = null;
  legalMoves = [];
  lastMove   = null;
  gameOver   = false;
  sfCallbacks = [];
  clearHintHighlights();

  if (stockfish && sfReady) {
    stockfish.postMessage('stop');
    stockfish.postMessage('ucinewgame');
  }

  renderBoard();
  updateStatus();
  refreshHistory();
}

/* ── 20. Init ── */
function initApp() {
  if (typeof Chess === 'undefined') { setTimeout(initApp, 100); return; }
  initSplash();
  setupControls();
  setupDrag();
  loadStockfish();
  startNewGame();
}
