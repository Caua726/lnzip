// =======================================================
// web/qr.js — QR codes, because a shorter payload is a smaller code.
//
// This is the one place where lnzip's output has a physical consequence: a QR
// code's size is set by how many bytes it carries, in steps. Forty characters
// instead of a hundred is often two versions smaller, which is the difference
// between a code that scans across a room and one that does not.
//
// Byte mode, all four correction levels, versions 1 to 20 — far more than a
// shortened link will ever need. Higher correction survives more damage and
// costs capacity: H recovers from about 30% of the code being unreadable, and
// pays for it by needing a larger version for the same text. The block table below is generated from a reference
// implementation rather than written out by hand: it is forty rows of numbers
// where a single wrong digit produces codes that look perfect and decode to
// nothing, and there is no reason to trust a transcription for that.
//
// Everything else here follows ISO/IEC 18004 directly and is checked against
// the same reference, module for module, in web/qr.test.js.
// =======================================================

(function (root) {
'use strict';

// Generated from a reference implementation's block table, not written by
// hand: [ec-codewords-per-block, count1, data1, count2, data2] per version.
const RS = {
  L: [[7, 1, 19, 0, 0], [10, 1, 34, 0, 0], [15, 1, 55, 0, 0], [20, 1, 80, 0, 0], [26, 1, 108, 0, 0], [18, 2, 68, 0, 0], [20, 2, 78, 0, 0], [24, 2, 97, 0, 0], [30, 2, 116, 0, 0], [18, 2, 68, 2, 69], [20, 4, 81, 0, 0], [24, 2, 92, 2, 93], [26, 4, 107, 0, 0], [30, 3, 115, 1, 116], [22, 5, 87, 1, 88], [24, 5, 98, 1, 99], [28, 1, 107, 5, 108], [30, 5, 120, 1, 121], [28, 3, 113, 4, 114], [28, 3, 107, 5, 108]],
  M: [[10, 1, 16, 0, 0], [16, 1, 28, 0, 0], [26, 1, 44, 0, 0], [18, 2, 32, 0, 0], [24, 2, 43, 0, 0], [16, 4, 27, 0, 0], [18, 4, 31, 0, 0], [22, 2, 38, 2, 39], [22, 3, 36, 2, 37], [26, 4, 43, 1, 44], [30, 1, 50, 4, 51], [22, 6, 36, 2, 37], [22, 8, 37, 1, 38], [24, 4, 40, 5, 41], [24, 5, 41, 5, 42], [28, 7, 45, 3, 46], [28, 10, 46, 1, 47], [26, 9, 43, 4, 44], [26, 3, 44, 11, 45], [26, 3, 41, 13, 42]],
  Q: [[13, 1, 13, 0, 0], [22, 1, 22, 0, 0], [18, 2, 17, 0, 0], [26, 2, 24, 0, 0], [18, 2, 15, 2, 16], [24, 4, 19, 0, 0], [18, 2, 14, 4, 15], [22, 4, 18, 2, 19], [20, 4, 16, 4, 17], [24, 6, 19, 2, 20], [28, 4, 22, 4, 23], [26, 4, 20, 6, 21], [24, 8, 20, 4, 21], [20, 11, 16, 5, 17], [30, 5, 24, 7, 25], [24, 15, 19, 2, 20], [28, 1, 22, 15, 23], [28, 17, 22, 1, 23], [26, 17, 21, 4, 22], [30, 15, 24, 5, 25]],
  H: [[17, 1, 9, 0, 0], [28, 1, 16, 0, 0], [22, 2, 13, 0, 0], [16, 4, 9, 0, 0], [22, 2, 11, 2, 12], [28, 4, 15, 0, 0], [26, 4, 13, 1, 14], [26, 4, 14, 2, 15], [24, 4, 12, 4, 13], [28, 6, 15, 2, 16], [24, 3, 12, 8, 13], [28, 7, 14, 4, 15], [22, 12, 11, 4, 12], [24, 11, 12, 5, 13], [24, 11, 12, 7, 13], [30, 3, 15, 13, 16], [28, 2, 14, 17, 15], [28, 2, 14, 19, 15], [26, 9, 13, 16, 14], [28, 15, 15, 10, 16]],
};
// The two-bit level indicator the format information carries.
const LVL_BITS = { L: 1, M: 0, Q: 3, H: 2 };

// ---- GF(256), the field Reed-Solomon lives in ------------------------
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
(function () {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;          // the QR primitive polynomial
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
})();

const mul = (a, b) => (a === 0 || b === 0) ? 0 : EXP[LOG[a] + LOG[b]];

// The generator polynomial for `n` error-correction codewords.
function generator(n) {
  let g = [1];
  for (let i = 0; i < n; i++) {
    const next = new Array(g.length + 1).fill(0);
    for (let j = 0; j < g.length; j++) {
      next[j] ^= mul(g[j], 1);
      next[j + 1] ^= mul(g[j], EXP[i]);
    }
    g = next;
  }
  return g;
}

// Polynomial remainder: the error-correction codewords for one block.
function ecc(data, n) {
  const g = generator(n);
  const r = new Uint8Array(data.length + n);
  r.set(data);
  for (let i = 0; i < data.length; i++) {
    const f = r[i];
    if (f === 0) continue;
    for (let j = 0; j < g.length; j++) r[i + j] ^= mul(g[j], f);
  }
  return r.slice(data.length);
}

// ---- the matrix ------------------------------------------------------

// Where the alignment patterns go, per version. Row centres are the same as
// column centres, so one list describes both.
function alignCentres(version) {
  if (version === 1) return [];
  const n = Math.floor(version / 7) + 2;
  const last = version * 4 + 10;
  const step = (version === 32) ? 26 : Math.ceil((last - 6) / (n - 1) / 2) * 2;
  const out = [6];
  for (let i = n - 1; i > 0; i--) out.unshift(last - (n - 1 - i) * step);
  return out.sort((a, b) => a - b).filter((v, i, a) => a.indexOf(v) === i);
}

function newMatrix(size) {
  const m = [];
  for (let i = 0; i < size; i++) m.push(new Int8Array(size).fill(-1));   // -1 = free
  return m;
}

function placeFunction(m, version) {
  const size = m.length;
  const finder = (r, c) => {
    for (let i = -1; i <= 7; i++) {
      for (let j = -1; j <= 7; j++) {
        const y = r + i, x = c + j;
        if (y < 0 || y >= size || x < 0 || x >= size) continue;
        const on = (i >= 0 && i <= 6 && (j === 0 || j === 6)) ||
                   (j >= 0 && j <= 6 && (i === 0 || i === 6)) ||
                   (i >= 2 && i <= 4 && j >= 2 && j <= 4);
        m[y][x] = on ? 1 : 0;
      }
    }
  };
  finder(0, 0); finder(0, size - 7); finder(size - 7, 0);

  for (let i = 8; i < size - 8; i++) {
    const on = (i % 2 === 0) ? 1 : 0;
    m[6][i] = on; m[i][6] = on;
  }

  const c = alignCentres(version);
  for (const r of c) for (const col of c) {
    if ((r === 6 && col === 6) || (r === 6 && col === size - 7) || (r === size - 7 && col === 6)) continue;
    for (let i = -2; i <= 2; i++) for (let j = -2; j <= 2; j++) {
      m[r + i][col + j] = (Math.max(Math.abs(i), Math.abs(j)) !== 1) ? 1 : 0;
    }
  }

  m[size - 8][8] = 1;                                     // the always-dark module

  // Reserve the format areas so data placement skips them.
  for (let i = 0; i < 9; i++) {
    if (m[8][i] === -1) m[8][i] = 0;
    if (m[i][8] === -1) m[i][8] = 0;
  }
  for (let i = 0; i < 8; i++) {
    if (m[8][size - 1 - i] === -1) m[8][size - 1 - i] = 0;
    if (m[size - 1 - i][8] === -1) m[size - 1 - i][8] = 0;
  }
  if (version >= 7) {
    for (let i = 0; i < 6; i++) for (let j = 0; j < 3; j++) {
      m[size - 11 + j][i] = 0;
      m[i][size - 11 + j] = 0;
    }
  }
}

// A second matrix marking which modules are function patterns, so the mask
// leaves them alone and the data walk skips them.
function functionMask(version, size) {
  const m = newMatrix(size);
  placeFunction(m, version);
  const f = [];
  for (let i = 0; i < size; i++) {
    f.push(new Uint8Array(size));
    for (let j = 0; j < size; j++) f[i][j] = m[i][j] === -1 ? 0 : 1;
  }
  return f;
}

const MASKS = [
  (i, j) => (i + j) % 2 === 0,
  (i, j) => i % 2 === 0,
  (i, j) => j % 3 === 0,
  (i, j) => (i + j) % 3 === 0,
  (i, j) => (Math.floor(i / 2) + Math.floor(j / 3)) % 2 === 0,
  (i, j) => ((i * j) % 2) + ((i * j) % 3) === 0,
  (i, j) => (((i * j) % 2) + ((i * j) % 3)) % 2 === 0,
  (i, j) => (((i + j) % 2) + ((i * j) % 3)) % 2 === 0,
];

// ISO 18004 §8.8.2. Four rules, and the code with the lowest total wins.
function penalty(m) {
  const n = m.length;
  let p = 0;

  const runScore = (line) => {
    let s = 0, run = 1;
    for (let i = 1; i < n; i++) {
      if (line[i] === line[i - 1]) { run++; }
      else { if (run >= 5) s += 3 + (run - 5); run = 1; }
    }
    if (run >= 5) s += 3 + (run - 5);
    return s;
  };
  for (let i = 0; i < n; i++) {
    p += runScore(m[i]);
    p += runScore(m.map((r) => r[i]));
  }

  for (let i = 0; i < n - 1; i++) for (let j = 0; j < n - 1; j++) {
    const v = m[i][j];
    if (v === m[i][j + 1] && v === m[i + 1][j] && v === m[i + 1][j + 1]) p += 3;
  }

  const PAT = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0];
  const RPAT = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1];
  const hasAt = (line, at, pat) => {
    for (let k = 0; k < pat.length; k++) if (line[at + k] !== pat[k]) return false;
    return true;
  };
  for (let i = 0; i < n; i++) {
    const row = m[i], col = m.map((r) => r[i]);
    for (let j = 0; j + 11 <= n; j++) {
      if (hasAt(row, j, PAT) || hasAt(row, j, RPAT)) p += 40;
      if (hasAt(col, j, PAT) || hasAt(col, j, RPAT)) p += 40;
    }
  }

  let dark = 0;
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) dark += m[i][j];
  const pct = (dark * 100) / (n * n);
  p += Math.floor(Math.abs(pct - 50) / 5) * 10;
  return p;
}

