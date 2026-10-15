// Type regressions for generated clients. test/client-generator.test.ts copies this file next to
// the generated fixture client and type-checks it; every @ts-expect-error must still fire.
import {
  Client,
  operations,
  type GetThingResult,
  type GetThingSuccess,
  type OperationHandlers,
  type Schemas,
  type SecuritySchemeName,
  type SuccessBody,
} from './index.js';

declare const client: Client;

export const schemes: SecuritySchemeName[] = ['Token', 'Bearer', 'AdminToken', 'QueryToken'];
// @ts-expect-error unsupported schemes never become credentials
export const unsupported: SecuritySchemeName = 'Unused';

export const configured = new Client({
  baseUrl: 'https://example.com/season',
  credentials: { Token: 'player', AdminToken: 'admin' },
  onCredentialRefresh: (scheme: SecuritySchemeName, value: string) => void [scheme, value],
});
// @ts-expect-error unknown security scheme
export const unknownScheme = new Client({ baseUrl: 'https://x.test', credentials: { Nope: 'x' } });

export async function requests(): Promise<void> {
  const thing: GetThingSuccess = await client.getThing({
    path: { id: 'W1N1' },
    query: { limit: 0, flag: false, tags: ['a'], csv: ['b'] },
    headers: { 'X-Server-Password': 'secret' },
  });
  thing.name satisfies string;
  thing.ok satisfies 1;
  // @ts-expect-error the HTTP 200 error envelope is excluded from success bodies
  void thing.error;

  // @ts-expect-error path group is required
  await client.getThing({ query: { limit: 1 } });
  // @ts-expect-error query group is required because limit is required
  await client.getThing({ path: { id: 'x' } });
  // @ts-expect-error limit is an integer
  await client.getThing({ path: { id: 'x' }, query: { limit: '1' } });
  // @ts-expect-error undeclared query parameter
  await client.getThing({ path: { id: 'x' }, query: { limit: 1, nope: 1 } });
  // @ts-expect-error operation declares no request body
  await client.getThing({ path: { id: 'x' }, query: { limit: 1 }, body: {} });

  const created: SuccessBody<'postThing'> = await client.postThing({ body: { name: 'n' } });
  created.name satisfies string;
  // @ts-expect-error required request body
  await client.postThing();
  // @ts-expect-error name is required in the body
  await client.postThing({ body: { count: 2 } });

  const text: string = await client.putText({ body: 'plain' });
  await client.putText();
  // @ts-expect-error text bodies are strings
  await client.putText({ body: 1 });

  const bytes: Uint8Array = await client.uploadBinary({ body: new Uint8Array([1]) });
  await client.uploadBinary({ body: new Blob(['x']) });
  // @ts-expect-error binary bodies are bytes, not strings
  await client.uploadBinary({ body: 'bytes' });

  const asset: Uint8Array = await client.asset({ path: { path: 'map/W1N1.png' } });
  // @ts-expect-error binary responses decode to Uint8Array
  const assetText: string = await client.asset({ path: { path: 'map/W1N1.png' } });
  const svg: string = await client.badge();
  const deleted: undefined = await client.deleteThing({ path: { id: 'x' } });
  const ok: Schemas['Ok'] = await client.queryAuth();
  void [text, bytes, asset, assetText, svg, deleted, ok];

  const raw = await client.send('getThing', { path: { id: 'x' }, query: { limit: 1 } });
  if (raw.declared && raw.status === 401) raw.body.error satisfies string;
  raw.headers satisfies Headers;
  // @ts-expect-error unknown operationId
  await client.send('missing', {});
}

export const manifestMethod: 'GET' = operations.getThing.method;
export const wildcard: true = operations.asset.parameters[0].wildcard;

interface Context {
  user: string;
}
export const handlers: Pick<OperationHandlers<Context>, 'getThing' | 'postThing' | 'asset'> = {
  getThing(request, context) {
    request.path.id satisfies string;
    request.query.limit satisfies number;
    context.user satisfies string;
    return { error: 'logical failure' } satisfies GetThingResult;
  },
  async postThing(request) {
    return { ok: 1, name: request.body.name };
  },
  asset: () => new Uint8Array(),
};
export const wrongHandler: Pick<OperationHandlers, 'postThing'> = {
  // @ts-expect-error handlers must return a declared body
  postThing: () => ({ ok: 1, name: 2 }),
};
