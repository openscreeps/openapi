// Generate a typed native-fetch client, handler contracts and an operation manifest from an
// OpenAPI 3.1 document. Output is TypeScript source importing the maintained clients/runtime.ts.
//
//   node scripts/generate-clients.mjs [--input openapi.json] [--output clients/generated/official]
//     [--name official] [--runtime IMPORT_SPECIFIER] [--check]
//
// Deliberately narrow: unsupported OpenAPI features fail generation instead of being guessed.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import openapiTS, { astToString } from 'openapi-typescript';
import YAML from 'yaml';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const methods = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'];
/** OpenAPI ignores these header parameters; the runtime owns them. */
const reservedHeaders = new Set(['accept', 'content-type', 'authorization']);
/** Members of the runtime OpenApiClient that generated operation methods must not shadow. */
const clientMembers = new Set(['call', 'send', 'setCredential', 'getCredential', 'constructor']);
/** Request body media type preference when an operation accepts several. */
const requestKindOrder = ['json', 'form', 'multipart', 'text', 'binary'];
const runtimeExports = [
  'ApiCredentialError',
  'ApiEnvelopeError',
  'ApiHttpError',
  'ApiRedirectError',
  'ApiResponseError',
  'OpenApiClientError',
  'isErrorEnvelope',
];
const runtimeTypeExports = [
  'BinaryBody',
  'ClientOptions',
  'ErrorEnvelope',
  'FetchLike',
  'RequestOptions',
  'SendResult',
];

/** Decoding kind shared with clients/runtime.ts kindOfMediaType. */
function mediaKind(mediaType) {
  const type = mediaType.toLowerCase();
  if (type === 'application/json' || /^application\/[^;]*\+json$/.test(type)) return 'json';
  if (type.startsWith('text/') || type === 'application/xml' || type.endsWith('+xml')) {
    return 'text';
  }
  return 'binary';
}

function requestKind(mediaType) {
  const type = mediaType.toLowerCase();
  if (type === 'application/x-www-form-urlencoded') return 'form';
  if (type === 'multipart/form-data') return 'multipart';
  return mediaKind(type);
}

const literal = (value) => JSON.stringify(value);
const pascal = (id) => id.charAt(0).toUpperCase() + id.slice(1);

function doc(lines, indent) {
  const text = lines
    .filter(Boolean)
    .join('\n\n')
    .replaceAll('*/', '*\\/')
    .split('\n')
    .map((line) => `${indent} *${line ? ` ${line}` : ''}`);
  return text.length ? `${indent}/**\n${text.join('\n')}\n${indent} */\n` : '';
}

function resolveRef(document, value, where) {
  const seen = new Set();
  let current = value;
  while (current && typeof current === 'object' && typeof current.$ref === 'string') {
    const ref = current.$ref;
    if (!ref.startsWith('#/')) throw new Error(`${where}: external $ref ${ref} is unsupported`);
    if (seen.has(ref)) throw new Error(`${where}: circular $ref ${ref}`);
    seen.add(ref);
    current = ref
      .slice(2)
      .split('/')
      .map((part) => part.replaceAll('~1', '/').replaceAll('~0', '~'))
      .reduce((node, key) => (node && Object.hasOwn(node, key) ? node[key] : undefined), document);
    if (current === undefined) throw new Error(`${where}: unresolved $ref ${ref}`);
  }
  return current;
}

function describeSchemes(document) {
  const schemes = {};
  for (const [name, raw] of Object.entries(document.components?.securitySchemes ?? {})) {
    const scheme = resolveRef(document, raw, `securityScheme ${name}`);
    const refreshHeader = scheme['x-openscreeps-refresh-header'];
    if (refreshHeader !== undefined && typeof refreshHeader !== 'string') {
      throw new Error(`securityScheme ${name}: x-openscreeps-refresh-header must be a string`);
    }
    let descriptor;
    if (scheme.type === 'apiKey' && (scheme.in === 'header' || scheme.in === 'query')) {
      descriptor = { type: 'apiKey', in: scheme.in, name: scheme.name };
    } else if (scheme.type === 'http' && String(scheme.scheme).toLowerCase() === 'bearer') {
      descriptor = { type: 'bearer' };
    } else {
      descriptor = undefined; // Rejected below only if an operation requires it.
    }
    if (descriptor && refreshHeader) descriptor.refreshHeader = refreshHeader;
    schemes[name] = descriptor;
  }
  return schemes;
}

