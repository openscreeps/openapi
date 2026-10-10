# Screeps HTTP OpenAPI

OpenAPI 3.1 contracts for **official Screeps World** and the **OpenScreeps standalone server**. Community-maintained; not an official Screeps API guarantee.

- [YAML bundle](openapi.yaml) — self-contained, ready for OpenAPI tools.
- [JSON bundle](openapi.json) — the identical contract in JSON.
- [Source fragments](spec/) — edit these, not the bundles.
- [Pinned upstream revisions](sources.json) and [route coverage inventory](coverage.json).

## Use

Download `openapi.yaml` or `openapi.json` from a pinned repository commit for reproducibility. Import it into an OpenAPI viewer, HTTP client, or generator. Set the base URL to `https://screeps.com` or your OpenScreeps server URL. **Not every operation exists on both servers.**

Each operation includes:

- `x-availability.screeps-com` and `x-availability.openscreeps`: `supported`, `unsupported`, or `unverified`.
- `x-sources`: commit-pinned source links with line anchors.
- Descriptions and, where applicable, `x-compatibility` notes explaining differences.

A supported marker means the pinned implementation or reference client documents the operation. It does **not** mean we executed every endpoint live. Shared response schemas can admit multiple server representations; consult the operation notes before relying on a server-specific field. Arbitrary bot Memory, code-defined object data, and snapshot internals intentionally remain extensible.

### Authentication and errors

Send an API/session token in `X-Token`. Legacy clients also send that token in `X-Username`. Preserve the `X-Token` response header when the server rotates a session. OpenScreeps additionally accepts a player bearer token, and its configured `X-Server-Password` is independent of player authentication. Query-string tokens are accepted by its implementation but intentionally not encouraged in this specification: URLs are frequently logged.

OpenScreeps `/admin` uses a **separate administrator bearer secret**, not a player token. It is disabled unless configured. Several commands delete players, replace a world snapshot, or publish messages. A schema or example is not permission to execute an operation.

**HTTP 200 does not establish success.** Gameplay endpoints can return `{error: string}` with status 200, and official responses can also include `ok`. Inspect the body. Administrative validation errors use HTTP 400. Never automatically retry an uncertain mutation.

Do not send credentials to untrusted base URLs or follow authenticated cross-host redirects. Official initial spawn placement can reset shard CPU allocation; do not assume the allocation survives placement. Official world-status is account-wide, not proof that one particular shard has no surviving colony. OpenScreeps serves one world.

## Coverage and evidence

The coverage boundary is the union of HTTP route declarations in pinned `openscreeps/server` controllers and calls in pinned `screepers/node-screeps-api` (including the dynamic official history path). Backend-local is corroborating evidence for shared/private behavior, **not** proof of official availability. Platform endpoints implemented by OpenScreeps cite their source and compatibility notes.

`coverage.json` is extracted with the TypeScript AST, records method/path/file/line, and is checked against the bundled contract. Duplicate declarations are retained as evidence. Explicit exclusions:

- `/api/authmod`: a private-server extension; the reference client synthesizes the official result without making an HTTP call, and OpenScreeps does not implement it.
- `/api/warpath/battles`: the reference client explicitly calls it unavailable on official servers; OpenScreeps does not implement it.

The specification does not claim to enumerate undiscovered, undocumented production routes. Seasonal routes may need a seasonal base URL and carry endpoint-specific notes. WebSocket/SockJS subscriptions, browser application routes, and the in-game JavaScript API are outside this HTTP contract. The standalone HTML landing page, health, assets, history, and administrator endpoints are included.

Sources:

