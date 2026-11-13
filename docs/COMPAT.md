# COMPAT.md — per-binding-unit compatibility tracker (DESIGN.md §5)

Status vocabulary: `planned` · `in-progress` · `done` · `degraded`
(with module counts recorded for every deferral — D11: nothing dropped
silently).

| FMD2 unit | Boundary | Status | Notes |
|---|---|---|---|
| LuaBase.pas | Init globals (`print`, `sleep`, `Trim`, …) | planned | §5.1 |
| LuaWebsiteModules.pas | module surface + 15 event dispatchers | planned | §5.1–5.2; table lives in contract/contract.json |
| LuaWebsiteModuleHandler.pas | chunk re-exec on module switch | planned | §5.3, §5.12 |
| LuaHTTPSend.pas / httpsendthread.pas | `HTTP` shim | planned | §5.4 (header sets, zstd policy D13, redirects-as-GET) |
| LuaStrings.pas | TStrings facade | planned | §5.5 |
| LuaXQuery.pas / LuaIXQValue.pas | CreateTXQuery + IXQValue | planned | §5.6 (fill overloads, json() node-tree, css(), error swallowing) |
| LuaCrypto.pas | fmd.crypto | planned | §5.7 (RC4, AES*GCM, X25519/P256, SecretStream pull) |
| LuaDuktape.pas | fmd.duktape ExecJS + JS require | planned | §5.7 (77 modules; JS error ⇒ nil) |
| LuaGZip.pas | fmd.gzip Inflate | planned | §5.7 |
| LuaFileUtil.pas | fmd.fileutil | planned | §5.7 (3 pure helpers) |
| LuaImagePuzzle.pas | fmd.imagepuzzle | planned | §5.7 (sharp port) |
| LuaPCRE2.pas | fmd.pcre2 | planned | §5.7 |
| LuaStringsStorage.pas | MODULE.Storage | planned | §5.1/§5.3 |
| lua-protobuf (`pb.dll`) | `pb` preload shim | planned | D17 (protobufjs-backed) |
| LuaSubprocess.pas | subprocess | planned (stub default) | §5.10–5.11 |
| uData.pas | GetInfo post-processing | planned | §5.8 (last-occurrence-wins dedupe) |
| uFavoritesManager.pas | favorites engine | planned | §7.2 (DoCheck parity) |
| uDownloadsManager.pas | download pipeline + packing | planned | §7.1/§7.3 (streaming packers, D16) |

Per-module pass rates are published via `/api/modules` and rendered in
Settings → Modules once Phase 1+ lands (§15).
