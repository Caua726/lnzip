# lnzip

A lossless compressor for URLs, written in Caustic.

Not a URL shortener in the usual sense. A shortener is a database: `abc123` is
a key, and the link dies when the table does. lnzip has no table — the code
**is** the URL, compressed:

```
URL  →  compress    →  payload
payload  →  decompress  →  the original URL, byte for byte
```

So `nosso.dominio/CODE` resolves by decoding `CODE`, not by looking it up. No
storage, no expiry, no limit on how many links exist, and anyone holding the
same model can resolve a link offline.

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

The envelope, the coder and the character model are in. The structural
grammar — domains, path tokens, typed fields — is not, so what follows is the
floor rather than the result.

Measured on 14487 URLs held out of training (real browser history), each
compressed on its own:

| | total | of original | mean/URL |
|---|---|---|---|
| **lnzip** — order-2 character model, Tiny | 473469 | **64.5%** | 157.8 B |
| brotli q11 — its static dictionary already holds URL fragments | 535185 | 72.9% | 178.4 B |
| gzip -9 | 564381 | 76.9% | 188.1 B |
| bzip2 -9 | 709828 | 96.7% | 236.6 B |

That lead comes from one decision: the probabilities live in the model, not in
the payload. A general compressor has to ship its own statistics with every
sixty-byte string, and there is no room.

Losslessness is gated on a corpus rather than on chosen examples — 144874 real
URLs, every one round-tripping byte for byte, run again on every change:

```sh
caustic-mk build corpus && ./build/corpus <file-of-urls> [model.lnzm]
```

Training is byte-reproducible: same corpus, same trainer, same model. It has
to be, because a published model id is frozen forever — a link minted today
has to resolve in ten years. Nothing is published yet, and the format is still
free to move.

See `docs/design.md` for the phases and their gates.

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
