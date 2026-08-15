# lnzip

A lossless compressor for URLs, written in Caustic.

Not a URL shortener in the usual sense. A shortener is a database: `abc123` is
a key, and the link dies when the table does. lnzip has no table — the code
**is** the URL, compressed:

```
URL  →  compress    →  payload
payload  →  decompress  →  the original URL, byte for byte
```

So `lnzip.de#CODE` resolves by decoding `CODE`, not by looking it up. No
storage, no expiry, no limit on how many links exist, and anyone holding the
same model can resolve a link offline — including with no network at all.

## How it compresses

It doesn't treat a URL as text. It knows the grammar —

```
scheme · host/subdomain/domain · path · query parameters · fragment
```

— and spends bits only on what is unpredictable. `https`, `/`, `?`, `=`, `&`,
`#`, TLDs and common route shapes cost a fraction of a bit each or vanish
entirely. Unknown text falls through to subword and character models, and
digits, hex, UUIDs and Base64 get codecs shaped for them.

The philosophy is closer to AV1 than to LZ4: exploit knowledge of what the
data *is* rather than search it for repeats. A structural pass turns the URL
into tokens, and a binary arithmetic coder with pre-trained, frozen
probabilities turns those tokens into bits. The probability tables live in an
external model file, so **not one byte of table rides in the payload** — which
is what makes a 40-bit result possible at all.

The models learn the *language* of URLs — domains, words, subwords, routes,
parameters, distributions. They store no pages and no specific URLs.

| Tier | Size |
|---|---|
| Tiny | ~2 MB |
| Standard | ~25 MB |
| Max | ~90 MB |

## Output

```
Base64URL   maximum compatibility, drops into a URL path unescaped — 6 bits/char
Unicode     fewest visible characters, CJK ideographs            — 14 bits/char
```

A 96-bit payload is 16 Base64URL characters or 7 CJK ones.

## What it does not do

Against a URL carrying a random identifier, **no compressor beats a database**
— that is information theory, not engineering. `youtube.com/watch?v=dQw4w9WgXcQ`
holds 66 bits of pure randomness in the ID; the best possible payload is about
72 bits, or 12 Base64URL characters, where bit.ly spends 7. The same is true
of ASINs, UUIDs and commit hashes.

Where lnzip wins is structural and textual URLs — wikis, docs, GitHub, news,
slugged product pages — and above all long URLs carrying `utm_*` and tracking
parameters, which collapse from ~200 characters to ~10. And it wins on the
thing a database cannot offer at any size: no state.

The benchmark reports per category rather than hiding this in an average.

## Where it stands

Components, whole-token dictionaries for hosts, path segments, query keys and
values, and a shared sub-word dictionary underneath them.

Two numbers, and the second one matters more.

On URLs held out at random from the training corpus — the same sites, different
pages:

| | of original | mean/URL |
|---|---|---|
| **lnzip** — standard tier | **31%** | 48 B |
| zstd -19 with a dictionary trained on the same corpus | 70.8% | 109 B |
| brotli q11 — its dictionary already holds URL fragments | 76.9% | 119 B |
| gzip -9 | 82.0% | 127 B |
| bzip2 -9 | 109.4% — it *grows* | 169 B |

On URLs from sites the model has never seen at all — the corpus split by domain
rather than at random, which is the honest question of whether this works for
anybody but the person whose history trained it:

| | of original | mean/URL |
|---|---|---|
| **lnzip** | **51.2%** | 69.7 B |
| zstd -19 + trained dictionary | 69.1% | 94.1 B |
| brotli q11 | 76.6% | 104.4 B |
| gzip -9 | 80.9% | 110.2 B |

31% against 51% is the size of the overfit, and it is the most useful thing
measured so far. The model is trained on one person's browsing — 5184 domains —
so a site it has not seen costs twenty points. The fix is a broader corpus of
real URLs, not a bigger dictionary.

Getting there in order, so the cost of each idea is visible:

| | of original |
|---|---|
| order-2 character model | 57.8% |
| + components coded separately | 57.3% |
| + whole-token dictionaries | 43.4% |
| + shared sub-word dictionary | 39.7% |
| + tuned dictionary sizes (standard tier) | 31.0% |

### A dictionary has an optimum, not a ceiling

Keeping every distinct token the corpus contains scores **worse** than keeping
a third of them: 32% against 31%, for two and a half times the size. A token
costs its rank, not its presence — a word around rank 100000 costs some 34 bits
to name and about 32 to spell out, so past a point each new entry is a loss that
also has to be downloaded.

This is why a language dictionary would not help. `the` is the commonest word in
English and is rare in URLs; `utm_source` is a word in no language and is one of
the commonest tokens on the web. Only the corpus knows the frequencies that
matter, and the frequencies are the whole mechanism.

### Tiers

A tier is a tax on the reader, not the writer: a link names its model, so
everyone who follows it needs that model.

| tier | model | transferred | of original |
|---|---|---|---|
| tiny | 2.8 MB | 568 KB | 39% |
| standard | 5.7 MB | 2.3 MB | 31% |

Losslessness is gated on a corpus rather than on chosen examples — 144874 real
URLs, every one round-tripping byte for byte, run again on every change:

```sh
caustic-mk build corpus && ./build/corpus <file-of-urls> [model.lnzm]
```

Training is byte-reproducible: same corpus, same trainer, same model. It has to
be, because a published model id is frozen forever — a link minted today has to
resolve in ten years. Nothing is published yet, and the format is still free to
move.

See `docs/design.md` for the phases and their gates.

## lnzip.de

The code lives in the fragment:

```
lnzip.de#SJtqoP1y7FFuuAEaikNiYgXfmg4nm-aZ
```

A fragment is never sent to a server. The destination URL therefore never
reaches any infrastructure at all — the page decompresses it in the reader's
browser and sends them on. That is not a policy about logs; there is nothing to
log with. No shortener holding a database can offer the same, at any price.

The whole thing is one static file that opens from `file://` with no server and
no network: the codec compiled to WebAssembly with the model deflated inside
it, a WASI shim of about fifty lines, and the page.

```sh
caustic-mk run web        # -> build/lnzip.html, self-contained
node web/test.js          # optional: checks the wasm boundary
```

Only `http` and `https` are ever navigated to, and that check runs inside the
wasm rather than in the page script — with no database behind it a fragment
resolves to whatever it decodes to, so the check is the difference between a
shortener and a `javascript:` delivery mechanism. A code that decodes to
anything else is shown as inert text.

## Use

```sh
caustic-mk build train && ./build/train <corpus> models/tiny.lnzm 0 0
caustic-mk build lnzip

./build/lnzip encode 'https://github.com/torvalds/linux/issues/123' -m models/tiny.lnzm
./build/lnzip decode '<code>' -m models/tiny.lnzm
./build/lnzip encode '<url>' -m models/tiny.lnzm -u     # Unicode output
./build/lnzip info -m models/tiny.lnzm
```

`$LNZIP_MODEL` stands in for `-m`. With no model at all the tool still runs,
against a uniform built-in one that compresses nothing — it exists so the codec
works before a corpus does, and encoding with it says so on stderr.

## Build

```sh
caustic-mk run test        # every suite
caustic-mk run test-opt    # the same through the optimizing backend
```

Requires the Caustic toolchain (≥ v0.1.8) and network access on first build,
to clone the pinned `caustic-compact`.

## License

MIT — Cauã Alvarenga Neves.
