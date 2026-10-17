// Source route inventory: refreshes coverage.json from the pinned reference sources in .sources/.
//
//   node scripts/inventory.mjs --fetch           download the current official web client into
//                                                .sources/official, then rewrite coverage.json
//   node scripts/inventory.mjs                   rebuild coverage.json from .sources
//   node scripts/inventory.mjs [--fetch] --check fail when coverage.json differs from .sources
//                                                (with --fetch: drift against the live client);
//                                                never writes coverage.json
//
// Builds and checks never need .sources: they read the committed coverage.json.
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, relative } from 'node:path';
import ts from 'typescript';
import {
  describeOfficialClient,
  discoverOfficialRequests,
  fetchOfficialClient,
} from './official-client.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const officialDirectory = resolve(root, '.sources/official');
const sources = JSON.parse(await readFile(resolve(root, 'sources.json'), 'utf8'));
const check = process.argv.includes('--check');

if (process.argv.includes('--fetch')) {
  const client = await fetchOfficialClient(officialDirectory);
  console.log(`Downloaded official web client bust ${client.bust} into .sources/official.`);
}

// Routes that appear in reference sources but are deliberately outside every contract; an
// `origin` limits an exclusion to the routes inventoried from that source.
const exclusions = [
  {
    method: 'get',
    path: '/assets/{path}',
    origin: 'openscreeps',
    reason:
      'OpenScreeps static asset extension (platformAsset) defined by the server api/extensions.json.',
  },
  {
    method: 'get',
    path: '/admin/status',
    reason:
      'OpenScreeps administration extension (adminStatus) defined by the server api/extensions.json.',
  },
  {
    method: 'post',
    path: '/admin',
    reason:
      'OpenScreeps administration extension (adminCommand) defined by the server api/extensions.json.',
  },
  {
    method: 'get',
    path: '/health',
    reason:
      'OpenScreeps health probe extension (platformHealth) defined by the server api/extensions.json.',
  },
  {
    method: 'get',
    path: '/',
    reason:
      'OpenScreeps landing page extension (platformRoot) defined by the server api/extensions.json.',
  },
];

const routes = [];
const literal = (node) => (node && ts.isStringLiteralLike(node) ? node.text : undefined);
function parse(file, text) {
  return ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
}
function record(source, file, node, method, path, origin) {
  const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
  routes.push({ origin, method, path, source: file, line });
}

