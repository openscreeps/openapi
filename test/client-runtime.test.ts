// Behavioural regressions for generated clients: the fixture client is generated, executed through
// Node type stripping and exercised over real HTTP against local node:http servers.
import assert from 'node:assert/strict';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import { rm } from 'node:fs/promises';
import { inspect } from 'node:util';
import { after, before, beforeEach, test } from 'node:test';
import { generateFixture, importFixture } from './fixtures/client-fixture.ts';
import type { FixtureApi } from './fixtures/client-fixture.ts';
import type { ClientOptions } from '../clients/runtime.ts';
import type { SecuritySchemeName } from '../build/client-tests/typecheck/index.ts';

interface SeenRequest {
  method: string | undefined;
  url: string | undefined;
  headers: IncomingHttpHeaders;
  body: Buffer;
}

interface Reply {
  status?: number;
  headers?: Record<string, string>;
  body?: unknown;
}

interface ListeningServer {
  server: Server;
  url: string;
}

type Respond = (request: SeenRequest) => Reply | Promise<Reply>;

let api: FixtureApi;
let directory: string;
let base: ListeningServer;
let elsewhere: ListeningServer;
const hits: SeenRequest[] = [];
const elsewhereHits: SeenRequest[] = [];
let reply: Respond;

function listen(record: SeenRequest[], respond: Respond): Promise<ListeningServer> {
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      assert.ok(Buffer.isBuffer(chunk));
      chunks.push(chunk);
    }
    const seen = {
      method: request.method,
      url: request.url,
      headers: request.headers,
      body: Buffer.concat(chunks),
    };
    record.push(seen);
    const { status = 200, headers = {}, body } = await respond(seen);
    const encoded =
      body === undefined || typeof body === 'string' || body instanceof Uint8Array
        ? body
        : JSON.stringify(body);
    const type =
      body !== undefined && typeof body === 'object' && !(body instanceof Uint8Array)
        ? { 'content-type': 'application/json' }
        : {};
    response.writeHead(status, { ...type, ...headers });
    response.end(encoded);
  });
  const { promise, resolve } = Promise.withResolvers<ListeningServer>();
  server.listen(0, '127.0.0.1', () => {
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    resolve({ server, url: `http://127.0.0.1:${address.port}` });
  });
  return promise;
}

before(async () => {
  directory = await generateFixture('runtime');
  api = await importFixture(directory);
  base = await listen(hits, (request) => reply(request));
  elsewhere = await listen(elsewhereHits, () => ({ body: { ok: 1 } }));
});

after(async () => {
  base.server.close();
  elsewhere.server.close();
  await rm(directory, { recursive: true, force: true });
});

beforeEach(() => {
  hits.length = 0;
  elsewhereHits.length = 0;
  reply = () => ({ body: { ok: 1, name: 'thing' } });
});

const client = (options: Omit<ClientOptions<SecuritySchemeName>, 'baseUrl'> = {}) =>
  new api.Client({ baseUrl: `${base.url}/season/`, ...options });

test('preserves the base path and serialises path, query and header parameters', async () => {
  const result = await client({ credentials: { Token: 'player' } }).getThing({
    path: { id: 'a b/c?#%' },
    query: { limit: 0, flag: false, tags: ['x', 'y z'], csv: ['p', 'q'] },
    headers: { 'X-Server-Password': 'pw' },
  });
  assert.deepEqual(result, { ok: 1, name: 'thing' });
  assert.equal(hits.length, 1);
  const [request] = hits;
  assert.ok(request);
  assert.equal(request.method, 'GET');
  assert.equal(
    request.url,
    '/season/api/thing/a%20b%2Fc%3F%23%25?limit=0&flag=false&tags=x&tags=y+z&csv=p%2Cq',
  );
  assert.equal(request.headers['x-server-password'], 'pw');
  assert.equal(request.headers['x-token'], 'player');
  assert.equal(request.headers.authorization, undefined);
  assert.equal(request.headers.accept, 'application/json');
});

