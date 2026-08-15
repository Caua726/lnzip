# lnzip — compressor lossless especializado em URLs

## Context

Encurtadores de link são bancos de dados: `abc123` é uma chave, não informação. Isso obriga a
manter estado pra sempre, e o link morre quando o serviço morre.

O lnzip inverte: o código **é** a URL comprimida. `nosso.dominio/CODE` → decodifica `CODE` →
302 pra URL original. Sem banco, sem expiração, links infinitos, e o payload resolve offline
por qualquer um que tenha o mesmo modelo.

A compressão não é genérica. Ela conhece a gramática de URL (esquema, host, path, query,
fragmento) e a estatística real da web (domínios, tokens de rota, nomes de parâmetro), então
gasta bits só no que é imprevisível. A analogia é AV1, não LZ4: conhecimento do domínio do
dado em vez de casamento de padrões cego.

### O que isso ganha e o que não ganha (declarado de propósito)

Contra URL com identificador aleatório, **nenhum compressor ganha de um banco de dados** — é
teoria da informação. `youtube.com/watch?v=dQw4w9WgXcQ` carrega 66 bits de aleatoriedade pura;
o melhor payload possível é ~72 bits = **12 chars Base64URL**, contra 7 do bit.ly. Mesma coisa
pra ASIN, UUID e hash de commit.

Onde o lnzip ganha muito: URL estrutural e textual (wiki, docs, GitHub, notícia, e-commerce com
slug) e, principalmente, URL longa com `utm_*`/tracking, que cai de ~200 chars pra ~10. E ganha
sempre no argumento que importa: **sem estado**.

## Decisões travadas

| Decisão | Escolha |
|---|---|
| Linguagem | Caustic (codec, CLI, treinador e servidor) |
| Coder de entropia | Aritmético binário, probabilidades **pré-treinadas e congeladas** (sem adaptação intra-URL) |
| Modelo no payload | Zero bytes de tabela — o modelo é externo e mmap'd |
| Corpus | Common Crawl (cdx) + Wikipedia external links + Tranco/Curlie + histórico local |
| Entrega | **Página estática, código no fragmento** (`lnzip.de#codigo`), decode em wasm no navegador |
| Escopo v1 | Ponta-a-ponta com modelo **Tiny**; Standard/Max são re-treino, não código novo |

## Restrições do ambiente (medidas)

- **RAM 15 GB, ~6 GB disponíveis, swap já em 11 GB.** O treinador **não pode** carregar 50 M de
  URLs em hash map. Tem que ser streaming + ordenação externa em disco, com teto de RSS (~2 GB).
- **Disco: 37 GB livres em `/`, 133 GB em `/mnt/2TB-Novo`.** Corpus vive no 2TB, nunca em `/`.
- Caustic v0.1.10 já levantou os limites de literal (2 MB round-trip verificado), mas **90 MB
  não cabe no binário**: o `brotli_dict` de 122 KB custa 495 KB de fonte. Modelo é arquivo.

## Arquitetura

### Princípio que garante o lossless

O encoder é **dirigido pelo decoder**. Em cada ponto de decisão ele computa o que o decoder
produziria a partir daquele símbolo e só emite o atalho estrutural se a reconstrução for
byte-idêntica ao input restante. Nada é normalizado — a forma canônica é só a *previsão*; todo
desvio (`%2F` vs `%2f`, `:80` explícito, barra final, `?` vazio, esquema maiúsculo, UTF-8 cru
no path) é um flag fortemente enviesado que custa fração de bit quando ausente.

Consequência: o codec é uma bijeção sobre strings de bytes. Qualquer entrada — inclusive lixo
que não é URL — round-trippa, via o modo `raw` (1 bit + modelo de char order-3).

### Módulos

**O codec não depende do `caustic-net`.** Só `server/` depende. Isso mantém o núcleo
fuzzável, portável (`--target=wasm32-wasi` funciona) e livre das deps transitivas
(`caustic-crypto` + `caustic-compact`) que a facade do net arrasta — e faz o bloqueio de
tag do `caustic-net` (ver Riscos) atrasar só a P8, não a P1.

