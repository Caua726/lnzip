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

  let raw = 0, ascii = 0, uni = 0;
  for (const u of URLS) {
    const a = lz.encode(u);
    const c = lz.encode(u, { unicode: true });
    check('base64 round-trip: ' + u.slice(0, 40), lz.decode(a).url === u);
    check('unicode round-trip: ' + u.slice(0, 40), lz.decode(c, { unicode: true }).url === u);
    check('alphabet is detectable: ' + u.slice(0, 40),
          !globalThis.lnzip.isUnicodeCode(a) && globalThis.lnzip.isUnicodeCode(c));
    raw += Buffer.byteLength(u);
    ascii += a.length;
    uni += [...c].length;
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
      lz.decode(junk, { unicode: globalThis.lnzip.isUnicodeCode(junk) });
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

  console.log('web: ' + URLS.length + ' urls, ' + raw + ' B -> ' +
              ascii + ' base64 chars / ' + uni + ' unicode chars');
  if (failed === 0) console.log('web: wasm boundary, alphabets and scheme gate all hold');
  else console.error(failed + ' checks failed');
  process.exit(failed === 0 ? 0 : 1);
})();