test('wildcard asset paths keep separators while escaping each segment', async () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
  reply = () => ({ headers: { 'content-type': 'image/png' }, body: png });
  const bytes = await client().asset({ path: { path: 'map/zoom 2/W0N0.png' } });
  assert.ok(hits[0]);
  assert.equal(hits[0].url, '/season/assets/map/zoom%202/W0N0.png');
  assert.ok(bytes instanceof Uint8Array);
  assert.deepEqual([...bytes], [...png]);
});

test('dot and empty path segments are rejected before any request', async () => {
  const c = client({ credentials: { Token: 'player' } });
  for (const id of ['.', '..', '']) {
    await assert.rejects(c.getThing({ path: { id }, query: { limit: 1 } }), TypeError);
  }
  for (const path of ['map/../secret', 'a//b', '/absolute', 'trailing/', '.']) {
    await assert.rejects(c.asset({ path: { path } }), TypeError);
  }
  assert.equal(hits.length, 0);
});

test('missing required parameters and bodies are rejected before any request', async () => {
  const c = client({ credentials: { Token: 'player' } });
  // @ts-expect-error intentionally missing the required query group
  await assert.rejects(c.getThing({ path: { id: 'x' } }), /missing required query parameter limit/);
  // @ts-expect-error intentionally missing the required path group
  await assert.rejects(c.getThing({ query: { limit: 1 } }), /missing required path parameter id/);
  // @ts-expect-error intentionally missing the required body
  await assert.rejects(c.postThing({}), /missing required request body/);
  assert.equal(hits.length, 0);
});

test('credentials are sent only to operations declaring their scheme', async () => {
  const c = client({ credentials: { Token: 'player', Bearer: 'bearer', AdminToken: 'admin' } });
  await c.getThing({ path: { id: 'x' }, query: { limit: 1 } });
  await c.adminRun({ body: { action: 'tick' } });
  reply = () => ({ headers: { 'content-type': 'text/plain' }, body: 'ok' });
  await c.putText();
  reply = () => ({ headers: { 'content-type': 'image/png' }, body: new Uint8Array([1]) });
  await c.asset({ path: { path: 'map/W1N1.png' } });
  await c.postThing({ body: { name: 'n' } }).catch(() => undefined);
  const auth = hits.map(({ headers }) => [headers['x-token'], headers.authorization]);
  assert.deepEqual(auth, [
    ['player', undefined],
    [undefined, 'Bearer admin'],
    [undefined, 'Bearer bearer'],
    [undefined, undefined],
    ['player', undefined],
  ]);

  const player = client({ credentials: { Token: 'player' } });
  await assert.rejects(player.adminRun({ body: {} }), api.ApiCredentialError);
  const anonymous = client().getThing({ path: { id: 'x' }, query: { limit: 1 } });
  await assert.rejects(anonymous, api.ApiCredentialError);
  assert.equal(hits.length, 5);
});

test('rotated tokens replace only the credential that was sent', async () => {
  const refreshed: [SecuritySchemeName, string][] = [];
  const c = client({
    credentials: { Token: 'player', Bearer: 'bearer', AdminToken: 'admin' },
    onCredentialRefresh: (scheme, value) => refreshed.push([scheme, value]),
  });
  reply = () => ({ headers: { 'x-token': 'player-2' }, body: { ok: 1, name: 'x' } });
  await c.getThing({ path: { id: 'x' }, query: { limit: 1 } });
  await c.getThing({ path: { id: 'x' }, query: { limit: 1 } });
  assert.ok(hits[1]);
  assert.equal(hits[1].headers['x-token'], 'player-2');
  assert.equal(c.getCredential('Token'), 'player-2');

  reply = () => ({ headers: { 'x-token': 'bearer-2', 'content-type': 'text/plain' }, body: '' });
  await c.putText();
  assert.equal(c.getCredential('Bearer'), 'bearer-2');

  reply = () => ({ headers: { 'x-token': 'stolen' }, body: { ok: 1 } });
  await c.adminRun({ body: {} });
  assert.equal(c.getCredential('AdminToken'), 'admin');
  assert.equal(c.getCredential('Token'), 'player-2');
  assert.deepEqual(refreshed, [
    ['Token', 'player-2'],
    ['Bearer', 'bearer-2'],
  ]);
});

