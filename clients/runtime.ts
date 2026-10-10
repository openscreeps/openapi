/**
 * Runtime shared by every client generated with scripts/generate-clients.mjs.
 *
 * Deliberately small: native fetch only, no automatic retries, no redirect following, and
 * credentials attached only for the security schemes an operation declares. Only erasable
 * TypeScript syntax is used so the file runs under Node type stripping, tsx and browsers alike.
 */

export type HttpMethod = 'GET' | 'PUT' | 'POST' | 'DELETE' | 'OPTIONS' | 'HEAD' | 'PATCH' | 'TRACE';
/** How a response body is decoded: JSON value, string or Uint8Array. */
export type ResponseKind = 'json' | 'text' | 'binary';
/** How a request body is encoded. */
export type RequestKind = ResponseKind | 'form' | 'multipart';

export interface ParameterDescriptor {
  readonly name: string;
  readonly in: 'path' | 'query' | 'header';
  readonly required: boolean;
  /** Path parameter spanning several `/`-separated segments (`x-openscreeps-wildcard`). */
  readonly wildcard: boolean;
  /** Query arrays repeat the name when true, otherwise they are comma-joined. */
  readonly explode: boolean;
}

export interface RequestBodyDescriptor {
  readonly required: boolean;
  readonly contentType: string;
  readonly kind: RequestKind;
}

export interface OperationDescriptor {
  readonly operationId: string;
  readonly method: HttpMethod;
  /** OpenAPI path template, appended to the client base URL path. */
  readonly path: string;
  readonly parameters: readonly ParameterDescriptor[];
  readonly requestBody?: RequestBodyDescriptor;
  /** Declared responses by status code, `2XX`-style range or `default`: media type -> kind. */
  readonly responses: { readonly [status: string]: { readonly [mediaType: string]: ResponseKind } };
  /** Security alternatives; each lists scheme names required together. `[]` is anonymous access. */
  readonly security: readonly (readonly string[])[];
}

export type SecuritySchemeDescriptor =
  | {
      readonly type: 'apiKey';
      readonly in: 'header' | 'query';
      readonly name: string;
      /** Response header carrying a rotated credential. */
      readonly refreshHeader?: string;
    }
  | { readonly type: 'bearer'; readonly refreshHeader?: string };

/** Type-level description of one generated operation. */
export interface OperationTypes {
  readonly request: RequestGroups;
  readonly responses: {
    readonly status: number;
    readonly contentType: string;
    readonly body: unknown;
  };
  readonly result: unknown;
  readonly success: unknown;
}

/** Shape of every generated request type; absent groups are typed `never`. */
export interface RequestGroups {
  readonly path?: object;
  readonly query?: object;
  readonly headers?: object;
  readonly body?: unknown;
}

/** Logical failure body many Screeps endpoints return with HTTP 200. */
export interface ErrorEnvelope {
  error: string;
}

export type BinaryBody = Blob | ArrayBuffer | ArrayBufferView;
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface ClientOptions<Scheme extends string = string> {
  /** Absolute http(s) URL; its path (for example a seasonal `/season` prefix) is preserved. */
  readonly baseUrl: string | URL;
  /** Credential per security scheme; a scheme's value is only sent to operations requiring it. */
  readonly credentials?: { readonly [S in Scheme]?: string };
  /** Called after the server rotates a credential (for example via the X-Token response header). */
  readonly onCredentialRefresh?: (scheme: Scheme, value: string) => void;
  /** Defaults to the global fetch. */
  readonly fetch?: FetchLike;
  /** Headers sent with every request; declared parameters and credentials take precedence. */
  readonly headers?: { readonly [name: string]: string };
  /** Detects an HTTP 2xx logical error body; defaults to {@link isErrorEnvelope}. */
  readonly isErrorEnvelope?: (body: unknown) => boolean;
}

export interface RequestOptions {
  readonly signal?: AbortSignal;
  readonly headers?: { readonly [name: string]: string };
}

