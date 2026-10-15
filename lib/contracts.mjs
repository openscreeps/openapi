// Composition of the official Screeps World contract with a compatibility profile and
// server-owned extensions into one self-contained OpenAPI 3.1 document, and of the official
// socket contract (AsyncAPI 3.0) with the profile's `socket` section.

export const OPERATION_METHODS = Object.freeze([
  'get',
  'put',
  'post',
  'delete',
  'options',
  'head',
  'patch',
  'trace',
]);
const methodSet = new Set(OPERATION_METHODS);
const COMPONENT_CATEGORIES = Object.freeze([
  'schemas',
  'responses',
  'parameters',
  'examples',
  'requestBodies',
  'headers',
  'securitySchemes',
  'links',
  'callbacks',
  'pathItems',
]);
const PROFILE_KEYS = new Set([
  'name',
  'description',
  'info',
  'servers',
  'transport',
  'required',
  'excluded',
  'adaptations',
  'additions',
  'notes',
  'evidence',
  'overrides',
  'socket',
]);
const PARTITION_KEYS = ['required', 'excluded', 'adaptations', 'additions', 'notes', 'evidence'];
const OFFICIAL_ONLY_KEYS = ['x-availability', 'x-compatibility', 'x-observations'];
const SOCKET_KEYS = new Set([
  'info',
  'servers',
  'excluded',
  'adaptations',
  'evidence',
  'overrides',
]);

/** Every operation of an OpenAPI document as `{method, path, operationId, operation}`, sorted. */
export function listOperations(document) {
  const operations = [];
  for (const [path, item] of Object.entries(document?.paths ?? {})) {
    for (const [method, operation] of Object.entries(item ?? {})) {
      if (!methodSet.has(method)) continue;
      operations.push({ method, path, operationId: operation?.operationId, operation });
    }
  }
  return operations.sort((a, b) => compare(a.path, b.path) || compare(a.method, b.method));
}

/** RFC 7386 JSON merge patch: objects merge recursively, `null` deletes, anything else replaces. */
export function mergePatch(target, patch) {
  if (!isObject(patch)) return structuredClone(patch);
  const result = isObject(target) ? structuredClone(target) : {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete result[key];
    else result[key] = mergePatch(result[key], value);
  }
  return result;
}

/**
 * Merge a profile index (name, info, servers, transport, global overrides) with per-domain
 * fragments (partition maps and overrides) into one profile. Throws on any duplicate entry.
 * `fragments` is an array of `[label, fragment]` pairs; the result is deterministic.
 */