```
lnzip/
  Causticfile              caustic-mk; depend caustic-compact; caustic-net só no target server
  lnzip.cst                barrel para `caustic -c`
  core/      errno.cst     faixa -1900..-1999 (espaço virgem; -1300 é do http1, -1200 do url)
             bits.cst  buf.cst
  url/       split.cst     segmentação lossless: só offsets, zero transformação
             classify.cst  detectores: dígitos, hex, UUID, base64ish, data ISO
  model/     fmt.cst       formato do arquivo, loader mmap, validação de hash
             ctx.cst       ★ definição dos contextos — COMPARTILHADO codec+treinador
             dict.cst      dicionários front-coded: lookup e reverse
  entropy/   rc.cst        range coder binário, probs externas congeladas
  codec/     grammar.cst   a gramática modelada (o coração)
             encode.cst  decode.cst
  fmt/       b64url.cst  uni.cst
  train/     corpus.cst  count.cst  bpe.cst  build.cst
  server/    http.cst  main.cst
  cli/       main.cst
  bench/     bench.cst
  tests/     run.cst + test_*.cst
  models/    artefatos de release, fora do git (Tiny pode ser commitado)
```

`model/ctx.cst` é o arquivo mais importante do repo: define a função contexto → índice na
tabela de probabilidades. Treinador e codec **importam o mesmo arquivo**. Se divergirem, o
modelo fica silenciosamente inválido e o bug é quase impossível de achar.

### Formato do payload

Bitstream aritmético puro, sem header em bytes. Ordem dos símbolos:

1. `model_id` (3 bits em bit-tree, prob **hardcoded no binário** — o modelo ainda não foi
   escolhido nesse ponto; `7` = escape para +8 bits). Cobre tier e versão juntos.
2. `mode`: estrutural | raw (1 bit, ~0.02 bit quando estrutural).
3. A gramática (auto-terminante — o decoder sabe onde parar; bits de sobra do último char
   Base64 são ignorados).

**Gramática modelada, na ordem:** esquema → flags de autoridade → userinfo → host (IP literal?
domínio registrável por índice de dicionário; subdomínio) → porta → contagem de segmentos de
path → cada segmento (perfil por domínio no Max → dicionário global de tokens → subword BPE →
char) → contagem de params de query → cada `chave=valor` → fragmento → canal de desvios.

Índice de dicionário **não** usa bit-tree plano (1 M entradas = 2 MB de probs, o orçamento
inteiro do Tiny). Usa código de faixa: `floor(log2(rank+1))` num alfabeto de ~24 símbolos com
distribuição treinada, seguido dos bits baixos crus. Casa com Zipf e custa ~24 contextos.

**Decisão em aberto, a resolver com o número da P7: checksum.** Sem banco, um typo no código
redireciona pra outro lugar em silêncio em vez de dar 404. 8 bits de checksum custam ~1,3 char
Base64 — muito num link de 10 chars. A gramática já rejeita boa parte do lixo (token impossível,
limite estourado), mas não é garantia. Fica como flag por modelo, default desligado na v1,
decidido com a taxa de colisão medida.

### Formato do modelo

```
magic "LNZM" | u16 fmt_ver | u16 model_id | u8 tier | u64 content_hash | tabela de seções
  PROBS     u16[] plano — o array de probabilidades indexado por contexto
  DOMAINS   blob front-coded, ordenado + índice de bloco (1 offset a cada 64) + rank[]
  TOKENS    vocabulário BPE, mesmo esquema
  PROFILES  regras estruturais dos top-N domínios (só Standard/Max)
```

mmap read-only, custo de startup zero. `content_hash` conferido no load: modelo alterado é
**rejeitado**, não aceito com aviso.

**Imutabilidade é requisito, não boa prática.** Link de 2026 tem que resolver em 2036. Um
`model_id` publicado nunca é reatribuído nem reeditado; um modelo novo ganha id novo e o
antigo continua distribuído. Isso obriga o treinador a ser reprodutível: aritmética inteira
apenas, emissão sempre ordenada, nada dependente de ordem de hash, zero float no caminho de
codificação.

