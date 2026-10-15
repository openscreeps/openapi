# Screeps contracts and TypeScript clients

Canonical, evidence-backed **official Screeps HTTP and socket contracts**, an explicit **OpenScreeps standalone compatibility profile**, and generated **runnable TypeScript clients**. Community-maintained, not an official Screeps API guarantee.

## Ownership and direction

- This repository owns the official [OpenAPI JSON](openapi.json), [YAML](openapi.yaml), the official socket contract ([AsyncAPI JSON](asyncapi.json), [YAML](asyncapi.yaml)), source schemas, source inventory and [standalone profile](profiles/standalone.json).
- The official contract describes official wire behavior. It is not a union widened to accommodate OpenScreeps implementation differences.
- The profile partitions official operation IDs into required and excluded operations. Every exclusion has a reason. Necessary standalone adaptations have explicit reasons and precise schema overrides.
- [`openscreeps/server`](https://github.com/openscreeps/server) owns its extension contracts, including administrator and host endpoints. It combines the pinned official contract, compatibility profile and its extensions to generate its own OpenAPI document, TypeScript client and handler interfaces.
- Implementations must satisfy their contract. Generated types do not implement game behavior; server route checks and real HTTP conformance checks enforce the boundary.

Hosted account, commerce, seasonal and shard services outside the standalone profile remain documented in the official catalog, but are not advertised as callable methods in the standalone client. No Rust client generation is included.

## Socket contract

[`asyncapi.json`](asyncapi.json) (AsyncAPI 3.0, built from [`socket/`](socket)) describes the official socket protocol: the SockJS endpoint `/socket` and its raw WebSocket transport `/socket/websocket`, the greeting lines, `auth`/`subscribe`/`unsubscribe`/`gzip` commands, `gz:` compressed frames and every channel the official client subscribes to, with payload schemas for each `[channel, data]` event. Payload schemas are draft-07 AsyncAPI schemas; channel names are expressed as patterns of the first tuple item. `RoomObjectsDiff` documents how the official client applies incremental room updates: a new id carries a complete `RoomObject`, a held id a `RoomObjectPatch` (partial at every depth, `null` for removed properties, top-level arrays possibly keyed by index). Room objects are typed field by field after the upstream room object documents, in the socket contract and as `GameRoomObject` in the HTTP contract. The document is written from the server's perspective: `receive` operations are client commands.

The package exports it as `@openscreeps/openapi/socket`. Standalone servers name channels without a shard and differ in a few messages; compose their socket contract with `composeSocketProfile` rather than reading the official document.

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

## Standalone composition

`composeProfile(official, profile, extensions)` and `composeSocketProfile(officialSocket, profile)` are exported from `@openscreeps/openapi/contracts`. The standalone profile uses:

- `required`: official operation IDs the server must implement.
- `excluded`: official operation IDs mapped to exclusion reasons.
- `adaptations`: required operation IDs mapped to reasons for precise standalone differences.
- `overrides`: RFC 7386 merge patches for adapted operations and explicit component changes.
- `additions`: non-official compatibility operation IDs mapped to reasons; their operation
  definitions live in `overrides.paths`. These include private-server tick and history routes.
- `transport`: explicit standalone transport parameters, including the optional server password.
- `notes` and `evidence`: standalone-specific explanations and source citations.
- `socket`: the standalone socket contract: `info` and `servers`, `excluded` official messages
  with reasons, `adaptations` with reasons, `evidence`, and RFC 7386 `overrides` of `messages`
  and `schemas` (each schema override with `x-profile-reason`). Every message that uses an
  overridden schema must be adapted, and every adaptation must change something.

Server-owned extensions are supplied separately. Unknown IDs or messages, an incomplete operation partition or conflicting extensions are errors, not silently ignored entries. Generating documentation does not establish conformance: the server separately checks route registrations, generated handler contracts and real HTTP responses.

Generated server documents and clients belong with the server implementation. This avoids a dependency cycle in which the canonical official contract depends on a particular server release.

## Evidence and coverage

[Source revisions](sources.json), [coverage inventory](coverage.json), operation source citations and dated observations record where a contract came from. Official web application HTTP calls extend the discovery baseline beyond the community API library. Community private-server mods such as screepsmod-auth (password registration without reCAPTCHA or e-mail confirmation) are pinned as evidence for standalone adaptations only. Upstream JavaScript bundles are research inputs, not third-party code redistributed in this package.

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
compatibility routes; the server adds its own extension contracts.

Verification includes 27 contract/client regressions, 15 real read-only official HTTP
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

## License

[ISC](LICENSE). Upstream source material retains its own license; research checkouts and raw authenticated responses are not distributed.