export function assembleProfile(index, fragments) {
  const errors = [];
  const profile = {
    name: index.name,
    description: index.description,
    info: index.info,
    servers: index.servers,
    transport: index.transport ?? [],
    required: [],
    excluded: {},
    adaptations: {},
    additions: {},
    notes: {},
    evidence: {},
    overrides: { paths: {}, components: {} },
  };
  const owners = new Map();
  for (const [label, fragment] of [['index', index], ...fragments]) {
    for (const key of Object.keys(fragment)) {
      if (!PROFILE_KEYS.has(key)) errors.push(`${label}: unknown profile key ${key}`);
      if (
        label !== 'index' &&
        ['name', 'description', 'info', 'servers', 'transport'].includes(key)
      )
        errors.push(`${label}: ${key} belongs to the profile index`);
    }
    for (const id of fragment.required ?? []) {
      if (profile.required.includes(id)) errors.push(`${label}: ${id} already required`);
      else profile.required.push(id);
    }
    if (fragment.socket !== undefined) {
      if (profile.socket !== undefined)
        errors.push(`${label}: socket already defined by ${owners.get('socket')}`);
      profile.socket = fragment.socket;
      owners.set('socket', label);
    }
    for (const key of PARTITION_KEYS.slice(1)) {
      for (const [id, value] of Object.entries(fragment[key] ?? {})) {
        if (Object.hasOwn(profile[key], id))
          errors.push(`${label}: ${key}.${id} already defined by ${owners.get(`${key}:${id}`)}`);
        profile[key][id] = value;
        owners.set(`${key}:${id}`, label);
      }
    }
    for (const [path, item] of Object.entries(fragment.overrides?.paths ?? {})) {
      const target = (profile.overrides.paths[path] ??= {});
      for (const [method, operation] of Object.entries(item)) {
        if (Object.hasOwn(target, method))
          errors.push(`${label}: override ${method} ${path} already defined`);
        target[method] = operation;
      }
    }
    for (const [category, entries] of Object.entries(fragment.overrides?.components ?? {})) {
      const target = (profile.overrides.components[category] ??= {});
      for (const [name, value] of Object.entries(entries)) {
        if (Object.hasOwn(target, name))
          errors.push(`${label}: component override ${category}/${name} already defined`);
        target[name] = value;
      }
    }
  }
  if (errors.length) throw new Error(`Invalid profile fragments:\n- ${errors.join('\n- ')}`);
  profile.required.sort(compare);
  for (const key of PARTITION_KEYS.slice(1)) profile[key] = sortKeys(profile[key]);
  profile.overrides.paths = sortKeys(
    Object.fromEntries(
      Object.entries(profile.overrides.paths).map(([path, item]) => [path, sortKeys(item)]),
    ),
  );
  profile.overrides.components = sortKeys(
    Object.fromEntries(
      Object.entries(profile.overrides.components).map(([category, entries]) => [
        category,
        sortKeys(entries),
      ]),
    ),
  );
  return profile;
}

/**
 * Compose the official socket contract (AsyncAPI 3.0) with the `socket` section of `profile`.
 * `excluded` messages leave the components, channels and operations (operations left without
 * messages disappear); `adaptations` name the messages that `overrides.messages` patches or that
 * use a schema patched by `overrides.schemas` (RFC 7386, each with `x-profile-reason`);
 * `evidence` adds sources. Returns a new self-contained document; inputs are never mutated.
 * Throws one Error listing every violation of the profile contract.
 */