Modelos publicados vão como **release assets com sha256 registrado no repo** — nunca só no
disco local. Um link permanente cujo modelo se perdeu é um link morto.

**Orçamento por tier.** A hipótese é que o topo do ranking de domínios satura rápido (poucos
domínios cobrem quase todo o tráfego), então o orçamento extra do Max renderia mais em
**vocabulário de path/query e perfis por site** do que em mais domínios. Isso é **medível na
P5** — a curva de cobertura por rank sai de graça da contagem, e a divisão do orçamento entre
os tiers é decidida com ela, não no chute abaixo.

| Tier | Alvo | Composição inicial (revisada com a curva da P5) |
|---|---|---|
| Tiny | ~2 MB | 64 k domínios, 16 k tokens, probs mínimas |
| Standard | ~25 MB | 1 M domínios, 256 k tokens |
| Max | ~90 MB | ~4 M domínios, 512 k tokens, perfis dos top 10 k sites |

### Alfabetos de saída

- **Base64URL** (`A-Za-z0-9-_`, sem padding), 6 bits/char. É a saída principal: entra em path
  de URL sem escape.
- **Unicode**, 14 bits/char, alfabeto = **CJK Unified Ideographs U+4E00–U+9FFF** (20.992 ≥ 2^14).
  Escolhido por ser estável em NFC/NFD, sem combining marks, sem bidi, um codepoint por
  grafema. Chegar a 15 bits exigiria Hangul, que decompõe em NFD — descartado.
  Caveat honesto: no fio esses chars são percent-encoded (3 bytes → 9 chars); o ganho é de
  **caracteres visíveis** ao exibir/colar, não de bytes.

96 bits → 16 chars Base64URL → 7 chars CJK, como esperado.

## Reuso (verificado)

| Peça | Origem | Como |
|---|---|---|
| Range coder binário | `caustic-compact/formats/lzma.cst` (`_dec_bit`/`_enc_bit`/`_bittree*`) | **Extrair** para `entropy/rc.cst` standalone: hoje está preso ao `struct Lzma`, e queremos probs congeladas externas em vez do update `p += (2048-p)>>5` |
| Buffer, errno, bit I/O, CRC | `caustic-compact/core/{bytes,errno,bitreader,bitwriter,checksum}.cst` | Direto |
| Baselines do bench | `caustic-compact/formats/{gzip,brotli,zstd,lzma2,lz4}.cst` | Direto — os 5 comparativos pedidos já existem na lib |
| Leitura do corpus comprimido | `caustic-compact` gzip/zstd decode | O treinador lê os dumps sem descomprimir em disco |
| Parser de URL | `caustic-net/proto/url.cst` | **Descartado pro codec.** Ele não muta nada (bom), mas: exige literalmente `"://"` (rejeita `mailto:`, path-relative), **não tem `port_off`/`port_len`** — só `u.port as i64` já preenchido com a porta default, então perde se a porta era explícita; e não quebra host em labels. Escrevemos `url/split.cst` próprio (~150 linhas de busca de delimitador). Serve de referência de casos de borda |
| Socket, listen, accept, `Conn` | `caustic-net/{core/conn,transport/tcp_conn,transport/transport}.cst` | Direto no `server/`. `tp.init()` **antes** de qualquer thread, senão o allocator deadlocka |
| Leitura de request line/headers | `caustic-net/core/bufread.cst` (`br_read_line`) | O `cap` do BufReader **é** o limite de header — defesa pronta contra header bomb |
| Hash map do treinador | `std/map.cst` (`MapI64`) | `MapStr` exige chave NUL-terminada; fatias de URL usam `MapI64` sobre hash de 64 bits |
| Estrutura do repo, runner, `depend` | `caustic-image/` (`Causticfile`, `tests/run.cst`) | Padrão mais novo da casa — copiar de lá, não do compact |

**Não existe e será escrito:** trie/dicionário front-coded, coder com probs externas, BPE,
toda a ferramenta de treino, gerador de fixture, e — do lado do servidor — **parser de request
HTTP e response builder** (o `proto/http1.cst` do caustic-net é só cliente; não há uma única
função que monte `HTTP/1.1 302`). São ~200 linhas, com o accept loop.