function describeParameters(document, pathItem, operation, where) {
  const merged = new Map();
  for (const raw of [...(pathItem.parameters ?? []), ...(operation.parameters ?? [])]) {
    const parameter = resolveRef(document, raw, where);
    merged.set(`${parameter.in}:${parameter.name}`, parameter);
  }
  const parameters = [];
  for (const parameter of merged.values()) {
    const label = `${where}: ${parameter.in} parameter ${parameter.name}`;
    if (!['path', 'query', 'header'].includes(parameter.in)) {
      throw new Error(`${label}: only path, query and header parameters are supported`);
    }
    if (parameter.content) throw new Error(`${label}: content-encoded parameters are unsupported`);
    if (parameter.in === 'header' && reservedHeaders.has(parameter.name.toLowerCase())) {
      throw new Error(`${label}: reserved header must not be declared as a parameter`);
    }
    const style = parameter.style ?? (parameter.in === 'query' ? 'form' : 'simple');
    if (style !== (parameter.in === 'query' ? 'form' : 'simple')) {
      throw new Error(`${label}: style ${style} is unsupported`);
    }
    const wildcard = parameter['x-openscreeps-wildcard'] === true;
    if (wildcard && parameter.in !== 'path') {
      throw new Error(`${label}: x-openscreeps-wildcard applies to path parameters only`);
    }
    if (parameter.in === 'path' && parameter.required !== true) {
      throw new Error(`${label}: path parameters must be required`);
    }
    parameters.push({
      name: parameter.name,
      in: parameter.in,
      required: parameter.required === true,
      wildcard,
      explode: parameter.explode ?? style === 'form',
    });
  }
  return parameters;
}

function describeOperations(document, schemes) {
  const operations = [];
  const ids = new Set();
  for (const [path, rawItem] of Object.entries(document.paths ?? {})) {
    const pathItem = resolveRef(document, rawItem, path);
    for (const method of methods) {
      const operation = pathItem[method];
      if (!operation) continue;
      const where = `${method.toUpperCase()} ${path}`;
      const id = operation.operationId;
      if (typeof id !== 'string' || !/^[A-Za-z_$][\w$]*$/.test(id)) {
        throw new Error(`${where}: operationId must be a JavaScript identifier`);
      }
      if (ids.has(id)) throw new Error(`${where}: duplicate operationId ${id}`);
      if (clientMembers.has(id)) throw new Error(`${where}: operationId ${id} is reserved`);
      ids.add(id);
      if (operation.servers || pathItem.servers) {
        throw new Error(`${where}: path or operation servers are unsupported`);
      }

      const parameters = describeParameters(document, pathItem, operation, where);
      const placeholders = [...path.matchAll(/\{([^}]+)\}/g)].map((match) => match[1]);
      const pathNames = parameters.filter((p) => p.in === 'path').map((p) => p.name);
      for (const name of new Set([...placeholders, ...pathNames])) {
        if (!placeholders.includes(name) || !pathNames.includes(name)) {
          throw new Error(`${where}: path parameter ${name} must be both templated and declared`);
        }
      }

      let requestBody;
      if (operation.requestBody) {
        const body = resolveRef(document, operation.requestBody, where);
        const candidates = Object.keys(body.content ?? {}).map((contentType) => ({
          contentType,
          kind: requestKind(contentType),
        }));
        if (candidates.some(({ contentType }) => contentType.includes('*'))) {
          throw new Error(`${where}: request media type ranges are unsupported`);
        }
        const rank = ({ kind }) => requestKindOrder.indexOf(kind);
        candidates.sort((a, b) => rank(a) - rank(b));
        if (!candidates[0]) throw new Error(`${where}: request body declares no content`);
        requestBody = { required: body.required === true, ...candidates[0] };
      }

      const responses = {};
      for (const [status, raw] of Object.entries(operation.responses ?? {})) {
        if (!/^([1-5]\d\d|[1-5]XX|default)$/.test(status)) {
          throw new Error(`${where}: invalid response status ${status}`);
        }
        const response = resolveRef(document, raw, `${where} ${status}`);
        responses[status] = Object.fromEntries(
          Object.keys(response.content ?? {}).map((type) => [type, mediaKind(type)]),
        );
      }

      const security = (operation.security ?? document.security ?? []).map((requirement) => {
        const names = Object.keys(requirement);
        for (const name of names) {
          if (!Object.hasOwn(schemes, name)) {
            throw new Error(`${where}: unknown security scheme ${name}`);
          }
          if (!schemes[name]) throw new Error(`${where}: security scheme ${name} is unsupported`);
        }
        return names;
      });

      operations.push({
        descriptor: {
          operationId: id,
          method: method.toUpperCase(),
          path,
          parameters,
          ...(requestBody ? { requestBody } : {}),
          responses,
          security,
        },
        summary: operation.summary,
        description: operation.description,
        deprecated: operation.deprecated === true,
      });
    }
  }
  if (!operations.length) throw new Error('document declares no operations');
  return operations;
}