test('HTTP 200 error envelopes reject call() while send() exposes the envelope', async () => {
  const c = client({ credentials: { Token: 'player' } });
  reply = () => ({ body: { error: 'not found' } });
  const input = { path: { id: 'x' }, query: { limit: 1 } };
  await assert.rejects(c.getThing(input), (error: unknown) => {
    assert.ok(error instanceof api.ApiEnvelopeError);
    assert.equal(error.status, 200);
    assert.deepEqual(error.body, { error: 'not found' });
    return true;
  });
  const raw = await c.send('getThing', input);
  assert.equal(raw.declared, true);
  assert.equal(raw.status, 200);
  assert.deepEqual(raw.body, { error: 'not found' });
  assert.equal(hits.length, 2);
});

test('failed statuses are reported once and never retried', async () => {
  const c = client({ credentials: { Token: 'player' } });
  for (const status of [500, 502, 503, 429]) {
    hits.length = 0;
    reply = () => ({ status, headers: { 'retry-after': '1' }, body: { error: 'unavailable' } });
    await assert.rejects(c.postThing({ body: { name: 'n' } }), (error: unknown) => {
      assert.ok(error instanceof api.ApiHttpError);
      assert.equal(error.status, status);
      assert.deepEqual(error.body, { error: 'unavailable' });
      return true;
    });
    assert.equal(hits.length, 1, `HTTP ${status} must not be retried`);
  }
  reply = () => ({ status: 418, body: { error: 'teapot' } });
  const raw = await c.send('getThing', { path: { id: 'x' }, query: { limit: 1 } });
  assert.equal(raw.declared, false);
  assert.equal(raw.status, 418);
});

test('redirects are never followed, cross-origin or same-origin', async () => {
  const c = client({ credentials: { Token: 'player' } });
  reply = () => ({ status: 302, headers: { location: `${elsewhere.url}/steal` } });
  await assert.rejects(c.getThing({ path: { id: 'x' }, query: { limit: 1 } }), (error: unknown) => {
    assert.ok(error instanceof api.ApiRedirectError);
    assert.equal(error.status, 302);
    assert.equal(error.location, `${elsewhere.url}/steal`);
    return true;
  });
  reply = () => ({ status: 307, headers: { location: '/season/api/thing' } });
  await assert.rejects(c.postThing({ body: { name: 'n' } }), api.ApiRedirectError);
  assert.equal(hits.length, 2);
  assert.equal(elsewhereHits.length, 0);
});

test('query-string credentials never appear in thrown errors', async () => {
  const secret = 'sekret-query-token';
  const c = client({ credentials: { QueryToken: secret } });
  const leaks = (error: Error) =>
    [String(error), error.stack, JSON.stringify(error), inspect(error, { depth: 10 })].some(
      (text) => text?.includes(secret),
    );

  reply = () => ({ status: 500, body: { error: 'boom' } });
  const failure: unknown = await c.queryAuth().catch((error: unknown) => error);
  assert.ok(failure instanceof api.ApiHttpError);
  assert.ok(hits[0]);
  assert.equal(hits[0].url, `/season/api/query-auth?token=${secret}`);
  assert.equal(leaks(failure), false);

  reply = () => ({ status: 301, headers: { location: `${elsewhere.url}/` } });
  const redirect: unknown = await c.queryAuth().catch((error: unknown) => error);
  assert.ok(redirect instanceof api.ApiRedirectError);
  assert.equal(leaks(redirect), false);

  reply = () => ({ headers: { 'content-type': 'application/json' }, body: '{bad' });
  const parse: unknown = await c.queryAuth().catch((error: unknown) => error);
  assert.ok(parse instanceof api.ApiResponseError);
  assert.equal(leaks(parse), false);

  const closed = await listen([], () => ({}));
  closed.server.close();
  const offline = new api.Client({ baseUrl: closed.url, credentials: { QueryToken: secret } });
  const network: unknown = await offline.queryAuth().catch((error: unknown) => error);
  assert.ok(network instanceof Error);
  assert.equal(leaks(network), false);
});

test('base URLs must be plain http(s) URLs', () => {
  for (const baseUrl of [
    'ftp://example.com',
    'https://example.com/?q=1',
    'https://user:pass@example.com',
    'https://example.com/#x',
    'not a url',
  ]) {
    assert.throws(() => new api.Client({ baseUrl }), TypeError, baseUrl);
  }
});