**Gotchas da linguagem que valem pro código todo:** sem array literal (tabela = `*u8 with imut`
com `\xNN`; **nunca `with mut`**, vira lixo); sem literal negativo (`0 - 1`, e isso **não folda**
em `with imut`); sem closures (`fn_ptr` + ponteiro de contexto); `type`, `call`, `only`, `gen`
são reservadas; `printf` não tem `%f`; `--path` precisa ser absoluto; scripts do `caustic-mk`
rodam sem herdar o ambiente.

## Fases

Cada fase tem um portão verificável. Nenhuma avança com o portão vermelho.

**P0 — Esqueleto.** `Causticfile`, `core/errno.cst`, barrel, `tests/run.cst` multi-arquivo
espelhando `caustic-image`. LICENSE em nome de Cauã Alvarenga Neves.
*Portão:* `caustic-mk run test` verde.

**P1 — Segmentação lossless.** `url/split.cst` + remontagem byte-exata. Conjunto adversarial
embutido (case de percent-encoding, `//` duplicado, IPv6 literal, userinfo, UTF-8 cru, query
vazia, fragmento vazio, URL de 8 KB) + histórico local do Brave.
*Portão:* 100% de round-trip byte-exato. Essa fase é a fundação — se ela vaza, nada acima presta.

**P2 — Range coder.** `entropy/rc.cst` standalone com probs externas.
*Portão:* round-trip de sequências aleatórias com probs aleatórias, e custo real dentro de ~1%
de `-log2(p)` somado.

**P3 — Codec com modelo bootstrap.** `model/fmt.cst`, `model/ctx.cst`, `codec/{encode,decode}`,
e um modelo bootstrap de probs uniformes gerado pelo próprio `train/build.cst`. Modelo de char
order-2 só. Já deve bater gzip em URL curta.
*Portão:* round-trip do corpus local inteiro + `lnzip` roda sem modelo treinado.

**P4 — Alfabetos e CLI.** `fmt/b64url.cst`, `fmt/uni.cst`, `cli/main.cst`
(`encode|decode|info`). Targets separados no `Causticfile`: `lnzip`, `lnzip-train`,
`lnzip-bench`, `lnzip-server`.
*Portão:* round-trip dos alfabetos em todos os comprimentos de borda (1..64 bits).

**P5 — Treinador e modelo Tiny.** `train/corpus.cst` (streaming de `.gz`/`.zst`),
`train/count.cst` (contagem external-memory com ordenação em disco, teto de RSS),
`train/bpe.cst`, `train/build.cst`.
*Portão:* Tiny ≤ 2 MB, e **duas execuções produzem bytes idênticos** (reprodutibilidade).

**P6 — Gramática estrutural.** `codec/grammar.cst` completo: componentes, dicionário de
domínio, tokens de path/query, detectores tipados (número/hex/UUID/base64/data), canal de
desvios, modo raw.
*Portão:* round-trip 100% no corpus **e** ganho medido sobre P3.

**P7 — Benchmark.** `bench/bench.cst` contra gzip, Brotli, Zstd, LZMA2, LZ4 e o baseline
"base64 do UTF-8 cru". Métricas: `original_bytes`, `compressed_bytes`, `ascii_chars`,
`unicode_chars`, `compression_ratio`, `encode_time`, `decode_time` — com p50/p90/p99 e quebra
por categoria de URL (curta/média/longa, com/sem ID aleatório, com/sem tracking).
*Portão:* tabela publicada no README com números reais, incluindo os casos em que perdemos.

**P8 — Página estática (substitui o servidor).** `server/http.cst`: request line + headers via `bufread.br_read_line`,
accept loop single-thread com `tp.listener_wait`, `GET /<code>` → 302 `Location`,
`GET /api/encode?url=…`, `GET /` com formulário. **Pré-requisito: resolver a tag do
`caustic-net`** (ver Riscos) — nada mais depende disso.
*Portão:* ponta-a-ponta — encode pelo CLI, `curl` no servidor, redirect correto; e um teste que
manda lixo e URL gigante sem derrubar o processo.

