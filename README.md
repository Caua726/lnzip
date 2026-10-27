# lnzip

A lossless compressor for URLs, written in [Caustic](https://github.com/Caua726/Caustic).

```
https://github.com/torvalds/linux/issues/123     44 characters
lnzip.de#dtSwnunEffaw1qDNMyWc                    the same URL, compressed
```

Not a URL shortener in the usual sense. A shortener is a database: `abc123` is
a key, and the link dies when the table does. lnzip has no table — the code
**is** the URL, compressed. `lnzip.de#CODE` resolves by decoding `CODE`, not by
looking it up: no storage, no expiry, no limit on how many links exist, and
anyone holding the same model can resolve a link offline.

## Quick start

Requires the Caustic toolchain (≥ v0.1.8). The first build clones the pinned
[`caustic-compact`](https://github.com/Caua726/caustic-compact) into `.caustic/deps`.

```sh
caustic-mk run models          # fetch the published models, check their sha256
caustic-mk build lnzip

M=models/lnzip-standard-1.lnzm
./build/lnzip encode 'https://github.com/torvalds/linux/issues/123' -m $M
./build/lnzip decode 'dtSwnunEffaw1qDNMyWc' -m $M
./build/lnzip encode '<url>' -m $M -a cjk -v   # another alphabet, sizes on stderr
./build/lnzip info -m $M
```

`$LNZIP_MODEL` stands in for `-m`. With no model at all the tool still runs,
against a uniform built-in one that compresses nothing — it exists so the codec
works before a corpus does, and encoding with it says so on stderr.

## What it looks like

With the standard model, each code decoded back byte for byte:

| URL | chars | base64url | cjk | emoji |
|---|---|---|---|---|
| `https://github.com/torvalds/linux/issues/123` | 44 | 20 | 9 | 12 |
| `https://en.wikipedia.org/wiki/Arithmetic_coding` | 47 | 22 | 10 | 13 |
| `https://www.amazon.com/s?k=mechanical+keyboard&utm_source=newsletter&utm_medium=email&utm_campaign=black_friday` | 111 | 31 | 14 | 19 |

## How it compresses

It doesn't treat a URL as text. It knows the grammar —

```
scheme · host/subdomain/domain · path · query parameters · fragment
```

— and spends bits only on what is unpredictable. `https`, `/`, `?`, `=`, `&`,
`#`, TLDs and common route shapes cost a fraction of a bit each or vanish
entirely. Hosts, path segments, query keys and values go through whole-token
dictionaries, with a shared sub-word dictionary underneath for the ones that
miss, and an order-2 character model below that.

The philosophy is closer to AV1 than to LZ4: exploit knowledge of what the
data *is* rather than search it for repeats. A structural pass turns the URL
into tokens, and a binary range coder with pre-trained, frozen probabilities
turns those tokens into bits. The probability tables live in an external model
file, so **not one byte of table rides in the payload**.

Every input round-trips, URL or not. The encoder builds a structural payload
and a raw one (the character model alone) and emits whichever is shorter.

## Results

The published models, on URLs from domains they never saw in training:

| model | file | transferred | of original |
|---|---|---|---|
| id 0, tiny | 9.5 MB | 615 KB | 35% |
| id 1, standard | 11.5 MB | 1.4 MB | 34% |

Losslessness is gated on a corpus rather than on chosen examples — every URL
round-tripping byte for byte, run again on every change:

```sh
caustic-mk build corpus && ./build/corpus <file-of-urls> [model.lnzm]
```

### How it got there

Measured on an earlier model trained on one person's browsing (5184 domains),
before the published ones. The comparison is against general-purpose
compressors at their best settings, on URLs held out from the same corpus:

| | of original | mean/URL |
|---|---|---|
| **lnzip** | **31%** | 48 B |
| zstd -19 with a dictionary trained on the same corpus | 70.8% | 109 B |
| brotli q11 — its dictionary already holds URL fragments | 76.9% | 119 B |
| gzip -9 | 82.0% | 127 B |
| bzip2 -9 | 109.4% — it *grows* | 169 B |

On sites that model had never seen, the same 31% became 51% — the size of the
overfit, and the reason the published models were trained on public data
instead. Each idea, in order, so its cost is visible:

| | of original |
|---|---|
| order-2 character model | 57.8% |
| + components coded separately | 57.3% |
| + whole-token dictionaries | 43.4% |
| + shared sub-word dictionary | 39.7% |
| + tuned dictionary sizes | 31.0% |

**A dictionary has an optimum, not a ceiling.** Keeping every distinct token
the corpus contains scores *worse* than keeping a third of them: 32% against
31%, for two and a half times the size. A token costs its rank, not its
presence — a word around rank 100000 costs some 34 bits to name and about 32 to
spell out, so past a point each new entry is a loss that also has to be
downloaded.

This is also why a language dictionary would not help. `the` is the commonest
word in English and rare in URLs; `utm_source` is a word in no language and one
of the commonest tokens on the web. Only the corpus knows the frequencies that
matter.

## What it does not do

Against a URL carrying a random identifier, **no compressor beats a database**
— that is information theory, not engineering. `youtube.com/watch?v=dQw4w9WgXcQ`
holds 66 bits of pure randomness in the ID; the best possible payload is about
72 bits, or 12 Base64URL characters, where bit.ly spends 7. The same is true
of ASINs, UUIDs and commit hashes.

Where lnzip wins is structural and textual URLs — wikis, docs, GitHub, news,
slugged product pages — and above all long URLs carrying `utm_*` and tracking
parameters. And it wins on the thing a database cannot offer at any size: no
state.

## Alphabets

| alphabet | bits/char | for |
|---|---|---|
| `base64url` | 6 | the default: legal unescaped anywhere in a URL |
| `base32` | 5 | a link read aloud or typed off a screen — case-insensitive |
| `emoji` | 10 | 1024 pictographs, three contiguous assigned runs |
| `cjk` | 14 | 16384 ideographs, the fewest visible characters |

`decode` takes no alphabet: three of the four say which they are just by being
themselves, and base32 — whose characters are all legal base64url — carries a
leading `~`. Fewest characters is not smallest QR code: a QR carries bytes, and
a CJK ideograph is three of them.

## Models are permanent

A link names the model it was coded against, so a published model id is frozen
forever — a link minted today has to resolve in ten years. A published model is
never re-edited and its id is never reassigned; a retrain gets a new id and the
old file stays distributed. Training is byte-reproducible for the same reason.

The files are release assets, not source. Their sha256 lives in
[`models/MANIFEST`](models/MANIFEST), because a link whose model was lost is a
dead link and the hash is what proves a recovered copy is the right one.

Both were trained on public data, and that is a requirement rather than a
convenience: a dictionary holds the tokens its corpus contained, so a model
trained on someone's browsing would publish their searches. They come from 27
million URLs of a Common Crawl index filtered to English and Portuguese, with a
floor of eight sightings before a token may enter a dictionary, and the host
dictionary seeded from a public popularity list.

To train your own:

```sh
caustic-mk build train && ./build/train <corpus> <out.lnzm> [id] [tier]
```

## lnzip.de

The code lives in the fragment, and a fragment is never sent to a server. The
destination URL therefore never reaches any infrastructure at all — the page
decompresses it in the reader's browser and sends them on. That is not a policy
about logs; there is nothing to log with.

The site is the codec compiled to WebAssembly with the tiny model embedded, a
WASI shim of about fifty lines, and one page. The same build produces a single
self-contained `build/lnzip.html` that opens from `file://` with no network.

```sh
caustic-mk run web          # build/site/ for lnzip.de, build/lnzip.html standalone
caustic-mk run web-test     # checks the wasm boundary with node
```

Only `http` and `https` are ever navigated to, and that check runs inside the
wasm rather than in the page script — with no database behind it a fragment
resolves to whatever it decodes to, so the check is the difference between a
shortener and a `javascript:` delivery mechanism. A code that decodes to
anything else is shown as inert text.

## Layout

```
core/errno.cst      error codes
url/split.cst       lossless segmentation: offsets only, nothing transformed
entropy/rc.cst      binary range coder with external, frozen probabilities
model/fmt.cst       model file format, loader, integrity check
model/ctx.cst       context → probability index, shared by codec and trainer
model/dict.cst      front-coded dictionaries
codec/codec.cst     the grammar: encoder, decoder and trainer walk side by side
fmt/alpha.cst       the four output alphabets
train/              token counting for the trainer
cli/main.cst        the command line tool
tools/              trainer, corpus gate, wasm embed and bundler
wasm/               the browser build
web/                the page
tests/              the suites and their runner
docs/design.md      the original plan and its phases
```

## Tests

```sh
caustic-mk run test        # every suite
caustic-mk run test-opt    # the same through the optimizing backend
```

## License

MIT — Cauã Alvarenga Neves.