export function composeSocketProfile(official, profile) {
  const errors = [];
  const fail = (message) => errors.push(message);
  const explain = (label, value) => {
    if (!isText(value)) fail(`socket: ${label} needs a non-empty explanation`);
  };
  const socket = profile?.socket;
  if (!isObject(socket)) throw contractError(profile, ['socket: section required']);
  for (const key of Object.keys(socket))
    if (!SOCKET_KEYS.has(key)) fail(`socket: unknown key ${key}`);
  const messages = official.components?.messages ?? {};
  const excluded = socket.excluded ?? {};
  const adaptations = socket.adaptations ?? {};
  const evidence = socket.evidence ?? {};
  const overrides = socket.overrides ?? {};
  for (const [name, text] of Object.entries(excluded)) {
    if (!Object.hasOwn(messages, name)) fail(`socket: excluded ${name} is not an official message`);
    explain(`excluded.${name}`, text);
  }
  for (const [name, text] of Object.entries(adaptations)) {
    if (!Object.hasOwn(messages, name))
      fail(`socket: adaptation ${name} is not an official message`);
    if (Object.hasOwn(excluded, name)) fail(`socket: ${name} is both adapted and excluded`);
    explain(`adaptations.${name}`, text);
  }
  for (const [name, urls] of Object.entries(evidence)) {
    if (!Object.hasOwn(messages, name) || Object.hasOwn(excluded, name))
      fail(`socket: evidence.${name} targets no provided message`);
    if (!Array.isArray(urls) || !urls.length || urls.some((url) => !isText(url)))
      fail(`socket: evidence.${name} must be a non-empty array of URLs`);
  }
  for (const key of Object.keys(overrides))
    if (key !== 'messages' && key !== 'schemas') fail(`socket: unknown override category ${key}`);
  for (const name of Object.keys(overrides.messages ?? {})) {
    if (!Object.hasOwn(messages, name)) fail(`socket: override of unknown message ${name}`);
    else if (!Object.hasOwn(adaptations, name))
      fail(`socket: override patches ${name} without an adaptation reason`);
  }
  const overriddenSchemas = new Set();
  for (const [name, value] of Object.entries(overrides.schemas ?? {})) {
    if (!isText(value?.['x-profile-reason']))
      fail(`socket: schema override ${name} needs x-profile-reason`);
    overriddenSchemas.add(`#/components/schemas/${escape(name)}`);
  }
  if (errors.length) throw contractError(profile, errors);

  const document = structuredClone(official);
  document.info = {
    ...document.info,
    ...structuredClone(socket.info ?? {}),
    version: official.info?.version,
    'x-profile': profile.name,
  };
  if (socket.servers) {
    document.servers = structuredClone(socket.servers);
    const servers = Object.keys(document.servers)
      .sort(compare)
      .map((name) => ({ $ref: `#/servers/${escape(name)}` }));
    for (const channel of Object.values(document.channels ?? {}))
      if (channel.servers) channel.servers = structuredClone(servers);
  }

  const removed = new Set();
  for (const name of Object.keys(excluded)) delete document.components.messages[name];
  for (const [channelName, channel] of Object.entries(document.channels ?? {}))
    for (const [key, message] of Object.entries(channel.messages ?? {}))
      if (resolve(document, message.$ref ?? '') === undefined && message.$ref) {
        delete channel.messages[key];
        removed.add(`#/channels/${escape(channelName)}/messages/${escape(key)}`);
      }
  for (const [name, operation] of Object.entries(document.operations ?? {})) {
    operation.messages = (operation.messages ?? []).filter((ref) => !removed.has(ref.$ref));
    if (operation.reply) {
      operation.reply.messages = (operation.reply.messages ?? []).filter(
        (ref) => !removed.has(ref.$ref),
      );
      if (!operation.reply.messages.length) delete operation.reply;
    }
    if (!operation.messages.length) delete document.operations[name];
  }

  for (const [name, patch] of Object.entries(overrides.messages ?? {}))
    document.components.messages[name] = mergePatch(document.components.messages[name], patch);
  const schemas = (document.components.schemas ??= {});
  for (const [name, patch] of Object.entries(overrides.schemas ?? {}))
    schemas[name] = Object.hasOwn(schemas, name)
      ? mergePatch(schemas[name], patch)
      : structuredClone(patch);

  for (const [name, message] of Object.entries(document.components.messages)) {
    for (const key of OFFICIAL_ONLY_KEYS) delete message[key];
    if (evidence[name])
      message['x-sources'] = [...new Set([...(message['x-sources'] ?? []), ...evidence[name]])];
    const adapted = Object.hasOwn(adaptations, name);
    message['x-profile'] = adapted
      ? { status: 'adapted', reason: adaptations[name] }
      : { status: 'required' };
    const used = [...reachable(document, message)]
      .filter((ref) => overriddenSchemas.has(ref))
      .sort(compare);
    if (used.length) message['x-profile'].overriddenComponents = used;
    if (used.length && !adapted)
      fail(`socket: ${name} uses overridden ${used.join(', ')} but has no adaptation reason`);
    if (adapted && !used.length && !overrides.messages?.[name])
      fail(`socket: adaptation ${name} has no message or schema override`);
  }

  const used = reachable(document, {
    channels: document.channels,
    operations: document.operations,
  });
  for (const name of Object.keys(schemas))
    if (!used.has(`#/components/schemas/${escape(name)}`)) delete schemas[name];
  for (const reference of collectReferences(document)) {
    if (!reference.startsWith('#/')) fail(`socket composed: external reference ${reference}`);
    else if (resolve(document, reference) === undefined)
      fail(`socket composed: unresolved reference ${reference}`);
  }
  if (errors.length) throw contractError(profile, errors);
  document.operations = sortKeys(document.operations ?? {});
  document.components.messages = sortKeys(document.components.messages);
  document.components.schemas = sortKeys(schemas);
  return document;
}