- [OpenScreeps server](https://github.com/openscreeps/server/tree/3954fd26f107a4b508ccaf6b5f64e4aa951d9e91): authoritative for the pinned standalone implementation (ISC).
- [OpenScreeps game](https://github.com/openscreeps/game/tree/fd9cde57de20a1e37a0108c46ca78314c8b9bc36) and [engine](https://github.com/openscreeps/engine/tree/55883bef45d0d1c3c8c16e497fca56fe0b43ff11): the server's pinned domain dependencies, including intent payloads and administrator operations.
- [node-screeps-api](https://github.com/screepers/node-screeps-api/tree/0f861874ff119b7ba37d0d1a4beb90f096209f4e): community client contracts, secondary evidence for the undocumented official HTTP API.
- [Screeps backend-local](https://github.com/screeps/backend-local/tree/9d079282303ec04e577ac2bb97f64312b25e4ccd): private-server route behavior (MIT).
- [Official token guidance](https://docs.screeps.com/auth-tokens.html).

## Development

Node 24 LTS is pinned through `mise.toml`. Dependencies are pinned in `package-lock.json`; TypeScript 5.9 is used for tooling because the selected OpenAPI generator declares a TypeScript 5 peer dependency. No TypeScript code needs compiling to consume the specification.

```sh
mise install
npm ci
npm run build
npm run check
npm run format:check
npm run types
```

`build` merges fragments, rejects duplicate operations/components, adds shared transport metadata, and produces deterministic JSON/YAML. `check` verifies that committed bundles are current, compiles schemas with JSON Schema 2020-12, checks references/provenance/coverage, then runs Redocly. `types` generates and type-checks a throwaway TypeScript client contract under ignored `build/`. CI also checks out the pinned server/client sources and verifies the extracted route inventory. No account credentials are needed.

To refresh the source inventory, clone each repository into `.sources/server`, `.sources/client`, and `.sources/backend`, check out the exact commits in `sources.json`, then run `npm run inventory`. To verify rather than overwrite it, run `node scripts/inventory.mjs --check`. Source checkouts are ignored and never published. Update revisions, fragments and inventory together when upgrading the coverage baseline.

### Read-only live verification

```sh
npm run smoke
```

The default target is official Screeps. Optional environment variables:

| Variable                  | Purpose                                                              |
| ------------------------- | -------------------------------------------------------------------- |
| `SCREEPS_TARGET`          | `screeps-com` (default) or `openscreeps`                             |
| `SCREEPS_API_URL`         | Server origin; defaults to official or localhost according to target |
| `SCREEPS_TOKEN`           | Enables authenticated read-only checks; never logged                 |
| `SCREEPS_SHARD`           | Official shard; default `shard3`                                     |
| `SCREEPS_ROOM`            | Room to inspect; default `W1N1`                                      |
| `SCREEPS_SERVER_PASSWORD` | Optional standalone server password                                  |

The smoke script makes only GET requests, rejects redirects, validates real response bodies against the bundled schemas, and logs only endpoint/status results. It does not print or save Memory, account details, tokens, or raw response bodies. An endpoint error fails the smoke even if its error envelope validates. Public checks alone do not verify authenticated contracts.

## Verified baseline

Validated on 2026-10-10 against the pinned sources:

- **100 paths, 103 operations, 250 reusable schemas**; every inventoried target route covered.
- Deterministic JSON/YAML parity, JSON Schema 2020-12 compilation, and Redocly validation without warnings.
- Generated TypeScript declarations compile; four consumer-facing schema regression tests pass.
- **14 official read-only HTTP responses** validated, including authenticated account, branches, Memory, rooms and world status.
- **21 disposable OpenScreeps HTTP JSON responses** validated, including authentication failures, administrator input errors, account creation, world ticks and snapshot export; PNG terrain and HTML responses also exercised.

Live checks corrected two stale reference-type assumptions: official capability entries have optional `menuData`, and `steam.ownership` can be an array of Steam application IDs. These are documented with dated operation observations and retained regression tests. No official account/world mutations were made during verification. The local smoke used an isolated temporary database, removed afterward; raw authenticated responses are not published.

## License

[ISC](LICENSE). Upstream implementations and reference materials retain their own licenses; source checkouts are not distributed here.
