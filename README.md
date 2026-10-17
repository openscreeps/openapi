# Screeps contracts and TypeScript clients

Canonical, evidence-backed **official Screeps HTTP and socket contracts**, explicit compatibility profiles for the **OpenScreeps standalone server** and the **stock Screeps community server**, **plugin contracts** for community server mods, and generated **runnable TypeScript clients**. Community-maintained, not an official Screeps API guarantee.

## Ownership and direction

- This repository owns the official [OpenAPI JSON](openapi.json), [YAML](openapi.yaml), the official socket contract ([AsyncAPI JSON](asyncapi.json), [YAML](asyncapi.yaml)), source schemas, source inventory, the [standalone](profiles/standalone.json) and [community](profiles/community.json) profiles and the [plugin contracts](plugins).
- The official contract describes official wire behavior. It is not a union widened to accommodate OpenScreeps implementation differences.
- Each profile partitions official operation IDs into required and excluded operations. Every exclusion has a reason. Necessary adaptations have explicit reasons and precise schema overrides. A profile describes one server implementation exactly; it is not widened for mods.
- Community server mods are plugin contracts layered on a composed profile document; they state exactly which operations they provide, adapt or add.
- [`openscreeps/server`](https://github.com/openscreeps/server) owns its extension contracts, including administrator and host endpoints. It combines the pinned official contract, compatibility profile and its extensions to generate its own OpenAPI document, TypeScript client and handler interfaces.
- Implementations must satisfy their contract. Generated types do not implement game behavior; server route checks and real HTTP conformance checks enforce the boundary.

Hosted account, commerce, seasonal and shard services outside the standalone profile remain documented in the official catalog, but are not advertised as callable methods in the standalone client. No Rust client generation is included.

## Socket contract

[`asyncapi.json`](asyncapi.json) (AsyncAPI 3.0, built from [`socket/`](socket)) describes the official socket protocol: the SockJS endpoint `/socket` and its raw WebSocket transport `/socket/websocket`, the greeting lines, `auth`/`subscribe`/`unsubscribe`/`gzip` commands, `gz:` compressed frames and every channel the official client subscribes to, with payload schemas for each `[channel, data]` event. Payload schemas are draft-07 AsyncAPI schemas; channel names are expressed as patterns of the first tuple item. `RoomObjectsDiff` documents how the official client applies incremental room updates: a new id carries a complete `RoomObject`, a held id a `RoomObjectPatch` (partial at every depth, `null` for removed properties, top-level arrays possibly keyed by index). Room objects are typed field by field after the upstream room object documents, in the socket contract and as `GameRoomObject` in the HTTP contract. The document is written from the server's perspective: `receive` operations are client commands.

The package exports it as `@openscreeps/openapi/socket`. Standalone and community servers name channels without a shard and differ in a few messages; compose their socket contract with `composeSocketProfile` rather than reading the official document. Plugin contracts are HTTP only: no socket message of the community profile changes shape under the covered mods, so their socket-side effects (screepsmod-auth's channel restrictions for restricted API tokens, screepsmod-admin-utils' own `stats` and `warpath` channels) are recorded as plugin `behaviour`, and the plugin format has no socket section yet.

## Generate clients

Clients expose named methods derived from `operationId`, with typed request and response models. The maintained native-fetch runtime handles HTTP serialization, authentication and Screeps error envelopes; endpoint paths and operation signatures are generated.

```sh
npm ci --ignore-scripts
npm run build
npm run generate:client
npm run build:clients
```

Generate a client and handler contracts from another composed target document:

```sh
node scripts/generate-clients.mjs --input path/to/openapi.json --output path/to/generated --name openscreeps --runtime @openscreeps/openapi/client-runtime
```

Append `--check` to verify committed output without rewriting it. The generated server interfaces are contracts for real handlers, not generated no-op implementations.

The package is installable from GitHub; commit the resulting lockfile and pin an immutable revision for releases:

```sh
npm install github:openscreeps/openapi
```

Its `prepare` lifecycle builds the official bundle and compiled TypeScript client from committed source data. Normal consumer use does not require cloned upstream sources. No package has been published to the npm registry as part of this work.

```ts
import { createClient } from '@openscreeps/openapi/clients/official';

const client = createClient({ baseUrl: 'https://screeps.com' });
const version = await client.platformVersion();
const terrain = await client.gameRoomTerrain({
  query: { room: 'W1N1', shard: 'shard3', encoded: '1' },
});
```

For authenticated calls, supply `credentials: { Token: token }`, where `token` is a secret
loaded by your application. The standalone client additionally knows its own authentication
schemes; do not reuse a player token as `AdminToken`. Generated `OperationHandlers<Context>`
and `RequestOf<OperationId>` types are exported beside each target's `createClient`.
Consumers need TypeScript's DOM library or compatible Node fetch globals.

## Client behavior and safety

- Player tokens and administrator secrets are distinct credentials. The standalone administrator API must never receive a player token as a substitute for its administrator secret.
- Successful session-token rotation is retained for later calls. Never log credentials or authenticated response bodies.
- HTTP 200 is not sufficient for success: Screeps can return an `{error: string}` envelope with status 200.
- Mutations are not automatically retried. An interrupted response can leave the outcome uncertain.
- Requests reject all redirects, including same-origin redirects. Only configure trusted server URLs.
- JSON, text and binary responses decode to schema-defined values, strings and `Uint8Array` respectively; bot Memory is not automatically interpreted as game state.
- Official spawn placement can reset shard CPU allocation. Official world status is account-wide, not proof that one specific shard has no surviving colony.

Changing an OpenAPI document changes generated consumer interfaces. Review contract changes as public API changes, not merely documentation edits.

Generated methods and `call()` throw on HTTP failure or a logical error envelope. `send()`
instead exposes the status, headers, media type and decoded body, including declared error
responses. `onCredentialRefresh` can persist rotated credentials without logging them.
Wildcard asset parameters use `x-openscreeps-wildcard`; bearer refresh headers use
`x-openscreeps-refresh-header`. These transport extensions are explicit in the composed
contract rather than hard-coded by endpoint name.

## Layering: official, profiles, plugins

Contracts are layered; each layer states every difference from the one below with a reason and pinned evidence:

1. **Official** ([`openapi.json`](openapi.json), [`asyncapi.json`](asyncapi.json)): screeps.com.
2. **Profiles** (`profiles/<name>/` built into `profiles/<name>.json`): one server implementation each, composed with the official contracts.
   - **standalone** ([`profiles/standalone.json`](profiles/standalone.json)): OpenScreeps' own contract; `openscreeps/server` composes it with its extensions. Its `GET /api/version` lists `serverData.features` as the official client's fallback features (`market`, `auth`) plus `{name: 'openscreeps', version: 1}`, by which clients identify an OpenScreeps server.
   - **community** ([`profiles/community.json`](profiles/community.json)): the stock Screeps private server without mods.
3. **Plugins** ([`plugins/<name>.json`](plugins)): community server mods, composed in order on a composed profile document: [`screepsmod-auth`](plugins/screepsmod-auth.json) and [`screepsmod-admin-utils`](plugins/screepsmod-admin-utils.json) on `community`. A typical community server is `composePlugins(official, composeProfile(official, community), [screepsmodAuth, screepsmodAdminUtils])`.

### Community profile

[`profiles/community.json`](profiles/community.json) (built from [`profiles/community/`](profiles/community)) describes the stock Screeps private server, [screeps/backend-local](https://github.com/screeps/backend-local) at the pinned `backend` revision, without mods. It requires exactly the 72 official operations backend-local routes, excludes the other 91 with reasons, and adds the three private-server routes it serves for the official client when `options.official` is false: `GET /api/game/tick`, `GET /room-history` (HTTP 500 `not implemented` unless a mod supplies history) and the static `GET /assets/{path}` (world-map images and renderer resources). Adaptations record where stock replies differ from screeps.com: single-world shapes without `shards` (`user/overview`, `user/rooms`, `market/my-orders`), plain start rooms, unimplemented statistics and leaderboards that always answer empty placeholders, a message index keyed by the caller, and map stats that carry complete user documents. Notes describe stock behaviour such as Memory writes queued as written, 40-hex session tokens that rotate on every authenticated reply and require `X-Username` next to `X-Token`, `exists` registration checks compared lower-cased, storage-driver write results in success bodies and handler exceptions reported as HTTP 200 `TypeError` errors. It is composed exactly like the standalone profile (`composeProfile`, `composeSocketProfile`); community mods are separate plugin contracts layered on the composed community document. Every required read-only operation the mods do not replace was validated against real replies of a stock 4.3.0 world and of one running screepsmod-auth and screepsmod-admin-utils. `check` asserts that it requires exactly the official operations whose routes the coverage inventory lists for backend-local and that every other backend-local route is a community addition.

### Profile composition

`composeProfile(official, profile, extensions)` and `composeSocketProfile(officialSocket, profile)` are exported from `@openscreeps/openapi/contracts`. A profile uses:

- `required`: official operation IDs the server must implement.
- `excluded`: official operation IDs mapped to exclusion reasons.
- `adaptations`: required operation IDs mapped to reasons for precise differences.
- `overrides`: RFC 7386 merge patches for adapted operations and explicit component changes
  (each component override with `x-profile-reason`).
- `additions`: non-official compatibility operation IDs mapped to reasons; their operation
  definitions live in `overrides.paths`. These include private-server tick and history routes.
- `transport`: explicit transport parameters, including the optional server password.
- `notes` and `evidence`: profile-specific explanations (prefixed with the capitalized profile
  name in operation descriptions) and source citations.
- `socket`: the profile's socket contract: `info` and `servers`, `excluded` official messages
  with reasons, `adaptations` with reasons, `evidence`, and RFC 7386 `overrides` of `messages`
  and `schemas` (each schema override with `x-profile-reason`). Every message that uses an
  overridden schema must be adapted, and every adaptation must change something.

Each composed operation carries `x-profile`: `{status}` of `required`, `adapted`, `addition` or `extension`, with the reason and the overridden components it uses. Server-owned extensions are supplied separately. Unknown IDs or messages, an incomplete operation partition or conflicting extensions are errors, not silently ignored entries. Generating documentation does not establish conformance: the server separately checks route registrations, generated handler contracts and real HTTP responses.

Generated server documents and clients belong with the server implementation. This avoids a dependency cycle in which the canonical official contract depends on a particular server release.

### Plugin contracts

`composePlugin(official, base, plugin)` composes one plugin on `base`, a document returned by `composeProfile` (possibly with plugins already applied); `composePlugins(official, base, plugins)` applies several in order. `official` supplies the definitions of official operations the base excludes. A plugin (`plugins/<name>.json`, published as `@openscreeps/openapi/plugins/<name>`) declares:

- `name`, `description`, `package` (`{name, version}` of the mod release), `source` (its
  `sources.json` pin) and `base` (the profile it applies to).
- `provides`: official operation IDs the base excludes and the mod serves, with reasons.
- `adaptations`: base or provided operations whose contract the mod changes, with reasons;
  each must be changed by a path override or reach an overridden component.
- `additions`: non-official operation IDs with reasons; definitions in `overrides.paths`.
- `behaviour`: cross-cutting behaviour (`{summary, evidence}`), such as token rotation, CORS
  or the server-password bypass, recorded once instead of on every operation.
- `notes` and `evidence`: per-operation behaviour descriptions (prefixed with the plugin name)
  and citations; every provided, adapted and added operation needs evidence.
- `overrides`: RFC 7386 `paths` and `components` patches (each component override with
  `x-plugin-reason`), applied to the base document's operations and components.

Errors, like `composeProfile`'s: an unknown ID, a provided operation the base already serves (adapt it instead), an adaptation of an operation the base excludes and the plugin does not provide, a path override without an adaptation, a component override without `x-plugin-reason`, an operation reaching an overridden schema without an adaptation, an adaptation that changes nothing, an addition colliding with an official or base operation, missing evidence, a `base` that is not the document's profile, or applying the same plugin twice. Operations keep `x-profile` (`plugin` for operations the base does not serve) and gain `x-plugins: [{name, status, reason}]` with status `provided` (plus `adaptation` when also adapted), `adapted` or `addition`; `info.x-plugins` lists the applied plugins with their behaviour. Base transport rules are not applied to plugin operations: both mods register their routes before backend-local's server-password check. Components the base pruned are restored from the official contract for provided operations.

`screepsmod-auth` 2.10.1 provides password sign-in, registration, password changes, persistent API tokens (list, create, delete, query, rate-limit exemption), `GET /api/user/name`, Steam and GitHub sign-in and unlinking; adapts the availability checks (`User Exists`, exact match, `banned:`), sign-in, code upload (HTTP Basic, banned accounts) and the legacy `X-Username` header (no longer required); adds `GET /api/authmod`. Its documented defect: a wrong current password in `POST /api/user/password` overwrites the stored password and crashes the backend. Routes it serves that no contract describes: `POST /api/auth/query-token`, `GET /api/auth/steam/return`, `GET /api/auth/github/return`, `GET /api/auth/gitlab` and its return route, `POST /api/user/unlink-gitlab` and the static `/authmod/` pages.

`screepsmod-admin-utils` 1.37.1 provides room objects (no `ok`), shard info, PvP and nuke summaries; adapts the version reply (mod features, shard name), the start room and spawn placement (`auto` mode); adds `GET /api/mods`, `GET /stats` and `GET /api/warpath/battles`. `GET /` redirecting to its `/web` UI, CORS for configured origins and its socket channels are behaviour.

## Evidence and coverage

[Source revisions](sources.json), [coverage inventory](coverage.json), operation source citations and dated observations record where a contract came from. Official web application HTTP calls extend the discovery baseline beyond the community API library. Community private-server mods (screepsmod-auth, screepsmod-admin-utils) are pinned as evidence for their plugin contracts. Coverage exclusions may name an `origin` to apply to routes of one inventoried source only. Upstream JavaScript bundles are research inputs, not third-party code redistributed in this package.

The official backend is closed source. The catalog covers discovered and evidenced routes; it does not claim proof that no undiscovered production endpoint exists. Where a request or response field is not established by evidence, that uncertainty must remain explicit. Standalone implementation details are not proof of official behavior.

OpenAPI describes HTTP and AsyncAPI describes the socket protocol; the in-game JavaScript API is outside these contracts. A schema or an example never grants permission to mutate an account, purchase something or reset a world. Subscribing to socket channels is read-only, but a socket token grants full account access.

## Development and CI

Node 24 LTS is pinned through `mise.toml`. Dependencies are locked. TypeScript 5.9 is used for generation because the selected OpenAPI generator declares a TypeScript 5 peer dependency.

```sh
mise install
npm ci --ignore-scripts
npm run prepare
npm run check
npm run format:check
```

`check` verifies deterministic bundles, route coverage, schema validity, generated-file freshness, compiled client types and consumer-facing regressions. `npm test` runs the TypeScript tests directly with Node 24's native type stripping and the default per-file process isolation. `npm run typecheck` generates an isolated fixture client and checks the test harnesses against its real types, including expected compile-time misuse errors. Fixture sources are generated once per test process and copied to separate directories; determinism still compares independent generations, and runtime regressions still exercise real local HTTP servers. CI installs without running `prepare` first so regeneration cannot hide stale committed outputs. Upstream source inventory refresh is separate from offline artifact generation.

The separate **Check upstream source drift** workflow runs weekly or on manual dispatch.
It fetches the current official web assets and compares the source inventory without
overwriting its baseline (`node scripts/inventory.mjs --fetch --check`). Official web assets
are mutable; a deployment there must not make an unchanged, reproducible contract build fail.

Edit source contracts and profile decisions, regenerate, then commit source and generated output together. Do not hand-edit generated clients, handler interfaces or OpenAPI bundles. The server pins the contract revision independently and verifies its own generated outputs and conformance before upgrading.

### Read-only official smoke

```sh
npm run smoke
```

The smoke command runs the checked TypeScript harness (`node scripts/smoke.ts`) with Node 24's native type stripping and defaults to official Screeps. `SCREEPS_TOKEN` enables authenticated checks; `SCREEPS_API_URL`, `SCREEPS_SHARD`, and `SCREEPS_ROOM` select the trusted origin and room. Keep the token in an ignored `.env` file and run `node --env-file=.env scripts/smoke.ts`. It uses only read requests, rejects redirects and validates replies without printing or saving account data, bot Memory or credentials. The socket pass then opens `/socket/websocket` with `gzip on`, authenticates, subscribes to one room, its map view, map visuals and passive account channels, and requires every frame (compressed or not) to match a message of the socket contract; it prints message names only. Local server verification uses a disposable database and the generated standalone client, not an official account.

### Verified baseline

The official catalog contains **163 operations**, reconciled against 240 request sites
in the official web client and the pinned reference sources. The standalone profile
requires 85 official operations, explicitly excludes 78, and adds two private-server
compatibility routes; the server adds its own extension contracts. The community profile
requires 72, excludes 91 and adds three; with screepsmod-auth and screepsmod-admin-utils
the composed community server has 96 operations.

Verification includes 31 contract/client regressions, 15 real read-only official HTTP
responses, 12 kinds of real official socket messages (greeting, authentication,
compressed frames, room diffs, room map views, map visuals, CPU, console, Memory watch and
resources), authenticated calls through the generated client, and a packed-package
consumer that compiles and runs after its TypeScript source directory is removed.
Room objects are a `oneOf` union discriminated by `type` (`GameRoomObject` over HTTP,
`RoomObject` on the socket, kept structurally identical by `check`): one schema per object
type whose required fields are set by every upstream creator and present on every observed
object, `GameRoomObjectResource` for dropped resources (integer amounts under the resource
key) and `GameRoomObjectOther` for any other type. They were checked against 225,534 real
official room objects of 31 types from 2,429 non-empty rooms on five shards and 79 socket
first room events, with zero failures; the smoke validates every complete room object it
receives against the union and its own variant. Room and map visual strings are typed per
line as `RoomVisualItem` and `MapVisualItem` (examples produced by the upstream serializers).
The standalone server separately exercises all 92 composed operations over real HTTP.
The official socket contract holds 26 messages; the standalone socket profile composes 22.
The community server composed with both plugins was exercised against a running world
(screeps 4.3.0 with screepsmod-auth and screepsmod-admin-utils): 37 requests over 26 plugin
operations (registration, availability checks, sign-in by body and HTTP Basic, token
management, password change, code upload, spawn placement, version, room objects, shard,
PvP and nuke summaries and all four additions) matched the composed contract; the HTTP 401
sign-in failure arrives without `Content-Type`, as documented. Steam sign-in and the
wrong-password crash were not exercised.

## License

[ISC](LICENSE). Upstream source material retains its own license; research checkouts and raw authenticated responses are not distributed.
