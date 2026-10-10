// Static HTTP request discovery for the public Screeps World web client.
//
// The client assets are third-party source data: they are downloaded into the ignored .sources
// directory, parsed (never executed) and reduced to request declarations with provenance.
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import ts from 'typescript';

export const OFFICIAL_ORIGIN = 'https://screeps.com';
export const OFFICIAL_ENTRY = `${OFFICIAL_ORIGIN}/a/`;
/** Assets referenced by the entry page that can contain HTTP calls (config.js defines the bases). */
export const OFFICIAL_ASSETS = ['config.js', 'build.min.js', 'app2/runtime.js', 'app2/main.js'];

const apiReceiver = /^_?api(Service|Srv)?$/i;
const pathPattern = /^[a-z][a-z0-9-]*(\/[a-z0-9-]*)*(\?.*)?$/;
const methods = new Set(['get', 'post']);

/** Download the entry page and the referenced assets into `directory`; returns asset metadata. */
export async function fetchOfficialClient(directory) {
  const entry = await download(OFFICIAL_ENTRY);
  const html = entry.toString('utf8');
  const bust = /build\.min\.js\?bust=(\d+)/.exec(html)?.[1];
  if (!bust) throw new Error(`${OFFICIAL_ENTRY} no longer references build.min.js?bust=`);
  for (const asset of OFFICIAL_ASSETS) {
    if (!html.includes(`${asset}?bust=${bust}`))
      throw new Error(`${OFFICIAL_ENTRY} no longer references ${asset}?bust=${bust}`);
  }
  await store(directory, 'index.html', entry);
  for (const asset of OFFICIAL_ASSETS)
    await store(directory, asset, await download(`${OFFICIAL_ENTRY}${asset}?bust=${bust}`));
  await writeFile(resolve(directory, 'bust.txt'), bust + '\n');
  return describeOfficialClient(directory);
}

