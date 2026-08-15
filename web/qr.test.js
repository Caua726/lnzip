// =======================================================
// web/qr.test.js — the QR encoder, pinned.
//
//   node web/qr.test.js
//
// The encoder was written against ISO/IEC 18004 and then checked the only way
// that means anything: rendering the codes and reading them back with a real
// scanner (zbarimg). That found two bugs a module-by-module diff against a
// reference would have argued about — both halves of the format information
// were transposed, which leaves the data area byte-perfect and the code
// unreadable. A code that "differs from the reference" may simply have chosen
// another mask and be perfectly valid; a code that will not scan is broken.
// Only the scanner can tell those apart.
//
// That check needs python and zbarimg, so it is not what runs here. What runs
// here is the regression half: matrices pinned from the verified encoder, so
// any future edit that changes a single module has to say so out loud.
//
// Exit is 0 only if every check passed.
// =======================================================

require('./qr.js');

const GOLD = [{"t": "a","l": "M","v": 1,"m": ["111111100101101111111","100000101011001000001","101110101101001011101","101110101011001011101","101110100100101011101","100000100011001000001","111111101010101111111","000000001100000000000","100000101011011001110","100110000001110111001","001011100110101100000","010101011001111101010","110100111101111111111","000000001100100000101","111111100111010011110","100000100010001000111","101110100111010011100","101110100101111101000","101110100101110111011","100000100011111101000","111111101010100100110"]},{"t": "https://lnzip.de#AbC123","l": "M","v": 2,"m": ["1111111011101111001111111","1000001010001110101000001","1011101010000110101011101","1011101001101100101011101","1011101011001010001011101","1000001001110100001000001","1111111010101010101111111","0000000000110110100000000","1001111110000111110010111","0101100011111011000111110","1100111001001111000011001","1010110010101010010111111","0010111101101011101100001","1110110100100101110010010","1111001111011101100011111","1011010010010001000101101","1011111010100110111110110","0000000011011010100010110","1111111010110010101010001","1000001011001110100010010","1011101010101001111110011","1011101010000000111000011","1011101001101111010011111","1000001000100011010110111","1111111010101110101001001"]},{"t": "https://lnzip.de#AbC123","l": "L","v": 2,"m": ["1111111010011111001111111","1000001011101000101000001","1011101000111100101011101","1011101000100110001011101","1011101011110110101011101","1000001010010100101000001","1111111010101010101111111","0000000010111000100000000","1110011011100101111110011","0101010001100001101101011","1100101100010011100111101","0001110111000010101111000","0000011101011011101100001","0110110100001011111100011","1110111010101111110001101","0001110001111011101111000","1111001010100010111110010","0000000010000010100010001","1111111000010010101010001","1000001010100000100010011","1011101001011011111110001","1011101001101010010010110","1011101010001011110111011","1000001010011011101110000","1111111010101110101001001"]}];

let failed = 0;
const check = (name, ok, detail) => {
  if (!ok) { failed++; console.error('FAIL ' + name + (detail ? ' — ' + detail : '')); }
};

// ---- pinned matrices, module for module ----
for (const g of GOLD) {
  const q = globalThis.qr.encode(g.t, { level: g.l });
  check('encodes: ' + g.t.slice(0, 30), q !== null);
  if (!q) continue;
  check('version: ' + g.t.slice(0, 30), q.version === g.v, `${q.version} vs ${g.v}`);
  const got = q.modules.map((r) => r.join(''));
  check('matrix: ' + g.t.slice(0, 30) + ' [' + g.l + ']',
        got.length === g.m.length && got.every((r, i) => r === g.m[i]));
}

// ---- the two copies of the format information must agree ----
//
// They are the same fifteen bits written twice, in two different orderings.
// Transposing either one is the bug this catches, and it is invisible in the
// data area.
for (const [text, level] of [['a', 'M'], ['hello world', 'L'], ['x'.repeat(60), 'M']]) {
  const q = globalThis.qr.encode(text, { level: level });
  const n = q.size, m = q.modules;
  const first = [];
  for (let i = 0; i < 6; i++) first.push(m[i][8]);
  first.push(m[7][8], m[8][8], m[8][7]);
  for (let i = 9; i < 15; i++) first.push(m[8][14 - i]);
  const second = [];
  for (let i = 0; i < 8; i++) second.push(m[8][n - 1 - i]);
  for (let i = 8; i < 15; i++) second.push(m[n - 15 + i][8]);
  check('format copies agree: ' + text.slice(0, 20),
        first.every((b, i) => b === second[i]), first.join('') + ' vs ' + second.join(''));
}

// ---- structure that must hold for every code ----
for (let len = 1; len <= 300; len += 7) {
  const q = globalThis.qr.encode('x'.repeat(len), { level: 'M' });
  if (!q) { check('capacity: ' + len, len > 200, 'refused a length it should fit'); continue; }
  check('size matches version: ' + len, q.size === q.version * 4 + 17);

  // The three finders, and the module that is always dark.
  const m = q.modules, n = q.size;
  check('finder tl: ' + len, m[0][0] === 1 && m[3][3] === 1 && m[1][1] === 0);
  check('finder tr: ' + len, m[0][n - 1] === 1 && m[3][n - 4] === 1);
  check('finder bl: ' + len, m[n - 1][0] === 1 && m[n - 4][3] === 1);
  check('dark module: ' + len, m[n - 8][8] === 1);
  // Timing patterns alternate, starting dark at the sixth row and column.
  for (let i = 8; i < n - 8; i++) {
    check('timing: ' + len, m[6][i] === (i % 2 === 0 ? 1 : 0) && m[i][6] === (i % 2 === 0 ? 1 : 0));
  }
}

// A payload past every supported version is refused rather than truncated.
check('oversize refused', globalThis.qr.encode('x'.repeat(3000), { level: 'M' }) === null);

// The SVG is well-formed and self-contained.
const s = globalThis.qr.svg(globalThis.qr.encode('https://lnzip.de#Ab1', {}), {});
check('svg shape', s.startsWith('<svg') && s.endsWith('</svg>') && s.includes('viewBox'));
check('svg has no external reference', !/https?:\/\/(?!www\.w3\.org)/.test(s));

if (failed === 0) console.log('qr: pinned matrices, format copies and structure all hold');
else console.error(failed + ' checks failed');
process.exit(failed === 0 ? 0 : 1);
