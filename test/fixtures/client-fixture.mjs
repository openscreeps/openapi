// OpenAPI 3.1 fixture exercising every feature the client generator supports, plus a helper that
// generates it into an ignored build directory importing clients/runtime.ts directly, so Node
// type stripping can execute the generated client and the TypeScript API can check it.
import { mkdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { generateClient } from '../../scripts/generate-clients.mjs';

export const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));

const json = (schema) => ({ 'application/json': { schema } });
const error = { description: 'Error', content: json({ $ref: '#/components/schemas/ApiError' }) };
const ok = { description: 'Ok', content: json({ $ref: '#/components/schemas/Ok' }) };

export const fixtureDocument = {
  openapi: '3.1.0',
  info: { title: 'Client fixture', version: '1.0.0' },
  servers: [
    {
      url: 'http://{host}:{port}',
      variables: { host: { default: 'localhost' }, port: { default: '21025' } },
    },
  ],
  components: {
    securitySchemes: {
      Token: { type: 'apiKey', in: 'header', name: 'X-Token' },
      Bearer: { type: 'http', scheme: 'bearer', 'x-openscreeps-refresh-header': 'X-Token' },
      AdminToken: { type: 'http', scheme: 'bearer' },
      QueryToken: { type: 'apiKey', in: 'query', name: 'token' },
      // Declared but unused schemes need no runtime support.
      Unused: {
        type: 'oauth2',
        flows: { clientCredentials: { tokenUrl: 'https://example.com/token', scopes: {} } },
      },
    },
    parameters: {
      ServerPassword: {
        name: 'X-Server-Password',
        in: 'header',
        required: false,
        schema: { type: 'string' },
      },
    },
    schemas: {
      ApiError: {
        type: 'object',
        properties: { error: { type: 'string' } },
        required: ['error'],
        additionalProperties: true,
      },
      Ok: { type: 'object', properties: { ok: { const: 1 } }, required: ['ok'] },
      Thing: {
        type: 'object',
        properties: { ok: { const: 1 }, name: { type: 'string' }, count: { type: 'integer' } },
        required: ['ok', 'name'],
        additionalProperties: false,
      },
    },
  },
  paths: {
    '/api/thing/{id}': {
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      get: {
        operationId: 'getThing',
        summary: 'Read a thing',
        security: [{ Token: [] }],
        parameters: [
          { name: 'limit', in: 'query', required: true, schema: { type: 'integer' } },
          { name: 'flag', in: 'query', schema: { type: 'boolean' } },
          { name: 'tags', in: 'query', schema: { type: 'array', items: { type: 'string' } } },
          {
            name: 'csv',
            in: 'query',
            explode: false,
            schema: { type: 'array', items: { type: 'string' } },
          },
          { $ref: '#/components/parameters/ServerPassword' },
        ],
        responses: {
          200: {
            description: 'Thing or logical error',
            content: json({
              anyOf: [
                { $ref: '#/components/schemas/Thing' },
                { $ref: '#/components/schemas/ApiError' },
              ],
            }),
          },
          401: error,
        },
      },
      delete: {
        operationId: 'deleteThing',
        security: [{ Token: [] }],
        responses: { 204: { description: 'Deleted' }, 404: error },
      },
    },
    '/api/thing': {
      post: {
        operationId: 'postThing',
        security: [{}, { Token: [] }],
        requestBody: {
          required: true,
          content: json({
            type: 'object',
            properties: { name: { type: 'string' }, count: { type: 'integer', default: 1 } },
            required: ['name'],
            additionalProperties: false,
          }),
        },
        responses: {
          200: { description: 'Created', content: json({ $ref: '#/components/schemas/Thing' }) },
        },
      },
    },
    '/api/text': {
      put: {
        operationId: 'putText',
        security: [{ Bearer: [] }],
        requestBody: { content: { 'text/plain': { schema: { type: 'string' } } } },
        responses: {
          200: { description: 'Echo', content: { 'text/plain': { schema: { type: 'string' } } } },
        },
      },
    },
    '/api/binary': {
      post: {
        operationId: 'uploadBinary',
        security: [{ AdminToken: [] }],
        requestBody: {
          required: true,
          content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } },
        },
        responses: {
          200: {
            description: 'Bytes',
            content: {
              'image/png': { schema: { type: 'string', format: 'binary' } },
              '*/*': { schema: { type: 'string', format: 'binary' } },
            },
          },
        },
      },
    },
    '/api/admin/run': {
      post: {
        operationId: 'adminRun',
        security: [{ AdminToken: [] }],
        requestBody: {
          required: true,
          content: json({ type: 'object', properties: { action: { type: 'string' } } }),
        },
        responses: { 200: ok },
      },
    },
    '/api/query-auth': {
      get: {
        operationId: 'queryAuth',
        security: [{ QueryToken: [] }],
        responses: { 200: ok, 500: error },
      },
    },
    '/api/badge': {
      get: {
        operationId: 'badge',
        security: [],
        responses: {
          200: { description: 'SVG', content: { 'image/svg+xml': { schema: { type: 'string' } } } },
        },
      },
    },
    '/api/redirect': {
      get: {
        operationId: 'redirect',
        security: [{ Token: [] }],
        responses: { 200: ok },
      },
    },
    '/assets/{path}': {
      get: {
        operationId: 'asset',
        security: [],
        parameters: [
          {
            name: 'path',
            in: 'path',
            required: true,
            'x-openscreeps-wildcard': true,
            schema: { type: 'string' },
          },
        ],
        responses: {
          200: {
            description: 'Asset',
            content: { '*/*': { schema: { type: 'string', format: 'binary' } } },
          },
          404: error,
        },
      },
    },
  },
};

/** Generate the fixture client into build/client-tests/<label>; returns its directory. */
export async function generateFixture(label, document = fixtureDocument) {
  const directory = resolve(root, 'build', 'client-tests', `${label}-${process.pid}`);
  await rm(directory, { recursive: true, force: true });
  await mkdir(directory, { recursive: true });
  await generateClient({
    document,
    output: directory,
    name: 'fixture',
    runtime: '../../../clients/runtime.ts',
  });
  return directory;
}

export async function importFixture(directory) {
  return import(pathToFileURL(resolve(directory, 'index.ts')).href);
}
