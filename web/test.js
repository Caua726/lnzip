// =======================================================
// web/test.js — the browser build, exercised outside a browser.
//
//   caustic-mk run web && node web/test.js
//
// The Caustic suite cannot reach this: testing the wasm build needs a wasm
// runtime, and the one on hand is node. So it lives apart, and it is honest
// about being optional — a clone with no node still builds and still passes
// `caustic-mk run test`.
//
// What it covers is the seam, not the codec. The codec is tested natively and
// over a corpus; what can only break here is the boundary — the BigInt
// widening the wasm backend applies to exported signatures, the buffers moving
// when memory grows, the model surviving deflation into the module, and the
// scheme allowlist that stands between this page and being a javascript:
// delivery mechanism.
//
// Exit is 0 only if every check passed.
// =======================================================

require('./lnzip.js');
const fs = require('fs');

const WASM = process.argv[2] || 'build/lnzip.wasm';

const URLS = [
  'https://github.com/torvalds/linux/issues/123',
  'https://wiki.archlinux.org/title/Arch_User_Repository#Frequently_asked_questions',
  'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
  'https://пример.рф/путь',
  'http://example.com',
  'https://user:pw@[2001:db8::1]:8080/a%2Fb?x=1&y=2#f',
  'mailto:someone@example.com',
  'a',
  'https://x.com/?utm_source=a&utm_medium=b&utm_campaign=c',
  'https://example.com/' + 'x'.repeat(4000),
];

let failed = 0;
function check(name, ok, detail) {
  if (!ok) { failed++; console.error('FAIL ' + name + (detail ? ' — ' + detail : '')); }
}

(async () => {
  const lz = await globalThis.lnzip.load(fs.readFileSync(WASM));
  check('model loaded', lz.modelId >= 0, 'id ' + lz.modelId);
  check('max url reported', lz.maxUrl === 8192, String(lz.maxUrl));

  // Every alphabet, every URL, both directions — and decoded without being
  // told which alphabet it was, because that is how a link arrives.
  let raw = 0;
  const totals = new Map(lz.alphabets.map((a) => [a.name, 0]));
  for (const u of URLS) {
    raw += Buffer.byteLength(u);
    for (const a of lz.alphabets) {
      const c = lz.encode(u, { alphabet: a.index });
      check(a.name + ' round-trip: ' + u.slice(0, 36), lz.decode(c).url === u);
      totals.set(a.name, totals.get(a.name) + [...c].length);
    }
  }
  // Symbol widths must fall in the order the alphabets claim: more bits a
  // symbol is fewer symbols, always.
  const order = [...lz.alphabets].sort((x, y) => x.bits - y.bits).map((a) => a.name);
  for (let i = 1; i < order.length; i++) {
    check('wider alphabet is shorter: ' + order[i - 1] + ' vs ' + order[i],
          totals.get(order[i]) <= totals.get(order[i - 1]),
          totals.get(order[i]) + ' vs ' + totals.get(order[i - 1]));
  }

  // Only http and https may be navigated to. With no database behind it, a
  // fragment resolves to whatever it decodes to, so this check is the whole
  // difference between a shortener and an attack surface.
  for (const [url, want] of [
    ['https://example.com/x', true],
    ['http://example.com/x', true],
    ['HTTPS://EXAMPLE.COM/x', true],
    ['javascript:alert(1)', false],
    ['data:text/html,<script>alert(1)</script>', false],
    ['file:///etc/passwd', false],
    ['mailto:a@b.c', false],
    ['ftp://ftp.gnu.org/', false],
  ]) {
    const got = lz.decode(lz.encode(url)).safe;
    check('scheme gate: ' + url, got === want, 'got safe=' + got);
  }

  // Nothing here may throw anything but a clean Error, and nothing may hang.
  for (const junk of ['', '!!!!', 'AAAA', '一丁', 'x'.repeat(70000), '=', '+/']) {
    try {
      lz.decode(junk);
    } catch (e) {
      check('junk rejected cleanly', e instanceof Error && e.message.length > 0);
    }
  }

  // Encoding past the ceiling is an error, not a truncation: a truncated URL
  // is a valid URL pointing somewhere else.
  try {
    lz.encode('https://example.com/' + 'x'.repeat(9000));
    check('oversize refused', false, 'it was accepted');
  } catch (e) {
    check('oversize refused', true);
  }

  // A link made with the fetched model, opened by a page that has never
  // loaded it. The code names its model, so the reader can tell which one to
  // fetch instead of being told the code is for a different model.
  const STD = process.argv[3] || 'build/standard.lnzm';
  if (fs.existsSync(STD)) {
    const stdBytes = new Uint8Array(fs.readFileSync(STD));
    const maker = await globalThis.lnzip.load(fs.readFileSync(WASM));
    const stdId = maker.loadModel(stdBytes);
    const url = 'https://github.com/torvalds/linux/issues/123';
    const tinyCode = maker.encode(url, { slot: 0 });
    for (const a of maker.alphabets) {
      const code = maker.encode(url, { alphabet: a.index, slot: 1 });
      const reader = await globalThis.lnzip.load(fs.readFileSync(WASM));
      check(a.name + ': code names the fetched model', reader.codeModel(code) === stdId,
            'named ' + reader.codeModel(code));
      check(a.name + ': not yet decodable without it', !reader.hasModel(stdId));
      reader.loadModel(stdBytes);
      check(a.name + ': decodes once it is loaded', reader.decode(code).url === url);
    }
    check('built-in code names the built-in model', maker.codeModel(tinyCode) === maker.modelId);
  } else {
    check('standard model present for the fetch test', false, STD + ' missing');
  }

  console.log('web: ' + URLS.length + ' urls, ' + raw + ' B -> ' +
              [...totals].map(([n, v]) => v + ' ' + n).join(' / '));
  if (failed === 0) console.log('web: wasm boundary, alphabets and scheme gate all hold');
  else console.error(failed + ' checks failed');
  process.exit(failed === 0 ? 0 : 1);
})();