function formatBits(level, mask) {
  // level: 1 for L, 0 for M, matching the two-bit indicator in the standard.
  const data = (level << 3) | mask;
  let v = data << 10;
  for (let i = 4; i >= 0; i--) if (v & (1 << (i + 10))) v ^= 0x537 << i;
  return ((data << 10) | v) ^ 0x5412;
}

function versionBits(version) {
  let v = version << 12;
  for (let i = 5; i >= 0; i--) if (v & (1 << (i + 12))) v ^= 0x1f25 << i;
  return (version << 12) | v;
}

// ---- the whole thing -------------------------------------------------

// Returns { size, modules } where modules[r][c] is 0 or 1, or null when the
// text does not fit any supported version.
function encode(text, opts) {
  const want = opts && opts.level;
  const level = (want === 'L' || want === 'Q' || want === 'H') ? want : 'M';
  const table = RS[level];
  const bytes = new TextEncoder().encode(text);

  let version = 0, spec = null;
  for (let v = 1; v <= 20; v++) {
    const s = table[v - 1];
    const capacity = s[1] * s[2] + s[3] * s[4];
    const lenBits = v <= 9 ? 8 : 16;
    if (bytes.length + 2 + Math.ceil(lenBits / 8) <= capacity + 1 &&
        (4 + lenBits + bytes.length * 8) <= capacity * 8) {
      version = v; spec = s; break;
    }
  }
  if (!version) return null;

  // ---- the bit stream ----
  const bits = [];
  const push = (value, n) => { for (let i = n - 1; i >= 0; i--) bits.push((value >> i) & 1); };
  push(4, 4);                                        // byte mode
  push(bytes.length, version <= 9 ? 8 : 16);
  for (const b of bytes) push(b, 8);

  const totalData = spec[1] * spec[2] + spec[3] * spec[4];
  const cap = totalData * 8;
  for (let i = 0; i < 4 && bits.length < cap; i++) bits.push(0);   // terminator
  while (bits.length % 8) bits.push(0);
  const data = [];
  for (let i = 0; i < bits.length; i += 8) {
    let b = 0;
    for (let j = 0; j < 8; j++) b = (b << 1) | bits[i + j];
    data.push(b);
  }
  const PAD = [0xec, 0x11];
  for (let i = 0; data.length < totalData; i++) data.push(PAD[i % 2]);

  // ---- blocks, then interleave ----
  const blocks = [];
  let at = 0;
  for (const [count, dc] of [[spec[1], spec[2]], [spec[3], spec[4]]]) {
    for (let i = 0; i < count; i++) {
      const d = Uint8Array.from(data.slice(at, at + dc));
      at += dc;
      blocks.push({ d, e: ecc(d, spec[0]) });
    }
  }
  const out = [];
  const maxD = Math.max(...blocks.map((b) => b.d.length));
  for (let i = 0; i < maxD; i++) for (const b of blocks) if (i < b.d.length) out.push(b.d[i]);
  for (let i = 0; i < spec[0]; i++) for (const b of blocks) out.push(b.e[i]);

  // ---- place, mask, choose ----
  const size = version * 4 + 17;
  const fn = functionMask(version, size);
  const base = newMatrix(size);
  placeFunction(base, version);

  const dataBits = [];
  for (const b of out) for (let i = 7; i >= 0; i--) dataBits.push((b >> i) & 1);

  let bi = 0;
  const grid = base.map((r) => Int8Array.from(r));
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;                       // the vertical timing column
    for (let vert = 0; vert < size; vert++) {
      for (let k = 0; k < 2; k++) {
        const x = right - k;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vert : vert;
        if (fn[y][x]) continue;
        grid[y][x] = bi < dataBits.length ? dataBits[bi] : 0;
        bi++;
      }
    }
  }

  let best = null, bestScore = Infinity;
  const only = (opts && opts.forceMask != null) ? opts.forceMask : -1;
  for (let mask = 0; mask < 8; mask++) {
    if (only >= 0 && mask !== only) continue;
    const m = grid.map((r) => Array.from(r));
    for (let i = 0; i < size; i++) for (let j = 0; j < size; j++) {
      if (!fn[i][j] && MASKS[mask](i, j)) m[i][j] ^= 1;
    }
    // format information, which is part of what the penalty sees
    const f = formatBits(LVL_BITS[level], mask);
    for (let i = 0; i < 15; i++) {
      const bit = (f >> i) & 1;
      // First copy, around the top-left finder. Rows for the low bits and
      // columns for the high ones — transposing these two halves produces a
      // code whose data area is perfect and which no scanner will read.
      if (i < 6)        { m[i][8] = bit; }
      else if (i === 6) { m[7][8] = bit; }
      else if (i === 7) { m[8][8] = bit; }
      else if (i === 8) { m[8][7] = bit; }
      else              { m[8][14 - i] = bit; }

      // Second copy, split between the top-right and the bottom-left — and
      // note it runs the other way round from the first: columns for the low
      // bits, rows for the high ones.
      if (i < 8) { m[8][size - 1 - i] = bit; }
      else       { m[size - 15 + i][8] = bit; }
    }
    m[size - 8][8] = 1;
    if (version >= 7) {
      const vb = versionBits(version);
      for (let i = 0; i < 18; i++) {
        const bit = (vb >> i) & 1;
        m[Math.floor(i / 3)][size - 11 + (i % 3)] = bit;
        m[size - 11 + (i % 3)][Math.floor(i / 3)] = bit;
      }
    }
    const s = penalty(m);
    if (s < bestScore) { bestScore = s; best = m; }
  }

  return { size: size, version: version, level: level, modules: best };
}

// An SVG, because it stays sharp at any size and costs nothing to produce.
function svg(qr, opts) {
  const quiet = (opts && opts.quiet != null) ? opts.quiet : 4;
  const n = qr.size + quiet * 2;
  let d = '';
  for (let r = 0; r < qr.size; r++) {
    for (let c = 0; c < qr.size; c++) {
      if (qr.modules[r][c]) d += `M${c + quiet} ${r + quiet}h1v1h-1z`;
    }
  }
  const fg = (opts && opts.fg) || 'currentColor';
  const bg = (opts && opts.bg) || 'none';
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n} ${n}" ` +
         `shape-rendering="crispEdges" role="img" aria-label="QR code">` +
         (bg === 'none' ? '' : `<rect width="${n}" height="${n}" fill="${bg}"/>`) +
         `<path d="${d}" fill="${fg}"/></svg>`;
}

root.qr = { encode: encode, svg: svg };
})(typeof globalThis !== 'undefined' ? globalThis : this);