/** Types of the decoded response body for one status of one operation. */
function responseBodyTypes(id, status, content) {
  const entries = Object.entries(content);
  if (!entries.length) return ['undefined'];
  const key = /^\d+$/.test(status) ? status : literal(status);
  const types = entries.map(([type, kind]) => {
    if (kind === 'text') return 'string';
    if (kind === 'binary') return 'Uint8Array';
    const response = `SchemaOperations[${literal(id)}]['responses'][${key}]`;
    return `${response}['content'][${literal(type)}]`;
  });
  return [...new Set(types)];
}

function requestBodyType(id, requestBody) {
  switch (requestBody.kind) {
    case 'text':
      return 'string';
    case 'binary':
      return 'BinaryBody';
    case 'multipart':
      return 'FormData';
    default: {
      const body = `NonNullable<SchemaOperations[${literal(id)}]['requestBody']>`;
      return `${body}['content'][${literal(requestBody.contentType)}]`;
    }
  }
}

function union(types, indent) {
  if (!types.length) return 'never';
  if (types.length === 1) return types[0];
  return types.map((type) => `\n${indent}| ${type}`).join('');
}

function renderOperationTypes({ descriptor, summary, deprecated }) {
  const id = descriptor.operationId;
  const name = pascal(id);
  const groups = [
    ['path', 'path'],
    ['query', 'query'],
    ['headers', 'header'],
  ].map(([key, openapiKey]) => {
    const members = descriptor.parameters.filter((p) => p.in === openapiKey);
    if (!members.length) return `  ${key}?: never;`;
    const optional = members.some((p) => p.required) ? '' : '?';
    const type = `SchemaOperations[${literal(id)}]['parameters'][${literal(openapiKey)}]`;
    return `  ${key}${optional}: NonNullable<${type}>;`;
  });
  const body = descriptor.requestBody;
  groups.push(
    body ? `  body${body.required ? '' : '?'}: ${requestBodyType(id, body)};` : '  body?: never;',
  );

  const variants = [];
  const results = [];
  const statuses = Object.keys(descriptor.responses);
  const successStatuses = statuses.filter((status) => status.startsWith('2'));
  for (const status of statuses) {
    const bodyTypes = responseBodyTypes(id, status, descriptor.responses[status]);
    const statusType = /^\d+$/.test(status) ? status : 'number';
    variants.push(`{ status: ${statusType}; contentType: string; body: ${bodyTypes.join(' | ')} }`);
    const success = successStatuses.length ? status.startsWith('2') : status === 'default';
    if (success) results.push(...bodyTypes);
  }
  const resultTypes = [...new Set(results)];

  return (
    doc([summary, deprecated ? '@deprecated' : ''], '') +
    `export interface ${name}Request {\n${groups.join('\n')}\n}\n` +
    `export type ${name}Responses = ${union(variants, '  ')};\n` +
    `export type ${name}Result = ${union(resultTypes, '  ')};\n` +
    `export type ${name}Success = Exclude<${name}Result, ErrorEnvelope>;\n`
  );
}