interface RawResponseBase {
  readonly headers: Headers;
  readonly response: Response;
}
/** Result of {@link OpenApiClient.send}: a declared response variant or an undeclared status. */
export type SendResult<Responses> = RawResponseBase &
  (
    | (Responses & { readonly declared: true })
    | {
        readonly declared: false;
        readonly status: number;
        readonly contentType: string;
        readonly body: unknown;
      }
  );

export class OpenApiClientError extends Error {
  readonly operationId: string;
  constructor(operationId: string, message: string, options?: ErrorOptions) {
    super(`${operationId}: ${message}`, options);
    this.name = 'OpenApiClientError';
    this.operationId = operationId;
  }
}

/** Non-2xx HTTP status. */
export class ApiHttpError extends OpenApiClientError {
  readonly status: number;
  readonly headers: Headers;
  readonly body: unknown;
  constructor(operationId: string, status: number, headers: Headers, body: unknown) {
    super(operationId, `HTTP ${status}${describeError(body)}`);
    this.name = 'ApiHttpError';
    this.status = status;
    this.headers = headers;
    this.body = body;
  }
}

/** HTTP 2xx response whose body is a logical error envelope such as `{ "error": "..." }`. */
export class ApiEnvelopeError extends OpenApiClientError {
  readonly status: number;
  readonly headers: Headers;
  readonly body: unknown;
  constructor(operationId: string, status: number, headers: Headers, body: unknown) {
    super(operationId, `API error${describeError(body)}`);
    this.name = 'ApiEnvelopeError';
    this.status = status;
    this.headers = headers;
    this.body = body;
  }
}

/** Redirects are never followed, so credentials cannot leak to another location. */
export class ApiRedirectError extends OpenApiClientError {
  readonly status: number;
  readonly location: string | null;
  constructor(operationId: string, status: number, location: string | null) {
    super(operationId, `refusing to follow redirect (HTTP ${status || 'opaque'})`);
    this.name = 'ApiRedirectError';
    this.status = status;
    this.location = location;
  }
}

/** No configured credential satisfies the operation's security requirements; nothing was sent. */
export class ApiCredentialError extends OpenApiClientError {
  readonly security: readonly (readonly string[])[];
  constructor(operationId: string, security: readonly (readonly string[])[]) {
    super(
      operationId,
      `missing credentials for ${security.map((schemes) => schemes.join(' + ')).join(' or ')}`,
    );
    this.name = 'ApiCredentialError';
    this.security = security;
  }
}

/** Response body could not be decoded as its content type promised. */
export class ApiResponseError extends OpenApiClientError {
  readonly status: number;
  constructor(operationId: string, status: number, message: string, options?: ErrorOptions) {
    super(operationId, message, options);
    this.name = 'ApiResponseError';
    this.status = status;
  }
}

function describeError(body: unknown): string {
  return isErrorEnvelope(body) ? `: ${body.error}` : '';
}

/** Default envelope detection: a JSON object with a string `error` and without `ok: 1`. */
export function isErrorEnvelope(body: unknown): body is ErrorEnvelope {
  return (
    typeof body === 'object' &&
    body !== null &&
    'error' in body &&
    typeof body.error === 'string' &&
    !('ok' in body && body.ok === 1)
  );
}

/** Decoding used when a response media type was not declared for its status. */
function kindOfMediaType(mediaType: string): ResponseKind {
  if (mediaType === 'application/json' || /^application\/[^;]*\+json$/.test(mediaType)) {
    return 'json';
  }
  const xml = mediaType === 'application/xml' || mediaType.endsWith('+xml');
  if (mediaType.startsWith('text/') || xml) return 'text';
  return 'binary';
}

function scalar(operationId: string, name: string, value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  throw new TypeError(`${operationId}: parameter ${name} must be a string, number or boolean`);
}