/**
 * Compose `official` with `profile` and server `extensions` ({paths, components}).
 * Returns a new self-contained OpenAPI document; inputs are never mutated.
 * Throws one Error listing every violation of the profile contract.
 */
export function composeProfile(official, profile, extensions = {}) {
  const errors = [];
  const fail = (message) => errors.push(message);
  extensions = { paths: {}, components: {}, ...extensions };
  for (const key of Object.keys(extensions))
    if (!['paths', 'components'].includes(key)) fail(`extensions: unknown top-level key ${key}`);
  for (const key of Object.keys(profile))
    if (!PROFILE_KEYS.has(key)) fail(`profile: unknown key ${key}`);

  const officialOperations = listOperations(official);
  const officialById = new Map();
  const officialByRoute = new Map();
  for (const entry of officialOperations) {
    if (!entry.operationId) fail(`official: ${entry.method} ${entry.path} has no operationId`);
    else if (officialById.has(entry.operationId))
      fail(`official: duplicate operationId ${entry.operationId}`);
    officialById.set(entry.operationId, entry);
    officialByRoute.set(route(entry), entry);
  }

  const required = new Set();
  for (const id of profile.required ?? []) {
    if (required.has(id)) fail(`profile: ${id} listed twice in required`);
    required.add(id);
  }
  const excluded = profile.excluded ?? {};
  const adaptations = profile.adaptations ?? {};
  const additions = profile.additions ?? {};
  const notes = profile.notes ?? {};
  const evidence = profile.evidence ?? {};
  for (const id of required)
    if (!officialById.has(id)) fail(`profile: required ${id} is not an official operation`);
  for (const [id, reason] of Object.entries(excluded)) {
    if (!officialById.has(id)) fail(`profile: excluded ${id} is not an official operation`);
    if (required.has(id)) fail(`profile: ${id} is both required and excluded`);
    checkReason(`excluded.${id}`, reason);
  }
  for (const id of officialById.keys())
    if (!required.has(id) && !Object.hasOwn(excluded, id))
      fail(`profile: official operation ${id} is neither required nor excluded`);
  for (const [id, reason] of Object.entries(adaptations)) {
    if (!required.has(id)) fail(`profile: adaptation ${id} is not a required operation`);
    checkReason(`adaptations.${id}`, reason);
  }
  for (const [id, reason] of Object.entries(additions)) {
    if (officialById.has(id)) fail(`profile: addition ${id} reuses an official operationId`);
    checkReason(`additions.${id}`, reason);
  }
  for (const [key, map] of [
    ['notes', notes],
    ['evidence', evidence],
  ]) {
    for (const [id, value] of Object.entries(map)) {
      if (!required.has(id) && !Object.hasOwn(additions, id))
        fail(`profile: ${key}.${id} targets neither a required operation nor an addition`);
      if (key === 'notes') checkReason(`notes.${id}`, value);
      else if (!Array.isArray(value) || !value.length || value.some((url) => !isText(url)))
        fail(`profile: evidence.${id} must be a non-empty array of URLs`);
    }
  }

  // Operation overrides: adaptations patch official operations, additions define new ones.
  const patches = new Map();
  const additionOperations = new Map();
  for (const [path, item] of Object.entries(profile.overrides?.paths ?? {})) {
    for (const [method, operation] of Object.entries(item ?? {})) {
      const key = `${method} ${path}`;
      if (!methodSet.has(method)) {
        fail(`profile: override ${key} is not an operation`);
        continue;
      }
      const target = officialByRoute.get(key);
      if (target) {
        if (!Object.hasOwn(adaptations, target.operationId))
          fail(
            `profile: override ${key} patches ${target.operationId} without an adaptation reason`,
          );
        if (operation?.operationId !== undefined && operation.operationId !== target.operationId)
          fail(`profile: override ${key} must not change operationId ${target.operationId}`);
        patches.set(target.operationId, operation);
      } else {
        const id = operation?.operationId;
        if (!id || !Object.hasOwn(additions, id))
          fail(`profile: override ${key} is not official and its operationId is not an addition`);
        else if (additionOperations.has(id)) fail(`profile: addition ${id} defined twice`);
        else additionOperations.set(id, { method, path, operation });
        if (!Array.isArray(operation?.security)) fail(`profile: addition ${key} needs security`);
        if (!operation?.responses) fail(`profile: addition ${key} needs responses`);
      }
    }
  }
  for (const id of Object.keys(additions))
    if (!additionOperations.has(id))
      fail(`profile: addition ${id} has no overrides.paths operation`);

  // Component overrides must say why they diverge from the official components.
  const overriddenComponents = new Set();
  for (const [category, entries] of Object.entries(profile.overrides?.components ?? {})) {
    if (!COMPONENT_CATEGORIES.includes(category))
      fail(`profile: unknown component category ${category}`);
    for (const [name, value] of Object.entries(entries ?? {})) {
      if (!isText(value?.['x-profile-reason']))
        fail(`profile: component override ${category}/${name} needs x-profile-reason`);
      overriddenComponents.add(`#/components/${category}/${name}`);
    }
  }

  // Extensions: server-owned operations that are neither official nor profile additions.
  const extensionIds = new Set();
  for (const entry of listOperations(extensions)) {
    const key = route(entry);
    if (officialByRoute.has(key))
      fail(`extensions: ${key} collides with official ${officialByRoute.get(key).operationId}`);
    if (profile.overrides?.paths?.[entry.path]?.[entry.method])
      fail(`extensions: ${key} collides with a profile operation`);
    const id = entry.operationId;
    if (!id) fail(`extensions: ${key} has no operationId`);
    else if (officialById.has(id) || additionOperations.has(id) || extensionIds.has(id))
      fail(`extensions: duplicate operationId ${id}`);
    extensionIds.add(id);
    if (!Array.isArray(entry.operation.security)) fail(`extensions: ${key} needs security`);
  }
  for (const [category, entries] of Object.entries(extensions.components ?? {})) {
    if (!COMPONENT_CATEGORIES.includes(category))
      fail(`extensions: unknown component category ${category}`);
    for (const name of Object.keys(entries ?? {})) {
      if (Object.hasOwn(official.components?.[category] ?? {}, name))
        fail(`extensions: component ${category}/${name} collides with an official component`);
      if (Object.hasOwn(profile.overrides?.components?.[category] ?? {}, name))
        fail(`extensions: component ${category}/${name} collides with a profile component`);
    }
  }

  const transport = (profile.transport ?? []).map((rule, index) => {
    let pattern;
    try {
      pattern = new RegExp(rule.match);
    } catch {
      fail(`profile: transport[${index}].match is not a regular expression`);
    }
    if (!rule.parameter) fail(`profile: transport[${index}] needs a parameter`);
    checkReason(`transport[${index}].reason`, rule.reason);
    return { pattern, parameter: rule.parameter };
  });
  if (errors.length) throw contractError(profile, errors);

  // Compose.
  const document = {
    openapi: official.openapi,
    info: {
      ...structuredClone(official.info),
      ...structuredClone(profile.info ?? {}),
      version: official.info?.version,
      'x-profile': profile.name,
    },
    servers: structuredClone(profile.servers ?? official.servers ?? []),
    ...(official.externalDocs ? { externalDocs: structuredClone(official.externalDocs) } : {}),
    paths: {},
    components: {},
  };
  const place = (method, path, operation) => {
    const item = (document.paths[path] ??= {});
    item[method] = operation;
  };
  const decorate = (id, operation, profileStatus) => {
    for (const key of OFFICIAL_ONLY_KEYS) delete operation[key];
    if (notes[id])
      operation.description = [operation.description, `Standalone: ${notes[id]}`]
        .filter(Boolean)
        .join('\n\n');
    if (evidence[id])
      operation['x-sources'] = [...new Set([...(operation['x-sources'] ?? []), ...evidence[id]])];
    operation['x-profile'] = profileStatus;
    return operation;
  };
  for (const entry of officialOperations) {
    if (!required.has(entry.operationId)) continue;
    let operation = structuredClone(entry.operation);
    if (patches.has(entry.operationId))
      operation = mergePatch(operation, patches.get(entry.operationId));
    const adapted = Object.hasOwn(adaptations, entry.operationId);
    decorate(
      entry.operationId,
      operation,
      adapted
        ? { status: 'adapted', reason: adaptations[entry.operationId] }
        : { status: 'required' },
    );
    applyTransport(entry.path, operation);
    place(entry.method, entry.path, operation);
  }
  for (const [id, { method, path, operation }] of additionOperations) {
    const copy = decorate(id, structuredClone(operation), {
      status: 'addition',
      reason: additions[id],
    });
    applyTransport(path, copy);
    place(method, path, copy);
  }
  for (const entry of listOperations(extensions)) {
    const operation = structuredClone(entry.operation);
    operation['x-profile'] = { status: 'extension' };
    place(entry.method, entry.path, operation);
  }

  for (const [category, entries] of Object.entries(official.components ?? {}))
    document.components[category] = structuredClone(entries);
  for (const [category, entries] of Object.entries(profile.overrides?.components ?? {})) {
    const target = (document.components[category] ??= {});
    for (const [name, value] of Object.entries(entries))
      target[name] = Object.hasOwn(target, name)
        ? mergePatch(target[name], value)
        : structuredClone(value);
  }
  const extensionSchemes = new Set();
  for (const [category, entries] of Object.entries(extensions.components ?? {})) {
    const target = (document.components[category] ??= {});
    for (const [name, value] of Object.entries(entries)) {
      target[name] = structuredClone(value);
      if (category === 'securitySchemes') extensionSchemes.add(name);
    }
  }

  // Record which overridden components each operation depends on. A required operation whose
  // payload schemas differ from the official ones must say why (adaptations); global parameter
  // and security-scheme overrides (e.g. ignored `shard`) are documented once by the profile.
  for (const { operation, operationId, method, path } of listOperations(document)) {
    if (operation['x-profile'].status === 'extension') continue;
    const used = [...reachable(document, operation)].filter((ref) => overriddenComponents.has(ref));
    if (!used.length) continue;
    operation['x-profile'].overriddenComponents = used.sort(compare);
    const schemas = used.filter((ref) => ref.startsWith('#/components/schemas/'));
    if (schemas.length && operation['x-profile'].status === 'required')
      errors.push(
        `profile: ${operationId} (${method} ${path}) uses overridden ${schemas.join(', ')} but has no adaptation reason`,
      );
  }

  pruneComponents(document, extensionSchemes);
  const tagDescriptions = new Map((official.tags ?? []).map((tag) => [tag.name, tag]));
  const tags = new Set();
  for (const { operation } of listOperations(document))
    for (const tag of operation.tags ?? []) tags.add(tag);
  document.tags = [...tags].sort(compare).map(
    (name) =>
      structuredClone(tagDescriptions.get(name)) ?? {
        name,
        description: `${name} HTTP operations.`,
      },
  );

  for (const reference of collectReferences(document)) {
    if (!reference.startsWith('#/')) errors.push(`composed: external reference ${reference}`);
    else if (resolve(document, reference) === undefined)
      errors.push(`composed: unresolved reference ${reference}`);
  }
  for (const { operation, method, path } of listOperations(document))
    for (const requirement of operation.security ?? [])
      for (const scheme of Object.keys(requirement))
        if (!document.components.securitySchemes?.[scheme])
          errors.push(`composed: ${method} ${path} uses undeclared security scheme ${scheme}`);
  if (errors.length) throw contractError(profile, errors);

  document.paths = sortKeys(
    Object.fromEntries(
      Object.entries(document.paths).map(([path, item]) => [path, sortMethods(item)]),
    ),
  );
  document.components = Object.fromEntries(
    COMPONENT_CATEGORIES.filter((category) => document.components[category]).map((category) => [
      category,
      sortKeys(document.components[category]),
    ]),
  );
  return document;

  function applyTransport(path, operation) {
    for (const { pattern, parameter } of transport) {
      if (!pattern.test(path)) continue;
      operation.parameters ??= [];
      const present = operation.parameters.some((existing) =>
        parameter.$ref
          ? existing.$ref === parameter.$ref
          : existing.name === parameter.name && existing.in === parameter.in,
      );
      if (!present) operation.parameters.push(structuredClone(parameter));
    }
  }

  function checkReason(label, value) {
    if (!isText(value)) fail(`profile: ${label} needs a non-empty explanation`);
  }
}