function renderIndex(document, name, runtime, operations, schemes) {
  const exported = new Set([
    'apiName',
    'servers',
    'SecuritySchemeName',
    'securitySchemes',
    'Operations',
    'OperationId',
    'RequestOf',
    'ResultOf',
    'SuccessBody',
    'operations',
    'operationIds',
    'OperationHandlers',
    'Client',
    'createClient',
    'Schemas',
    'components',
    'paths',
    'SchemaOperations',
    ...runtimeExports,
    ...runtimeTypeExports,
  ]);
  for (const { descriptor } of operations) {
    for (const suffix of ['Request', 'Responses', 'Result', 'Success']) {
      const typeName = pascal(descriptor.operationId) + suffix;
      if (exported.has(typeName)) {
        throw new Error(`operationId ${descriptor.operationId} conflicts on ${typeName}`);
      }
      exported.add(typeName);
    }
  }

  const supportedSchemes = Object.entries(schemes).filter(([, descriptor]) => descriptor);
  const runtimeTypes = [
    ...(operations.some(({ descriptor }) => descriptor.requestBody?.kind === 'binary')
      ? ['BinaryBody']
      : []),
    'ClientOptions',
    'ErrorEnvelope',
    'OperationDescriptor',
    'RequestOptions',
    'SecuritySchemeDescriptor',
  ];
  const servers = (document.servers ?? []).map((server) => ({
    url: server.url,
    ...(server.description ? { description: server.description } : {}),
    ...(server.variables
      ? {
          variables: Object.fromEntries(
            Object.entries(server.variables).map(([key, variable]) => [
              key,
              { default: variable.default, ...(variable.enum ? { enum: variable.enum } : {}) },
            ]),
          ),
        }
      : {}),
  }));

  const manifest = operations
    .map(({ descriptor }) => {
      const json = JSON.stringify(descriptor, null, 2).replaceAll('\n', '\n  ');
      return `  ${descriptor.operationId}: ${json},`;
    })
    .join('\n');
  const operationTypes = operations
    .map(({ descriptor }) => {
      const typeName = pascal(descriptor.operationId);
      return (
        `  ${descriptor.operationId}: {\n` +
        `    method: ${literal(descriptor.method.toLowerCase())};\n` +
        `    path: ${literal(descriptor.path)};\n` +
        `    request: ${typeName}Request;\n` +
        `    responses: ${typeName}Responses;\n` +
        `    result: ${typeName}Result;\n` +
        `    success: ${typeName}Success;\n` +
        `  };`
      );
    })
    .join('\n');
  const handlers = operations
    .map(({ descriptor, summary, deprecated }) => {
      const typeName = pascal(descriptor.operationId);
      return (
        doc([summary, deprecated ? '@deprecated' : ''], '  ') +
        `  ${descriptor.operationId}(request: ${typeName}Request, context: Context): ` +
        `${typeName}Result | Promise<${typeName}Result>;`
      );
    })
    .join('\n');
  const clientMethods = operations
    .map(({ descriptor, summary, description, deprecated }) => {
      const typeName = pascal(descriptor.operationId);
      const required =
        descriptor.parameters.some((p) => p.required) || descriptor.requestBody?.required;
      const input = required ? `input: ${typeName}Request` : `input: ${typeName}Request = {}`;
      return (
        doc(
          [
            summary,
            description,
            `\`${descriptor.method} ${descriptor.path}\``,
            deprecated ? '@deprecated' : '',
          ],
          '  ',
        ) +
        `  ${descriptor.operationId}(${input}, init?: RequestOptions)` +
        `: Promise<${typeName}Success> {\n` +
        `    return this.call(${literal(descriptor.operationId)}, input, init);\n` +
        `  }`
      );
    })
    .join('\n\n');

  const info = document.info ?? {};
  const title = `${info.title ?? 'OpenAPI document'} ${info.version ?? ''}`.trim();
  return `// Generated by scripts/generate-clients.mjs (${name}) from ${title}. Do not edit.
import {
  OpenApiClient,
${runtimeTypes.map((type) => `  type ${type},`).join('\n')}
} from ${literal(runtime)};
import type { components, operations as SchemaOperations } from './schema.js';

export type { components, paths, operations as SchemaOperations } from './schema.js';
export {
${runtimeExports.map((value) => `  ${value},`).join('\n')}
${runtimeTypeExports.map((type) => `  type ${type},`).join('\n')}
} from ${literal(runtime)};

export const apiName = ${literal(name)};
export const servers = ${JSON.stringify(servers, null, 2)} as const;
export type Schemas = components['schemas'];

export type SecuritySchemeName = ${supportedSchemes.map(([scheme]) => literal(scheme)).join(' | ') || 'never'};
export const securitySchemes = ${JSON.stringify(Object.fromEntries(supportedSchemes), null, 2)} as const satisfies {
  readonly [S in SecuritySchemeName]: SecuritySchemeDescriptor;
};

${operations.map(renderOperationTypes).join('\n')}
/** Type-level contract of every operation, keyed by operationId. */
export interface Operations {
${operationTypes}
}
export type OperationId = keyof Operations;
export type RequestOf<K extends OperationId> = Operations[K]['request'];
/** Raw 2xx body, including any declared HTTP 200 error envelope alternative. */
export type ResultOf<K extends OperationId> = Operations[K]['result'];
/** 2xx body with error envelopes excluded. */
export type SuccessBody<K extends OperationId> = Operations[K]['success'];

/** Runtime operation manifest. */
export const operations = {
${manifest}
} as const satisfies { readonly [K in OperationId]: OperationDescriptor };
export const operationIds = Object.keys(operations) as OperationId[];

/**
 * Server-side contract: one handler per operation receiving the decoded request. Handlers return
 * the raw 2xx body (an error envelope where the operation declares one) and throw otherwise.
 */
export interface OperationHandlers<Context = void> {
${handlers}
}

/** Native-fetch client with one method per operationId. */
export class Client extends OpenApiClient<Operations, SecuritySchemeName> {
  constructor(options: ClientOptions<SecuritySchemeName>) {
    super(operations, securitySchemes, options);
  }

${clientMethods}
}

export function createClient(options: ClientOptions<SecuritySchemeName>): Client {
  return new Client(options);
}
`;
}

