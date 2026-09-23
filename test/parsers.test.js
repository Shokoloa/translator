'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');

const { parseFile } = require('../lib/parsers');
const { ParseError } = require('../lib/errors');

const upper = (segment) => segment.text.toUpperCase();

test('JSON : traduit les valeurs, jamais les clés, garde l\'indentation', () => {
  const source = '{\n\t"hello": "Bonjour",\n\t"nested": { "list": ["a", "b"], "n": 3 }\n}\n';
  const parsed = parseFile({ filename: 'fr.json', buffer: Buffer.from(source) });

  assert.deepEqual(parsed.segments.map((s) => s.path), ['hello', 'nested.list.0', 'nested.list.1']);

  const out = parsed.rebuild(upper);
  assert.deepEqual(JSON.parse(out), { hello: 'BONJOUR', nested: { list: ['A', 'B'], n: 3 } });
  assert.ok(out.startsWith('{\n\t"hello"'), 'tabulations conservées');
  assert.ok(out.endsWith('\n'), 'saut de ligne final conservé');
});

test('JSON : clés ignorées (nom et chemin complet)', () => {
  const source = JSON.stringify({ id: 'abc', title: 'Titre', meta: { version: 'v1', note: 'Note' } });
  const parsed = parseFile({ filename: 'x.json', buffer: Buffer.from(source), ignoreKeys: ['id', 'meta.version'] });
  assert.deepEqual(parsed.segments.map((s) => s.path), ['title', 'meta.note']);
});

test('JSON invalide : erreur explicite', () => {
  assert.throws(() => parseFile({ filename: 'x.json', buffer: Buffer.from('{oops') }), ParseError);
});

test('JS : module.exports, commentaires et guillemets conservés', () => {
  const source = `// Textes du bot
module.exports = {
  greeting: 'Salut l\\'ami',   // apostrophe échappée
  "farewell": "Au revoir",
  tpl: \`Ligne\`,
  count: 42,
  list: ['un', "deux"],
};
`;
  const parsed = parseFile({ filename: 'fr.js', buffer: Buffer.from(source) });
  assert.deepEqual(parsed.segments.map((s) => s.path), ['greeting', 'farewell', 'tpl', 'list.0', 'list.1']);

  const out = parsed.rebuild((s) => `[en] ${s.text}`);
  assert.ok(out.startsWith('// Textes du bot\n'));
  assert.ok(out.includes("greeting: '[en] Salut l\\'ami',   // apostrophe échappée"));
  assert.ok(out.includes('"farewell": "[en] Au revoir"'));
  assert.ok(out.includes('count: 42'));

  // Le résultat reste du JavaScript valide, avec les bonnes valeurs.
  const sandbox = { module: { exports: {} } };
  vm.runInNewContext(out, sandbox);
  assert.equal(sandbox.module.exports.greeting, "[en] Salut l'ami");
  assert.deepEqual(Array.from(sandbox.module.exports.list), ['[en] un', '[en] deux']);
});

test('JS : identifiant, Object.freeze, export default et fonctions fléchées', () => {
  const viaIdentifier = parseFile({
    filename: 'a.js',
    buffer: Buffer.from("const t = { a: 'Un' };\nmodule.exports = Object.freeze(t);\n"),
  });
  assert.deepEqual(viaIdentifier.segments.map((s) => s.path), ['a']);

  const esm = parseFile({ filename: 'b.mjs', buffer: Buffer.from("export default { a: 'Un' };\n") });
  assert.deepEqual(esm.segments.map((s) => s.path), ['a']);

  const arrows = parseFile({
    filename: 'c.js',
    buffer: Buffer.from("module.exports = { hi: (n) => `Salut ${n}`, bye: (n) => { return 'Non'; } };\n"),
  });
  assert.deepEqual(arrows.segments.map((s) => [s.path, s.text]), [['hi', 'Salut ${n}']]);
  assert.equal(arrows.rebuild(() => 'Hello ${n}'), "module.exports = { hi: (n) => `Hello ${n}`, bye: (n) => { return 'Non'; } };\n");
});

test('JS : le fichier envoyé n\'est jamais exécuté', () => {
  globalThis.__pwned = false;
  const source = "globalThis.__pwned = true;\nmodule.exports = { a: 'Un' };\n";
  parseFile({ filename: 'evil.js', buffer: Buffer.from(source) }).rebuild(upper);
  assert.equal(globalThis.__pwned, false);
});

test('JS sans export exploitable : erreur explicite', () => {
  assert.throws(() => parseFile({ filename: 'x.js', buffer: Buffer.from('const a = 1;') }), ParseError);
  assert.throws(() => parseFile({ filename: 'x.js', buffer: Buffer.from('module.exports = ;') }), ParseError);
});

test('Extension non supportée', () => {
  assert.throws(() => parseFile({ filename: 'x.yaml', buffer: Buffer.from('a: b') }), ParseError);
});