function contractError(profile, errors) {
  return new Error(
    `Profile ${profile?.name ?? '(unnamed)'} does not compose:\n- ${errors.join('\n- ')}`,
  );
}

function pruneComponents(document, keepSchemes) {
  const used = new Set();
  const visit = (value) => {
    for (const reference of collectReferences(value)) {
      if (used.has(reference) || !reference.startsWith('#/components/')) continue;
      used.add(reference);
      visit(resolve(document, reference));
    }
  };
  visit(document.paths);
  const schemes = new Set(keepSchemes);
  for (const requirement of document.security ?? [])
    for (const name of Object.keys(requirement)) schemes.add(name);
  for (const { operation } of listOperations(document))
    for (const requirement of operation.security ?? [])
      for (const name of Object.keys(requirement)) schemes.add(name);
  for (const [category, entries] of Object.entries(document.components)) {
    for (const name of Object.keys(entries)) {
      const keep =
        category === 'securitySchemes'
          ? schemes.has(name)
          : used.has(`#/components/${category}/${escape(name)}`);
      if (!keep) delete entries[name];
    }
    if (!Object.keys(entries).length) delete document.components[category];
  }
}

function reachable(document, root) {
  const seen = new Set();
  const visit = (value) => {
    for (const reference of collectReferences(value)) {
      if (seen.has(reference)) continue;
      seen.add(reference);
      visit(resolve(document, reference));
    }
  };
  visit(root);
  return seen;
}

function collectReferences(value, found = new Set()) {
  if (Array.isArray(value)) for (const child of value) collectReferences(child, found);
  else if (isObject(value)) {
    if (typeof value.$ref === 'string') found.add(value.$ref);
    for (const child of Object.values(value)) collectReferences(child, found);
  }
  return found;
}

function resolve(document, reference) {
  if (!reference.startsWith('#/')) return undefined;
  let target = document;
  for (const part of reference.slice(2).split('/'))
    target = target?.[part.replaceAll('~1', '/').replaceAll('~0', '~')];
  return target;
}

function escape(name) {
  return name.replaceAll('~', '~0').replaceAll('/', '~1');
}

function route({ method, path }) {
  return `${method} ${path}`;
}

function sortMethods(item) {
  return Object.fromEntries(
    Object.entries(item).sort(
      ([a], [b]) => OPERATION_METHODS.indexOf(a) - OPERATION_METHODS.indexOf(b) || compare(a, b),
    ),
  );
}

function sortKeys(object) {
  return Object.fromEntries(Object.entries(object).sort(([a], [b]) => compare(a, b)));
}

function compare(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isText(value) {
  return typeof value === 'string' && value.trim().length > 0;
}