/**
 * Generate client sources for an OpenAPI 3.1 document without touching the file system.
 * Returns file contents keyed by path relative to the output directory.
 */
export async function generateClientFiles({ document, name, runtime }) {
  if (!document || typeof document !== 'object') throw new Error('document must be an object');
  if (!/^3\.1\.\d+$/.test(String(document.openapi))) {
    throw new Error(`OpenAPI 3.1 required, got ${document.openapi}`);
  }
  if (typeof name !== 'string' || !/^[a-z][a-z0-9-]*$/.test(name)) {
    throw new Error('name must match /^[a-z][a-z0-9-]*$/');
  }
  if (typeof runtime !== 'string' || !runtime) {
    throw new Error('runtime import specifier required');
  }
  const schemes = describeSchemes(document);
  const operations = describeOperations(document, schemes);
  const ast = await openapiTS(structuredClone(document), {
    silent: true,
    defaultNonNullable: false,
    cwd: pathToFileURL(`${process.cwd()}${sep}`),
  });
  return {
    'schema.ts':
      `// Generated by scripts/generate-clients.mjs (${name}) with openapi-typescript. Do not edit.\n` +
      astToString(ast),
    'index.ts': renderIndex(document, name, runtime, operations, schemes),
  };
}

async function readDocument(input) {
  const text = await readFile(input, 'utf8');
  return /\.ya?ml$/i.test(input) ? YAML.parse(text) : JSON.parse(text);
}

function defaultRuntime(output) {
  const specifier = relative(output, resolve(root, 'clients/runtime.js')).split(sep).join('/');
  return specifier.startsWith('.') ? specifier : `./${specifier}`;
}

/**
 * Generate into `output`, or with `check` only compare. Returns the generated file paths and the
 * subset that was stale (missing or different); `check` never writes.
 */
export async function generateClient({ input, document, output, name, runtime, check = false }) {
  if (!output) throw new Error('output directory required');
  if (!document === !input) throw new Error('pass exactly one of input or document');
  const directory = resolve(output);
  const files = await generateClientFiles({
    document: document ?? (await readDocument(resolve(input))),
    name,
    runtime: runtime ?? defaultRuntime(directory),
  });
  const stale = [];
  for (const [file, content] of Object.entries(files)) {
    const path = resolve(directory, file);
    const current = await readFile(path, 'utf8').catch((error) => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    });
    if (current === content) continue;
    stale.push(path);
    if (!check) {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, content);
    }
  }
  return { files: Object.keys(files).map((file) => resolve(directory, file)), stale };
}

const valueFlags = {
  '--input': 'input',
  '--output': 'output',
  '--name': 'name',
  '--runtime': 'runtime',
};

function parseArguments(argv) {
  const options = {
    input: resolve(root, 'openapi.json'),
    output: resolve(root, 'clients/generated/official'),
    name: 'official',
    check: false,
  };
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    if (flag === '--check') {
      options.check = true;
      continue;
    }
    const option = valueFlags[flag];
    const value = argv[++index];
    if (!option || value === undefined) throw new Error(`unknown or incomplete argument ${flag}`);
    options[option] = value;
  }
  return options;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const options = parseArguments(process.argv.slice(2));
  const { stale } = await generateClient(options);
  if (options.check && stale.length) {
    console.error(`Generated client is stale; run without --check:\n${stale.join('\n')}`);
    process.exitCode = 1;
  } else if (!options.check) {
    const where = relative(process.cwd(), resolve(options.output)) || '.';
    console.log(`Generated ${options.name} client in ${where}`);
  }
}