function values(operationId: string, name: string, value: unknown): string[] {
  return Array.isArray(value)
    ? value.map((item: unknown) => scalar(operationId, name, item))
    : [scalar(operationId, name, value)];
}

/** Escape one path segment; empty and dot segments would change which route is addressed. */
function pathSegment(operationId: string, name: string, segment: string): string {
  if (segment === '' || segment === '.' || segment === '..') {
    throw new TypeError(`${operationId}: path parameter ${name} has an empty or dot segment`);
  }
  return encodeURIComponent(segment);
}

function parameterGroup(name: string, value: object | undefined): Map<string, unknown> {
  if (value !== undefined && (typeof value !== 'object' || value === null)) {
    throw new TypeError(`request ${name} must be an object`);
  }
  return new Map<string, unknown>(Object.entries(value ?? {}));
}

function encodeBody(descriptor: RequestBodyDescriptor, body: unknown): RequestInit['body'] {
  switch (descriptor.kind) {
    case 'json':
      return JSON.stringify(body);
    case 'text':
      return String(body);
    case 'form': {
      const params = new URLSearchParams();
      if (typeof body !== 'object' || body === null) {
        throw new TypeError('form body must be an object');
      }
      for (const [name, value] of Object.entries(body)) {
        if (value === undefined) continue;
        for (const item of values('form', name, value)) params.append(name, item);
      }
      return params;
    }
    case 'multipart':
      if (!(body instanceof FormData)) throw new TypeError('multipart body must be FormData');
      return body;
    case 'binary':
      if (body instanceof Blob || body instanceof ArrayBuffer || ArrayBuffer.isView(body)) {
        // DOM and undici typings disagree on which ArrayBufferView backings fetch accepts.
        const bytes = body as RequestInit['body'];
        return bytes;
      }
      throw new TypeError('binary body must be a Blob, ArrayBuffer or typed array');
  }
}

function matchKind(
  content: { readonly [mediaType: string]: ResponseKind } | undefined,
  mediaType: string,
): ResponseKind | undefined {
  if (!content) return undefined;
  const exact = content[mediaType];
  if (exact) return exact;
  const range = content[`${mediaType.split('/')[0]}/*`];
  if (range) return range;
  if (mediaType === '') {
    const kinds = new Set(Object.values(content));
    if (kinds.size === 1) return [...kinds][0];
  }
  return content['*/*'];
}

/** Base class of generated clients. `Ops` is the generated `Operations` interface. */
export class OpenApiClient<
  Ops extends { readonly [K in keyof Ops]: OperationTypes },
  Scheme extends string = string,
