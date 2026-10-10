import { readFile, readdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, relative } from 'node:path';
import ts from 'typescript';

const root = fileURLToPath(new URL('../', import.meta.url));
const sources = JSON.parse(await readFile(resolve(root, 'sources.json'), 'utf8'));
const routes = [];
const exclusions = [
  {
    method: 'get',
    path: '/api/authmod',
    reason:
      'Private-server authentication-mod extension; official client synthesizes its result without an HTTP request, and OpenScreeps does not implement it.',
  },
  {
    method: 'get',
    path: '/api/warpath/battles',
    reason:
      'Client explicitly documents this third-party extension as unavailable on official servers; OpenScreeps does not implement it either.',
  },
];
const methods = new Set(['Get', 'Post', 'Put', 'Patch', 'Delete', 'Head', 'Options']);
const literal = (node) => (node && ts.isStringLiteralLike(node) ? node.text : undefined);
function decorator(node, name) {
  return (ts.canHaveDecorators(node) ? (ts.getDecorators(node) ?? []) : [])
    .map((entry) => entry.expression)
    .find((entry) => ts.isCallExpression(entry) && entry.expression.getText() === name);
}
function record(source, file, node, method, path) {
  const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
  routes.push({ method, path, source: file, line });
}
for (const entry of await readdir(resolve(root, '.sources/server/src'), { recursive: true })) {
  if (!entry.endsWith('.ts')) continue;
  const file = resolve(root, '.sources/server/src', entry);
  const source = ts.createSourceFile(
    file,
    await readFile(file, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
  function visit(node) {
    if (ts.isClassDeclaration(node)) {
      const controller = decorator(node, 'Controller');
      if (controller) {
        const prefix = literal(controller.arguments[0]) ?? '';
        for (const member of node.members) {
          for (const method of methods) {
            const route = decorator(member, method);
            if (!route) continue;
            const suffix = literal(route.arguments[0]) ?? '';
            const path = ('/' + [prefix, suffix].filter(Boolean).join('/')).replace(
              '{*path}',
              '{path}',
            );
            record(
              source,
              relative(root, file).replaceAll('\\', '/'),
              member,
              method.toLowerCase(),
              path,
            );
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
}
const clientFile = '.sources/client/src/ScreepsHttpClient.ts';
const client = ts.createSourceFile(
  clientFile,
  await readFile(resolve(root, clientFile), 'utf8'),
  ts.ScriptTarget.Latest,
  true,
);
function visitClient(node) {
  if (ts.isCallExpression(node) && node.expression.getText(client) === 'this.req') {
    const method = node.arguments[0]?.getText(client).split('.').at(-1)?.toLowerCase();
    const argument = node.arguments[1];
    let path = literal(argument);
    if (argument && ts.isTemplateExpression(argument)) {
      path = argument.head.text;
      for (const span of argument.templateSpans)
        path += '{' + span.expression.getText(client) + '}' + span.literal.text;
    }
    if (method && path?.startsWith('/')) record(client, clientFile, node, method, path);
  }
  ts.forEachChild(node, visitClient);
}
visitClient(client);
routes.sort(
  (a, b) =>
    a.path.localeCompare(b.path) ||
    a.method.localeCompare(b.method) ||
    a.source.localeCompare(b.source),
);
const inventory = { sources, exclusions, routes };
const text = JSON.stringify(inventory, null, 2) + '\n';
if (process.argv.includes('--check')) {
  if ((await readFile(resolve(root, 'coverage.json'), 'utf8')) !== text)
    throw new Error('coverage.json differs from pinned source routes');
} else {
  await writeFile(resolve(root, 'coverage.json'), text);
}
console.log(
  `Inventoried ${routes.length} source route declarations; ${exclusions.length} explicit target-scope exclusion.`,
);