// OpenScreeps server snapshot: NestJS controller decorators.
const httpDecorators = new Set(['Get', 'Post', 'Put', 'Patch', 'Delete', 'Head', 'Options']);
function decorator(node, name) {
  return (ts.canHaveDecorators(node) ? (ts.getDecorators(node) ?? []) : [])
    .map((entry) => entry.expression)
    .find((entry) => ts.isCallExpression(entry) && entry.expression.getText() === name);
}
for (const entry of (
  await readdir(resolve(root, '.sources/server/src'), { recursive: true })
).sort()) {
  if (!entry.endsWith('.ts')) continue;
  const file = resolve(root, '.sources/server/src', entry);
  const name = relative(root, file).replaceAll('\\', '/');
  const source = parse(file, await readFile(file, 'utf8'));
  const visit = (node) => {
    if (ts.isClassDeclaration(node)) {
      const controller = decorator(node, 'Controller');
      if (controller) {
        const prefix = literal(controller.arguments[0]) ?? '';
        for (const member of node.members) {
          for (const method of httpDecorators) {
            const route = decorator(member, method);
            if (!route) continue;
            const suffix = literal(route.arguments[0]) ?? '';
            const path = ('/' + [prefix, suffix].filter(Boolean).join('/')).replace(
              '{*path}',
              '{path}',
            );
            record(source, name, member, method.toLowerCase(), path, 'openscreeps');
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
}

// Community client (node-screeps-api): `this.req(method, path)` calls.
{
  const name = '.sources/client/src/ScreepsHttpClient.ts';
  const client = parse(name, await readFile(resolve(root, name), 'utf8'));
  const visit = (node) => {
    if (ts.isCallExpression(node) && node.expression.getText(client) === 'this.req') {
      const method = node.arguments[0]?.getText(client).split('.').at(-1)?.toLowerCase();
      const argument = node.arguments[1];
      let path = literal(argument);
      if (argument && ts.isTemplateExpression(argument)) {
        path = argument.head.text;
        for (const span of argument.templateSpans)
          path += '{' + span.expression.getText(client) + '}' + span.literal.text;
      }
      if (method && path?.startsWith('/'))
        record(client, name, node, method, path, 'community-client');
    }
    ts.forEachChild(node, visit);
  };
  visit(client);
}

// Official private server (screeps/backend-local): Express routers and their mount points.
{
  const mounts = {
    'lib/game/api/auth.js': '/api/auth',
    'lib/game/api/user.js': '/api/user',
    'lib/game/api/user-messages.js': '/api/user/messages',
    'lib/game/api/register.js': '/api/register',
    'lib/game/api/game.js': '/api/game',
    'lib/game/api/market.js': '/api/game/market',
    'lib/game/api/power-creeps.js': '/api/game/power-creeps',
    'lib/game/api/leaderboard.js': '/api/leaderboard',
    'lib/game/server.js': '',
  };
  for (const [file, prefix] of Object.entries(mounts)) {
    const name = `.sources/backend/${file}`;
    const source = parse(name, await readFile(resolve(root, name), 'utf8'));
    const visit = (node) => {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        ['get', 'post', 'use'].includes(node.expression.name.text)
      ) {
        const receiver = node.expression.expression.getText(source);
        const path = literal(node.arguments[0]);
        const method = node.expression.name.text;
        if (path?.startsWith('/') && node.arguments.length > 1) {
          if (receiver === 'router' && method !== 'use')
            record(source, name, node, method, prefix + path.replace(/\/$/, ''), 'backend-local');
          else if (receiver === 'config.backend.router' && method !== 'use')
            record(source, name, node, method, '/api' + path, 'backend-local');
          else if (receiver === 'app' && method === 'use' && path === '/room-history')
            record(source, name, node, 'get', path, 'backend-local');
          else if (receiver === 'app' && method === 'use' && path === '/assets')
            record(source, name, node, 'get', '/assets/{path}', 'backend-local');
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
}

routes.sort(
  (a, b) =>
    compare(a.path, b.path) ||
    compare(a.method, b.method) ||
    compare(a.origin, b.origin) ||
    compare(a.source, b.source) ||
    a.line - b.line,
);
const officialClient = await describeOfficialClient(officialDirectory);
const requests = (await discoverOfficialRequests(officialDirectory)).map((request) => ({
  method: request.method,
  path: request.path,
  query: request.query,
  body: request.body,
  ...(request.branch ? { branch: request.branch } : {}),
  via: request.via,
  responseFields: request.responseFields,
  source: `${officialClient.entry}${request.asset}?bust=${officialClient.bust}#L${request.line}C${request.column}`,
  ...(request.module ? { module: request.module } : {}),
}));
const inventory = {
  sources: { ...sources, officialClient },
  exclusions: exclusions.sort((a, b) => compare(a.path, b.path) || compare(a.method, b.method)),
  officialRequests: requests,
  routes,
};
const text = JSON.stringify(inventory, null, 2) + '\n';
if (check) {
  const committedText = await readFile(resolve(root, 'coverage.json'), 'utf8');
  if (committedText !== text) {
    const committed = JSON.parse(committedText);
    const keys = (list) => new Set(list.map((entry) => `${entry.method} ${entry.path}`));
    const before = keys([...committed.officialRequests, ...committed.routes]);
    const after = keys([...requests, ...routes]);
    const added = [...after].filter((key) => !before.has(key));
    const removed = [...before].filter((key) => !after.has(key));
    const assets = officialClient.assets
      .filter(
        (asset) =>
          committed.sources.officialClient?.assets.find((entry) => entry.path === asset.path)
            ?.sha256 !== asset.sha256,
      )
      .map((asset) => asset.path);
    throw new Error(
      [
        'coverage.json differs from the sources; review, then run node scripts/inventory.mjs.',
        `Official client bust ${committed.sources.officialClient?.bust} -> ${officialClient.bust}; changed assets: ${assets.join(', ') || 'none'}.`,
        `New routes: ${added.join(', ') || 'none'}.`,
        `Removed routes: ${removed.join(', ') || 'none'}.`,
        'Other differences are call-site positions, fields or provenance.',
      ].join('\n'),
    );
  }
} else {
  await writeFile(resolve(root, 'coverage.json'), text);
}
const unique = new Set(requests.map((request) => `${request.method} ${request.path}`));
console.log(
  `${check ? 'Verified' : 'Inventoried'} ${requests.length} official web client request sites (${unique.size} routes, bust ${officialClient.bust}) and ${routes.length} reference route declarations; ${exclusions.length} documented exclusions.`,
);

function compare(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}