> {
  readonly #operations: { readonly [K in keyof Ops]: OperationDescriptor };
  readonly #schemes: { readonly [S in Scheme]: SecuritySchemeDescriptor };
  readonly #credentials = new Map<Scheme, string>();
  readonly #base: string;
  readonly #fetch: FetchLike;
  readonly #headers: { readonly [name: string]: string };
  readonly #isErrorEnvelope: (body: unknown) => boolean;
  readonly #onCredentialRefresh: ((scheme: Scheme, value: string) => void) | undefined;

  constructor(
    operations: { readonly [K in keyof Ops]: OperationDescriptor },
    securitySchemes: { readonly [S in Scheme]: SecuritySchemeDescriptor },
    options: ClientOptions<Scheme>,
  ) {
    const base = new URL(options.baseUrl);
    if (base.protocol !== 'http:' && base.protocol !== 'https:') {
      throw new TypeError('baseUrl must use http: or https:');
    }
    if (base.username || base.password || base.search || base.hash) {
      throw new TypeError('baseUrl must not contain credentials, a query or a fragment');
    }
    this.#base = base.origin + base.pathname.replace(/\/+$/, '');
    this.#operations = operations;
    this.#schemes = securitySchemes;
    this.#fetch = options.fetch ?? ((url, init) => globalThis.fetch(url, init));
    this.#headers = options.headers ?? {};
    this.#isErrorEnvelope = options.isErrorEnvelope ?? isErrorEnvelope;
    this.#onCredentialRefresh = options.onCredentialRefresh;
    for (const scheme of Object.keys(options.credentials ?? {}) as Scheme[]) {
      this.setCredential(scheme, options.credentials?.[scheme]);
    }
  }

  /** Replace or clear (with `undefined`) the credential used for one security scheme. */
  setCredential(scheme: Scheme, value: string | undefined): void {
    if (!Object.hasOwn(this.#schemes, scheme)) {
      throw new TypeError(`unknown security scheme ${scheme}`);
    }
    if (value === undefined || value === '') this.#credentials.delete(scheme);
    else this.#credentials.set(scheme, value);
  }

  getCredential(scheme: Scheme): string | undefined {
    return this.#credentials.get(scheme);
  }

  /**
   * Perform an operation and return its 2xx body. Throws {@link ApiHttpError} for other
   * statuses and {@link ApiEnvelopeError} for 2xx logical error envelopes. Never retries.
   */
  async call<K extends keyof Ops & string>(
    operationId: K,
    input: Ops[K]['request'],
    init?: RequestOptions,
  ): Promise<Ops[K]['success']> {
    const result = await this.send(operationId, input, init);
    if (result.status < 200 || result.status > 299) {
      throw new ApiHttpError(operationId, result.status, result.headers, result.body);
    }
    if (this.#isErrorEnvelope(result.body)) {
      throw new ApiEnvelopeError(operationId, result.status, result.headers, result.body);
    }
    return result.body as Ops[K]['success'];
  }

  /**
   * Perform an operation and return the decoded response whatever its status. Throws only for
   * invalid input, missing credentials, redirects, network failures and undecodable bodies.
   */
  async send<K extends keyof Ops & string>(
    operationId: K,
    input: Ops[K]['request'],
    init?: RequestOptions,
  ): Promise<SendResult<Ops[K]['responses']>> {
    const operation = this.#operations[operationId];
    if (!operation) throw new TypeError(`unknown operation ${operationId}`);
    const groups = {
      path: parameterGroup('path', input.path),
      query: parameterGroup('query', input.query),
      header: parameterGroup('headers', input.headers),
    };
    const query = new URLSearchParams();
    const headers = new Headers(this.#headers);
    for (const [name, value] of Object.entries(init?.headers ?? {})) headers.set(name, value);

    let path = operation.path;
    for (const parameter of operation.parameters) {
      const value = groups[parameter.in].get(parameter.name);
      if (value === undefined) {
        if (parameter.required) {
          throw new TypeError(
            `${operationId}: missing required ${parameter.in} parameter ${parameter.name}`,
          );
        }
        continue;
      }
      if (parameter.in === 'path') {
        const text = scalar(operationId, parameter.name, value);
        const escaped = parameter.wildcard
          ? text
              .split('/')
              .map((segment) => pathSegment(operationId, parameter.name, segment))
              .join('/')
          : pathSegment(operationId, parameter.name, text);
        path = path.replaceAll(`{${parameter.name}}`, escaped);
      } else if (parameter.in === 'query') {
        const items = values(operationId, parameter.name, value);
        if (parameter.explode) for (const item of items) query.append(parameter.name, item);
        else query.append(parameter.name, items.join(','));
      } else {
        headers.set(parameter.name, values(operationId, parameter.name, value).join(', '));
      }
    }

    let body: RequestInit['body'];
    const bodyValue = input.body;
    if (operation.requestBody && bodyValue !== undefined) {
      body = encodeBody(operation.requestBody, bodyValue);
      if (operation.requestBody.kind !== 'multipart' && operation.requestBody.kind !== 'form') {
        headers.set('Content-Type', operation.requestBody.contentType);
      }
    } else if (operation.requestBody?.required) {
      throw new TypeError(`${operationId}: missing required request body`);
    }

    const accept = new Set<string>();
    for (const [status, content] of Object.entries(operation.responses)) {
      if (!status.startsWith('2')) continue;
      for (const mediaType of Object.keys(content)) accept.add(mediaType);
    }
    if (accept.size > 0 && !headers.has('Accept')) headers.set('Accept', [...accept].join(', '));

    const used = this.#authorize(operationId, operation, headers, query);
    const search = query.toString();
    const url = `${this.#base}${path}${search ? `?${search}` : ''}`;
    const request: RequestInit = { method: operation.method, headers, redirect: 'manual' };
    if (body !== undefined) request.body = body;
    if (init?.signal) request.signal = init.signal;
    const response = await this.#fetch(url, request);

    const redirected = response.status >= 300 && response.status < 400;
    if (response.type === 'opaqueredirect' || redirected) {
      await response.body?.cancel();
      throw new ApiRedirectError(operationId, response.status, response.headers.get('Location'));
    }
    this.#refresh(used, response.headers);

    const status = response.status;
    const declared =
      operation.responses[String(status)] ??
      operation.responses[`${String(status).charAt(0)}XX`] ??
      operation.responses.default;
    const contentType = response.headers.get('Content-Type') ?? '';
    const mediaType = contentType.split(';')[0]!.trim().toLowerCase();
    const decoded = await this.#decode(operationId, response, declared, mediaType);
    return {
      declared: declared !== undefined,
      status,
      contentType: mediaType,
      body: decoded,
      headers: response.headers,
      response,
    } as SendResult<Ops[K]['responses']>;
  }

  #authorize(
    operationId: string,
    operation: OperationDescriptor,
    headers: Headers,
    query: URLSearchParams,
  ): readonly Scheme[] {
    if (operation.security.length === 0) return [];
    const satisfied = operation.security.find(
      (schemes) =>
        schemes.length > 0 && schemes.every((scheme) => this.#credentials.has(scheme as Scheme)),
    );
    if (!satisfied) {
      if (operation.security.some((schemes) => schemes.length === 0)) return [];
      throw new ApiCredentialError(operationId, operation.security);
    }
    const used = satisfied as readonly Scheme[];
    for (const scheme of used) {
      const descriptor = this.#schemes[scheme];
      const value = this.#credentials.get(scheme)!;
      if (descriptor.type === 'bearer') headers.set('Authorization', `Bearer ${value}`);
      else if (descriptor.in === 'header') headers.set(descriptor.name, value);
      else query.set(descriptor.name, value);
    }
    return used;
  }

  #refresh(used: readonly Scheme[], headers: Headers): void {
    for (const scheme of used) {
      const descriptor = this.#schemes[scheme];
      const header =
        descriptor.refreshHeader ??
        (descriptor.type === 'apiKey' && descriptor.in === 'header' ? descriptor.name : undefined);
      const value = header ? headers.get(header) : null;
      if (!value || value === this.#credentials.get(scheme)) continue;
      this.#credentials.set(scheme, value);
      this.#onCredentialRefresh?.(scheme, value);
    }
  }

  async #decode(
    operationId: string,
    response: Response,
    declared: { readonly [mediaType: string]: ResponseKind } | undefined,
    mediaType: string,
  ): Promise<unknown> {
    const kind = matchKind(declared, mediaType) ?? kindOfMediaType(mediaType);
    if (kind === 'binary') {
      const bytes = new Uint8Array(await response.arrayBuffer());
      return bytes.byteLength === 0 && mediaType === '' ? undefined : bytes;
    }
    const text = await response.text();
    if (kind === 'text') return text === '' && mediaType === '' ? undefined : text;
    if (text === '') return undefined;
    try {
      return JSON.parse(text) as unknown;
    } catch (error) {
      throw new ApiResponseError(operationId, response.status, 'invalid JSON response body', {
        cause: error,
      });
    }
  }
}
