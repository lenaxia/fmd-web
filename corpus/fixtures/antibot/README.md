# Antibot / websitebypass fixtures (DESIGN.md §12 Phase-0, §5.9, §13.1)

Ground truth for the **host-level antibot interceptor pipeline tests**
(`server/test/engine/state/antibot.pipeline.integration.test.ts`), replayed
**fully offline** — the only sockets opened are loopback (DESIGN §13).

```
antibot/
├── manifest.json                            registration + provenance + pinned constants
├── challenge-iuam.html                      deterministic IUAM challenge page (JS → Duktape.enc/dec)
├── signature-plan.json                      checkantibot.lua:5-12 signature matrix (9 shapes)
├── websitebypass-config-default.json        use_webdriver=false (IUAM scenario)
├── websitebypass-config-flaresolverr.json   use_webdriver=true (FlareSolverr/reload scenario)
└── flaresolverr-endpoints.json              health body + solved-cookie solution
```

### Provenance (why nothing here is live-captured)

DESIGN §12 Phase-0 requires **bypass** fixtures in the corpus. Live Cloudflare
capture was rejected (fragile, ToS-adjacent); the audited, agreed level is a
faithful OFFLINE pipeline: **real FMD2 bypass scripts executed against a local
mock server that emits real antibot signatures**. Every response shape here is
derived from FMD2 behavior at commit `97c903b`:

- `checkantibot.lua:5-12` — 403/429/503 + `Content-Type` contains `text/html`
  + `Server` contains `cloudflare`/`ddos-guard`, case-folded substring
  semantics → `signature-plan.json`.
- `cloudflare.lua` IUAM branch — 503 + the `<form id="challenge-form"
  action="/cdn-cgi/l/chk_jschl?__cf_chl_jschl_tk__=…">` + newline-prefixed
  self-closing `<input name=/value=/>` entries its Lua patterns extract, and a
  first `<script>` block computing `jschl-answer` through the same primitives
  its generated preamble wires (`Duktape.enc`/`Duktape.dec` via
  `btoa`/`atob`) → `challenge-iuam.html`.
- `cloudflare.lua` FlareSolverr branch — `load_config()` config shape,
  `GET /` health (`{"msg": "FlareSolverr is ready!"}` parsed with
  `CreateTXQuery` + `XPathString('msg', json(*))`), the
  `flaresolver_status_code`/`flaresolver_result` stdout shape of
  `cloudflare.py`, and the `creatReloadStrings()` reload pages.

### The challenge answer (what makes the test real)

The fixture page's JS computes

```
jschl_answer = base64('fmd-web:' + Duktape.dec('base64', 'dGs1MjA='))
             = 'Zm1kLXdlYjp0azUyMA=='
```

The mock server **validates the POSTed answer** against that constant. If the
Duktape shim (ExecJS heap, enc/dec polyfill, DOM stubs from cloudflare.lua's
preamble) breaks, the answer is wrong/absent → the mock replies
`Access denied. Your IP address has been banned.` → no `cf_clearance` → the
bypass fails → the test fails. The duktape leg is therefore *exercised*, not
mocked away.

### Consumption

The test materializes each scenario's config into the wasmoon **wasm MEMFS**
(`LuaFactory.mountFile` at the literal `lua\websitebypass\websitebypass_config.json`
path `cloudflare.lua:load_config()` reads) — nothing is written to the repo
tree. The mock server itself runs on a worker thread (the Lua-facing request
path is synchronous); its plan is seeded from these files at test start.

See `docs/evidence-antibot-integration.md` for the run evidence and the
documented fidelity notes (TextDecoder/atob gap, ExecJS timeout quirk,
subprocess 4-value return).