**P9 — Standard e Max.** Re-treino com corpus maior + perfis por site. Meta: **nenhuma linha
nova de codec**; se precisar, é sinal de que o `ctx.cst` foi mal fatiado.

## Segurança (o servidor é exposto)

- Decoder recebe path controlado por atacante: todo acesso com bound check, limite duro de
  tamanho de saída (8 KB), de contagem de segmentos e de comprimento de token. Erro → 404, nunca
  loop nem escrita fora.
- **Allowlist de esquema no decode**: só `http`/`https` viram `Location`. Sem isso o encurtador
  vira vetor de `javascript:`/`data:`.
- Sem banco significa que qualquer payload resolve pra algum lugar — inerente ao design. Limites
  de request line (8 KB), timeout de conexão, sem keep-alive na v1.

## Verificação

```sh
caustic-mk run test        # suíte inteira (cada tests/test_*.cst compila e sai 0)
caustic-mk run test-opt    # o mesmo com -O1/-O2, pega bug dependente de otimização
caustic-mk build bench && ./build/bench /mnt/2TB-Novo/lnzip-corpus/holdout.txt.zst
caustic-mk build lnzip
./build/lnzip encode 'https://wiki.archlinux.org/title/Arch_User_Repository#Frequently_asked_questions'
./build/lnzip decode '<code>'    # tem que sair idêntico, byte a byte
caustic-mk build server && ./build/server 8080 &
curl -sI localhost:8080/<code>   # 302 com Location correto
curl -sI localhost:8080/////%%%  # 404, processo vivo
```

O portão que vale mais que todos: **round-trip byte-exato em 100% do corpus**, rodado a cada
fase, não só no fim. O corpus é a suíte de testes.

## Riscos

| Risco | Mitigação |
|---|---|
| URL exótica quebra o lossless | Encoder dirigido pelo decoder + modo raw; corpus como portão contínuo |
| Treinador estoura a RAM | External-memory desde o início, teto de RSS explícito, corpus no 2TB |
| Modelo e codec dessincronizam | `model/ctx.cst` único, importado pelos dois; `content_hash` no load |
| Link antigo quebra num update | `model_id` congelado, modelos publicados nunca reeditados, treino reprodutível |
| Razão decepciona em URL com ID aleatório | Já assumido no design; o bench reporta por categoria em vez de esconder na média |
| Open redirect | Allowlist de esquema no decode |
| **`caustic-net` v0.1.0 não tem `url`/`http1`/`bufread`** — a tag aponta pro 1º commit, 26 commits atrás do `main` | Cortar tag nova (ex. `v0.2.0`) no `caustic-net` antes da P8. `tag "main"` funciona mas deixa a dep não-pinada, o que é ruim pra um serviço de link permanente. Só a P8 bloqueia |

## Pendências (em paralelo, não bloqueiam a P0)

1. Conferir que a tag `v0.1.0` do `caustic-compact` contém `formats/{lzma,brotli,zstd,lz4}.cst`
   — se não, cortar tag nova lá. **Bloqueia a P2.**
2. Cortar tag nova no `caustic-net` em `main` (a `v0.1.0` não tem `url`/`http1`/`bufread`).
   **Bloqueia só a P8.**
3. Baixar os corpora pra `/mnt/2TB-Novo/lnzip-corpus/` (download único, resto offline) e separar
   um **holdout** que o treinador nunca vê — sem isso o benchmark mede memorização, não
   compressão. **Bloqueia a P5.**

Toolchain: Caustic v0.1.10 instalado, acima do mínimo v0.1.8 exigido pelas libs da casa. ✅

## Comandos dos targets

```
caustic-mk build lnzip        # CLI: encode / decode / info
caustic-mk build lnzip-train  # treinador (P5)
caustic-mk build lnzip-bench  # benchmark (P7)
caustic-mk build lnzip-server # redirecionador (P8)
caustic-mk run test | test-opt
```
