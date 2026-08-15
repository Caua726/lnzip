// =======================================================
// web/lnzip.js — the browser side of lnzip.
//
// Two things live here: a WASI shim thin enough to read in one sitting, and a
// small API over the module's ABI.
//
// The shim is mostly stubs, and that is the point rather than a shortcut. The
// codec touches no files, no clock, no environment and no randomness — it is a
// pure function of its input and the model compiled into it — so every WASI
// import except a debug write can return ENOSYS and never be missed. If one of
// them ever starts being called, something has been linked in that does not
// belong in a page that promises to send nothing anywhere.
//
// The module is never started. `_start` would run main and then proc_exit;
// the exports initialise themselves, so the page instantiates and calls them.
//
// This is a classic script rather than an ES module, deliberately. The page has
// to run from file://, where a browser refuses to load a module over the
// file: scheme, and where the bundled build inlines this file into the HTML
// anyway. It attaches to globalThis so both the page and the node tests can
// reach it.
// =======================================================

(function (root) {
'use strict';

const ENOSYS = 52;

function wasiShim(getMemory) {
  const nope = () => ENOSYS;
  return {
    wasi_snapshot_preview1: {
      // The only import with a real implementation: anything the module
      // writes to stdout or stderr is a bug report, so it goes to the console
      // rather than nowhere.
      fd_write(_fd, iovsPtr, iovsLen, nwrittenPtr) {
        const mem = getMemory();
        const view = new DataView(mem.buffer);
        let written = 0;
        const parts = [];
        for (let i = 0; i < iovsLen; i++) {
          const base = view.getUint32(iovsPtr + i * 8, true);
          const len = view.getUint32(iovsPtr + i * 8 + 4, true);
          parts.push(new Uint8Array(mem.buffer, base, len));
          written += len;
        }
        const total = parts.reduce((n, p) => n + p.length, 0);
        const flat = new Uint8Array(total);
        let at = 0;
        for (const p of parts) { flat.set(p, at); at += p.length; }
        const text = new TextDecoder().decode(flat);
        if (text.trim()) console.warn('[lnzip.wasm]', text.trimEnd());
        view.setUint32(nwrittenPtr, written, true);
        return 0;
      },
      proc_exit(code) { throw new Error('lnzip.wasm called proc_exit(' + code + ')'); },
      fd_read: nope,
      fd_close: nope,
      fd_seek: nope,
      path_open: nope,
      args_sizes_get: nope,
      args_get: nope,
      path_unlink_file: nope,
      path_create_directory: nope,
      path_remove_directory: nope,
      path_rename: nope,
      path_filestat_get: nope,
      clock_time_get: nope,
      random_get: nope,
      environ_sizes_get: nope,
      environ_get: nope,
    },
  };
}

// Error codes, mirrored from core/errno.cst. Kept as a table rather than
// numbers at the call site because what a page does with a failure depends
// entirely on which failure it is.
const ERRORS = {
  '-1900': 'this code was cut short',
  '-1901': 'the built-in model failed its integrity check',
  '-1902': 'this code was made with a different model',
  '-1903': 'the result was too large',
  '-1904': 'out of memory',
  '-1905': 'this code contains characters lnzip does not use',
  '-1906': 'this code decodes to something implausibly large',
  '-1907': 'that is not a URL lnzip can encode',
  '-1908': 'io error',
  '-1909': 'encoder and decoder disagreed — please report this',
  '-1910': 'this is not an lnzip code',
};

function describe(rc) {
  return ERRORS[String(rc)] || ('failed (' + rc + ')');
}

async function load(source) {
  const { instance } = await WebAssembly.instantiate(source, wasiShim(() => instance.exports.memory));
  const ex = instance.exports;

  // Every value crossing this boundary is a BigInt: the wasm backend widens
  // i32 to i64 in exported signatures no matter what the Caustic source says,
  // so the conversion is real and it happens here, once, rather than at each
  // call site.
  const call = (fn, ...args) => Number(fn(...args.map(BigInt)));

  const cap = call(ex.wasm_cap);
  const enc = new TextEncoder();
  const dec = new TextDecoder();

  // The module's own buffers. Recomputed on every call: wasm memory grows,
  // and a stale view over a detached ArrayBuffer is the classic way this
  // breaks after the first large input.
  const inBuf = () => new Uint8Array(ex.memory.buffer, call(ex.wasm_inbuf), cap);
  const outBuf = () => new Uint8Array(ex.memory.buffer, call(ex.wasm_outbuf), cap);

  const rc = call(ex.wasm_init);
  if (rc !== 0) throw new Error('lnzip: ' + describe(rc));

  return {
    modelId: call(ex.wasm_model_id),
    maxUrl: call(ex.wasm_max_url),

    // Adopt a model fetched at run time as the second slot, and return its
    // id. Nothing is copied: the bytes go straight into the module's memory
    // and are read in place from there.
    loadModel(bytes) {
      const at = call(ex.wasm_model_buf);
      if (!at) throw new Error('the module could not make room for a model');
      const room = call(ex.wasm_model_cap);
      if (bytes.length > room) throw new Error('that model is larger than the module allows');
      new Uint8Array(ex.memory.buffer, at, room).set(bytes);
      const id = call(ex.wasm_load_model, bytes.length);
      if (id < 0) throw new Error(describe(id));
      const bad = call(ex.wasm_verify_model);
      if (bad !== 0) throw new Error('that model failed its own integrity check');
      return id;
    },

    // `slot` is 0 for the model built into the page and 1 for one loaded with
    // loadModel. A code names its model, so this choice follows the link
    // forever.
    encode(url, { unicode = false, slot = 0 } = {}) {
      const bytes = enc.encode(url);
      if (bytes.length === 0) throw new Error('nothing to encode');
      if (bytes.length > cap) throw new Error('that URL is too long');
      inBuf().set(bytes);
      const n = call(ex.wasm_encode, bytes.length, unicode ? 1 : 0, slot);
      if (n < 0) throw new Error(describe(n));
      return dec.decode(outBuf().slice(0, n));
    },

    // Returns the URL, or throws. `safe` is false when the code decoded fine
    // but named a scheme this page will not navigate to — the check runs in
    // wasm rather than here, because a check written in JavaScript is a check
    // someone edits out of the page.
    decode(code, { unicode = false } = {}) {
      const bytes = enc.encode(code);
      if (bytes.length === 0) throw new Error('empty code');
      if (bytes.length > cap) throw new Error('that code is too long');
      inBuf().set(bytes);
      const n = call(ex.wasm_decode, bytes.length, unicode ? 1 : 0);
      if (n < 0) throw new Error(describe(n));
      const url = dec.decode(outBuf().slice(0, n));
      return { url, safe: call(ex.wasm_scheme_ok, n) === 1 };
    },
  };
}

// A code is Unicode when it is not spelled in the Base64URL alphabet. The two
// alphabets are disjoint by construction, so this needs no marker byte inside
// the payload — which would have cost every link a character to say something
// the characters already say.
function isUnicodeCode(code) {
  return /[^A-Za-z0-9_-]/.test(code);
}

root.lnzip = { load: load, isUnicodeCode: isUnicodeCode };
})(typeof globalThis !== 'undefined' ? globalThis : this);