async function download(url) {
  // Public, unauthenticated GET of static assets; refuse redirects to other hosts.
  const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(60000) });
  if (!response.ok) throw new Error(`GET ${url}: HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

async function store(directory, name, content) {
  await mkdir(dirname(resolve(directory, name)), { recursive: true });
  await writeFile(resolve(directory, name), content);
}

/** Hash the locally stored assets so the inventory pins the exact analysed bytes. */
export async function describeOfficialClient(directory) {
  const bust = (await readFile(resolve(directory, 'bust.txt'), 'utf8')).trim();
  const assets = [];
  for (const asset of ['index.html', ...OFFICIAL_ASSETS]) {
    const content = await readFile(resolve(directory, asset));
    assets.push({
      path: asset,
      url: asset === 'index.html' ? OFFICIAL_ENTRY : `${OFFICIAL_ENTRY}${asset}?bust=${bust}`,
      bytes: content.length,
      sha256: createHash('sha256').update(content).digest('hex'),
    });
  }
  return { entry: OFFICIAL_ENTRY, bust, assets };
}

/**
 * Extract every HTTP request the client source issues against the Screeps API.
 * Each record: {method, path, query[], body[], asset, line, column, module?, via, branch?, responseFields[]}.
 * `branch` is `official` or `private-server` when the call sits on one side of an `options.official`
 * condition, so private-server-only protocol is not mistaken for screeps.com API.
 */
export async function discoverOfficialRequests(directory) {
  const requests = [];
  for (const asset of OFFICIAL_ASSETS) {
    const text = await readFile(resolve(directory, asset), 'utf8');
    const source = ts.createSourceFile(asset, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    const modules = webpackModules(text);
    analyse(source, asset, modules, requests);
  }
  const unique = new Map();
  for (const request of requests) {
    const key = [request.method, request.path, request.asset, request.line, request.column].join(
      ' ',
    );
    unique.set(key, request);
  }
  return [...unique.values()].sort(
    (a, b) =>
      compare(a.path, b.path) ||
      compare(a.method, b.method) ||
      compare(a.asset, b.asset) ||
      a.line - b.line ||
      a.column - b.column,
  );
}

function webpackModules(text) {
  const marks = [];
  const pattern = /^\/\*\*\*\/ "(\.\/src[^"]+)":/gm;
  let match;
  while ((match = pattern.exec(text))) marks.push({ offset: match.index, module: match[1] });
  return marks;
}

function moduleAt(modules, offset) {
  let found;
  for (const mark of modules) {
    if (mark.offset > offset) break;
    found = mark.module;
  }
  return found;
}

function analyse(source, asset, modules, requests) {
  // Scope chain: each entry maps identifier -> injected AngularJS service name.
  const scopes = [new Map()];
  // Service methods that forward a path parameter to Api.get/post (e.g. XsollaService.next).
  const wrappers = [];
  const resolveName = (name) => {
    for (let index = scopes.length - 1; index >= 0; index--)
      if (scopes[index].has(name)) return scopes[index].get(name);
    return undefined;
  };
  const position = (node) => {
    const start = node.getStart(source);
    const { line, character } = source.getLineAndCharacterOfPosition(start);
    return { line: line + 1, column: character + 1, module: moduleAt(modules, start) };
  };
  const isApi = (expression) => {
    if (ts.isIdentifier(expression))
      return resolveName(expression.text) === 'Api' || apiReceiver.test(expression.text);
    if (ts.isPropertyAccessExpression(expression)) return apiReceiver.test(expression.name.text);
    return false;
  };
  const emit = (node, entry) => {
    const { path, query } = splitUrl(entry.url);
    if (!path) return;
    requests.push({
      method: entry.method,
      path,
      query: [...new Set([...query, ...(entry.query ?? [])])].sort(),
      body: [...new Set(entry.body ?? [])].sort(),
      asset,
      ...position(node),
      via: entry.via,
      ...(officialBranch(node) ? { branch: officialBranch(node) } : {}),
      responseFields: [...new Set(responseFields(node))].sort(),
    });
  };

  function visit(node) {
    let pushed = false;
    if (ts.isFunctionLike(node) && ts.isArrayLiteralExpression(node.parent)) {
      const names = node.parent.elements.slice(0, -1);
      if (
        node.parent.elements.at(-1) === node &&
        names.length &&
        names.every((element) => ts.isStringLiteral(element))
      ) {
        const scope = new Map();
        node.parameters.forEach((parameter, index) => {
          if (ts.isIdentifier(parameter.name) && names[index])
            scope.set(parameter.name.text, names[index].text);
        });
        scopes.push(scope);
        pushed = true;
      }
    }
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      ts.isCallExpression(node.initializer) &&
      ts.isPropertyAccessExpression(node.initializer.expression) &&
      node.initializer.expression.name.text === 'get' &&
      ts.isStringLiteral(node.initializer.arguments[0] ?? node) &&
      node.initializer.arguments[0].text === 'Api'
    ) {
      scopes.at(-1).set(node.name.text, 'Api');
    }
    if (ts.isCallExpression(node)) inspectCall(node);
    else if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken)
      inspectUrl(node);
    ts.forEachChild(node, visit);
    if (pushed) scopes.pop();
  }

  function inspectCall(node) {
    const callee = node.expression;
    if (
      ts.isPropertyAccessExpression(callee) &&
      methods.has(callee.name.text) &&
      isApi(callee.expression) &&
      node.arguments.length
    ) {
      const method = callee.name.text;
      const fields = objectKeys(node.arguments[1]);
      for (const url of candidateUrls(node.arguments[0]))
        emit(node, {
          method,
          url,
          via: 'Api.' + method,
          query: method === 'get' ? fields : [],
          body: method === 'post' ? fields : [],
        });
      const wrapper = forwardingMethod(node, method);
      if (wrapper) wrappers.push(wrapper);
      return;
    }
    const wrapper =
      ts.isPropertyAccessExpression(callee) &&
      wrappers.find(
        (entry) =>
          entry.name === callee.name.text &&
          entry.receiver.test(callee.expression.getText(source).split('.').at(-1)),
      );
    if (wrapper && node.arguments.length > wrapper.pathIndex) {
      const fields = objectKeys(node.arguments[wrapper.dataIndex]);
      for (const url of candidateUrls(node.arguments[wrapper.pathIndex]))
        emit(node, {
          method: wrapper.method,
          url,
          via: `${wrapper.owner}.${wrapper.name} -> Api.${wrapper.method}`,
          query: wrapper.method === 'get' ? fields : [],
          body: wrapper.method === 'post' ? fields : [],
        });
      return;
    }
    if (ts.isIdentifier(callee) && callee.text === 'fetch' && node.arguments.length) {
      const base = apiPrefix(node.arguments[0]);
      if (base === undefined) return;
      const init = node.arguments[1];
      const methodProperty =
        init && ts.isObjectLiteralExpression(init)
          ? init.properties.find((property) => property.name?.getText(source) === 'method')
          : undefined;
      const method =
        methodProperty && ts.isPropertyAssignment(methodProperty)
          ? literalText(methodProperty.initializer)?.toLowerCase()
          : 'get';
      let body = [];
      if (init && ts.isObjectLiteralExpression(init)) {
        const bodyProperty = init.properties.find(
          (property) => property.name?.getText(source) === 'body',
        );
        const argument =
          bodyProperty && ts.isPropertyAssignment(bodyProperty)
            ? bodyProperty.initializer
            : undefined;
        if (argument && ts.isCallExpression(argument)) body = objectKeys(argument.arguments[0]);
      }
      emit(node, { method: method ?? 'get', url: base, via: 'fetch', body });
    }
  }

  // URL strings that are built from the API/history bases outside Api.get/post (navigation,
  // image sources, $http history downloads, external links).
  function inspectUrl(node) {
    if (
      ts.isBinaryExpression(node.parent) &&
      node.parent.operatorToken.kind === node.operatorToken.kind
    )
      return;
    const parts = flatten(node);
    const head = parts[0];
    if (!head || ts.isStringLiteralLike(head)) {
      // Private-server history: "http://" + host + ":" + port + "/room-history?room=" + ...
      const start = parts.findIndex((part) => literalText(part)?.startsWith('/room-history'));
      if (literalText(head)?.startsWith('http://') && start > 0)
        emit(node, { method: 'get', url: renderParts(parts.slice(start)), via: 'url' });
      return;
    }
    const headText = head.getText(source);
    const isApiBase = /apiUrl|API_URL/.test(headText);
    const isHistoryBase = /historyUrl|HISTORY_URL/.test(headText);
    if (!isApiBase && !isHistoryBase) return;
    if (insideFetch(node)) return;
    const rest = renderParts(parts.slice(1));
    if (!rest || (isApiBase && rest.startsWith('{'))) return;
    emit(node, {
      method: 'get',
      url: isApiBase ? rest : `room-history/${rest}`,
      via: 'url',
    });
  }

  function insideFetch(node) {
    const parent = node.parent;
    return (
      ts.isCallExpression(parent) &&
      ts.isIdentifier(parent.expression) &&
      parent.expression.text === 'fetch'
    );
  }

  function apiPrefix(argument) {
    const parts = flatten(argument);
    if (parts.length < 2 || !/apiUrl|API_URL/.test(parts[0].getText(source))) return undefined;
    return renderParts(parts.slice(1));
  }

  function flatten(node) {
    if (ts.isParenthesizedExpression(node)) return flatten(node.expression);
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken)
      return [...flatten(node.left), ...flatten(node.right)];
    if (ts.isTemplateExpression(node)) {
      const parts = [ts.factory.createStringLiteral(node.head.text)];
      for (const span of node.templateSpans)
        parts.push(span.expression, ts.factory.createStringLiteral(span.literal.text));
      return parts;
    }
    return [node];
  }

  function renderParts(parts) {
    let text = '';
    for (const part of parts) {
      const value = literalText(part);
      if (value !== undefined) text += value;
      else text += '{' + parameterName(part, text) + '}';
    }
    return text;
  }

  function parameterName(part, preceding) {
    const query = /[?&]([A-Za-z_]+)=$/.exec(preceding);
    if (query) return query[1];
    let text;
    try {
      text = part.getText(source);
    } catch {
      text = 'value';
    }
    const name = /([A-Za-z_][A-Za-z0-9_]*)\)?$/.exec(text)?.[1] ?? 'value';
    return name;
  }

  function candidateUrls(argument) {
    const direct = literalText(argument);
    if (direct !== undefined) return pathPattern.test(direct) ? [direct] : [];
    if (ts.isBinaryExpression(argument) || ts.isTemplateExpression(argument)) {
      const parts = flatten(argument);
      const head = literalText(parts[0]);
      if (head === undefined || !pathPattern.test(head.split('?')[0])) return [];
      return [renderParts(parts)];
    }
    if (ts.isIdentifier(argument)) {
      // Variable path: string literals bound to it in the nearest scope that declares it
      // (function locals first, then outer closures and module constants). Assignments inside
      // nested functions count unless that function shadows the name (minified code reuses
      // short names; transpiled async code assigns outer `var`s inside generator callbacks).
      const name = argument.text;
      for (let container = enclosingFunction(argument); container; container = container.parent) {
        if (!ts.isFunctionLike(container) && !ts.isSourceFile(container)) continue;
        if (hasParameter(container, name)) return [];
        if (!declaresLocally(container, name)) continue;
        const values = [];
        const collect = (node) => {
          if (
            ts.isFunctionLike(node) &&
            node !== container &&
            (hasParameter(node, name) || declaresLocally(node, name))
          )
            return;
          if (
            ts.isBinaryExpression(node) &&
            node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
            ts.isIdentifier(node.left) &&
            node.left.text === name
          )
            values.push(node.right);
          if (
            ts.isVariableDeclaration(node) &&
            ts.isIdentifier(node.name) &&
            node.name.text === name &&
            node.initializer
          )
            values.push(node.initializer);
          ts.forEachChild(node, collect);
        };
        collect(container);
        return values
          .flatMap((value) => {
            if (ts.isConditionalExpression(value))
              return [value.whenTrue, value.whenFalse].map(literalText).filter(Boolean);
            const text = literalText(value);
            return text ? [text] : [];
          })
          .filter((text) => pathPattern.test(text));
      }
      return [];
    }
    if (ts.isConditionalExpression(argument))
      return [...candidateUrls(argument.whenTrue), ...candidateUrls(argument.whenFalse)];
    return [];
  }

  function hasParameter(fn, name) {
    return (
      ts.isFunctionLike(fn) &&
      fn.parameters.some(
        (parameter) => ts.isIdentifier(parameter.name) && parameter.name.text === name,
      )
    );
  }

  // A `var`/`let`/`const` declaration of `name` owned by this function or file (not nested ones).
  function declaresLocally(scope, name) {
    let found = false;
    const visit = (node) => {
      if (found || (ts.isFunctionLike(node) && node !== scope)) return;
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name)
        found = true;
      else ts.forEachChild(node, visit);
    };
    visit(scope);
    return found;
  }

  // `Owner.prototype.name = function (path, data) { this._apiService.post(path, data) }`
  function forwardingMethod(call, method) {
    const argument = call.arguments[0];
    if (!ts.isIdentifier(argument)) return undefined;
    const fn = enclosingFunction(argument);
    const pathIndex = fn?.parameters.findIndex(
      (parameter) => ts.isIdentifier(parameter.name) && parameter.name.text === argument.text,
    );
    if (pathIndex === undefined || pathIndex < 0) return undefined;
    const assignment = fn.parent;
    if (
      !ts.isBinaryExpression(assignment) ||
      !ts.isPropertyAccessExpression(assignment.left) ||
      !/\.prototype$/.test(assignment.left.expression.getText(source))
    )
      return undefined;
    const owner = assignment.left.expression.getText(source).replace(/\.prototype$/, '');
    const data = call.arguments[1];
    const dataIndex =
      data && ts.isIdentifier(data)
        ? fn.parameters.findIndex(
            (parameter) => ts.isIdentifier(parameter.name) && parameter.name.text === data.text,
          )
        : -1;
    const base = owner.replace(/Service$/, '');
    const name = assignment.left.name.text;
    if (wrappers.some((entry) => entry.owner === owner && entry.name === name)) return undefined;
    return {
      owner,
      name,
      method,
      pathIndex,
      dataIndex,
      receiver: new RegExp(`^_?${base}(Srv|Service)$`, 'i'),
    };
  }

  function enclosingFunction(node) {
    let current = node.parent;
    while (current && !ts.isFunctionLike(current)) current = current.parent;
    return current;
  }

  function objectKeys(node) {
    if (!node || !ts.isObjectLiteralExpression(node)) return [];
    return node.properties
      .map(
        (property) =>
          property.name && (literalText(property.name) ?? property.name.getText(source)),
      )
      .filter(Boolean);
  }

  function officialBranch(node) {
    let child = node;
    let current = node.parent;
    while (current) {
      if (ts.isConditionalExpression(current) || ts.isIfStatement(current)) {
        const condition = ts.isIfStatement(current) ? current.expression : current.condition;
        const text = condition.getText(source).replace(/\s+/g, '');
        const official = /options\.official$/.test(text);
        const negated = /^!.*options\.official$/.test(text);
        if (official || negated) {
          const truthy = ts.isIfStatement(current)
            ? child === current.thenStatement
            : child === current.whenTrue;
          const falsy = ts.isIfStatement(current)
            ? child === current.elseStatement
            : child === current.whenFalse;
          if (truthy || falsy) return truthy !== negated ? 'official' : 'private-server';
        }
      }
      child = current;
      current = current.parent;
    }
    return undefined;
  }

  // Response fields read by the caller: `.then(function (r) { r.x })`, `.then(({x}) => ..)`,
  // `(await call).x`, `x = await call; x.y`, and tslib generator `[4, call]` -> `_b.sent()`.
  function responseFields(node) {
    const fields = [];
    let parent = node.parent;
    while (parent && ts.isParenthesizedExpression(parent)) parent = parent.parent;
    if (ts.isPropertyAccessExpression(parent) && parent.name.text === 'then') {
      const call = parent.parent;
      const callback = ts.isCallExpression(call) ? call.arguments[0] : undefined;
      if (callback && ts.isFunctionLike(callback) && callback.parameters[0])
        fields.push(...parameterFields(callback.parameters[0].name, callback.body));
    }
    if (ts.isAwaitExpression(parent)) fields.push(...valueFields(parent));
    if (
      ts.isArrayLiteralExpression(parent) &&
      parent.elements[0] &&
      literalText(parent.elements[0]) === undefined &&
      parent.elements[0].getText(source).startsWith('4') &&
      parent.elements[1] === node
    ) {
      const clause = ancestor(parent, ts.isCaseClause);
      const block = clause && clause.parent;
      const next = block?.clauses[block.clauses.indexOf(clause) + 1];
      if (next) {
        let sent;
        const find = (child) => {
          if (sent) return;
          if (
            ts.isCallExpression(child) &&
            ts.isPropertyAccessExpression(child.expression) &&
            child.expression.name.text === 'sent'
          )
            sent = child;
          else ts.forEachChild(child, find);
        };
        next.statements.forEach(find);
        if (sent) fields.push(...valueFields(sent, next));
      }
    }
    return fields.filter(
      (field) => /^[A-Za-z_$][\w$]*$/.test(field) && field !== 'then' && field !== 'catch',
    );
  }

  function valueFields(expression, scope) {
    let parent = expression.parent;
    while (parent && ts.isParenthesizedExpression(parent)) parent = parent.parent;
    if (ts.isPropertyAccessExpression(parent)) return [parent.name.text];
    let target;
    if (ts.isVariableDeclaration(parent) && parent.initializer === expression) target = parent.name;
    if (
      ts.isBinaryExpression(parent) &&
      parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      parent.right === expression
    )
      target = parent.left;
    if (!target) return [];
    return parameterFields(target, scope ?? enclosingFunction(expression));
  }

  function parameterFields(name, body) {
    if (ts.isObjectBindingPattern(name) || ts.isObjectLiteralExpression(name))
      return (name.elements ?? name.properties).map((element) =>
        (element.propertyName ?? element.name).getText(source),
      );
    if (!ts.isIdentifier(name) || !body) return [];
    const fields = [];
    const scan = (child) => {
      if (
        ts.isPropertyAccessExpression(child) &&
        ts.isIdentifier(child.expression) &&
        child.expression.text === name.text
      )
        fields.push(child.name.text);
      ts.forEachChild(child, scan);
    };
    scan(body);
    return fields;
  }

  visit(source);
  // Second pass resolves calls to forwarding wrappers declared later in the bundle.
  if (wrappers.length) visit(source);
}

function ancestor(node, predicate) {
  let current = node.parent;
  while (current && !predicate(current)) current = current.parent;
  return current;
}

function literalText(node) {
  if (!node) return undefined;
  if (ts.isStringLiteralLike(node)) return node.text;
  return undefined;
}

/** Normalise "game/rooms?shard={shard}" into {path:"/api/game/rooms", query:["shard"]}. */
function splitUrl(url) {
  const [raw, search = ''] = url.split('?');
  if (!raw || raw.includes('://')) return {};
  const query = search
    .split('&')
    .map((pair) => pair.split('=')[0])
    .filter((name) => /^[A-Za-z_]+$/.test(name));
  if (raw.startsWith('/')) return { path: raw.replace(/\/$/, ''), query };
  if (raw.startsWith('room-history/')) return { path: '/' + raw, query };
  return { path: '/api/' + raw.replace(/\/$/, ''), query };
}

function compare(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}
