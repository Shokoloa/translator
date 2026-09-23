'use strict';

const acorn = require('acorn');
const { ParseError } = require('../errors');
const { makeIgnore } = require('./shared');

/**
 * Le fichier envoyé n'est JAMAIS exécuté : on l'analyse avec acorn, on repère les chaînes
 * dans l'objet exporté, puis on remplace leur texte directement dans le code source.
 * Résultat : commentaires, indentation, guillemets et ordre des clés restent identiques.
 */

function parseProgram(source) {
  const base = { ecmaVersion: 'latest', allowHashBang: true, allowReturnOutsideFunction: true };
  try {
    return acorn.parse(source, { ...base, sourceType: 'script' });
  } catch (scriptError) {
    try {
      return acorn.parse(source, { ...base, sourceType: 'module' });
    } catch {
      throw new ParseError(`JavaScript invalide : ${scriptError.message}`);
    }
  }
}

const isModuleExports = (node) => node?.type === 'MemberExpression' && !node.computed && node.object.type === 'Identifier' && node.object.name === 'module' && node.property.type === 'Identifier' && node.property.name === 'exports';
const isObjectFreeze = (node) => node?.type === 'MemberExpression' && !node.computed && node.object.type === 'Identifier' && node.object.name === 'Object' && node.property.type === 'Identifier' && node.property.name === 'freeze';

/** Trouve l'objet/tableau exporté : module.exports = …, export default …, ou un identifiant défini plus haut. */
function findExported(ast) {
  const topLevel = new Map();
  for (const statement of ast.body) {
    if (statement.type !== 'VariableDeclaration') continue;
    for (const declarator of statement.declarations) {
      if (declarator.id.type === 'Identifier' && declarator.init) topLevel.set(declarator.id.name, declarator.init);
    }
  }

  const unwrap = (node, depth = 0) => {
    if (!node || depth > 5) return null;
    if (node.type === 'ObjectExpression' || node.type === 'ArrayExpression') return node;
    if (node.type === 'Identifier') return unwrap(topLevel.get(node.name), depth + 1);
    if (node.type === 'CallExpression' && node.arguments.length === 1 && isObjectFreeze(node.callee)) return unwrap(node.arguments[0], depth + 1);
    return null;
  };

  for (const statement of ast.body) {
    let value = null;
    if (statement.type === 'ExpressionStatement' && statement.expression.type === 'AssignmentExpression' && statement.expression.operator === '=' && isModuleExports(statement.expression.left)) value = statement.expression.right;
    else if (statement.type === 'ExportDefaultDeclaration') value = statement.declaration;
    const found = value && unwrap(value);
    if (found) return found;
  }
  return null;
}

function encodeString(value, quote) {
  const json = JSON.stringify(value).slice(1, -1); // échappe \ " \n etc.
  if (quote === '"') return `"${json}"`;
  return `'${json.replace(/\\"/g, '"').replace(/'/g, "\\'")}'`;
}

function encode(value, loc) {
  switch (loc.kind) {
    case 'string':
      return encodeString(value, loc.quote);
    case 'template':
      return `\`${value.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${')}\``;
    case 'template-expr': // le texte contient des ${…} déjà protégés, on ne les échappe pas
      return `\`${value.replace(/\\/g, '\\\\').replace(/`/g, '\\`')}\``;
    default:
      return value;
  }
}

function parseJs(source, { ignoreKeys = [] } = {}) {
  const ast = parseProgram(source);
  const root = findExported(ast);
  if (!root) throw new ParseError("Aucun `module.exports = { … }` (ni `export default { … }`) contenant un objet ou un tableau n'a été trouvé.",);

  const ignored = makeIgnore(ignoreKeys);
  const segments = [];

  const add = (node, text, kind, path) => segments.push({ id: segments.length, text, path: path.join('.'), loc: { start: node.start, end: node.end, kind, quote: source[node.start] } })

  const visit = (node, path) => {
    switch (node.type) {
      case 'Literal':
        if (typeof node.value === 'string') add(node, node.value, 'string', path);
        break;
      case 'TemplateLiteral': {
        if (node.expressions.length === 0) {
          const quasi = node.quasis[0].value;
          add(node, quasi.cooked ?? quasi.raw, 'template', path);
          break;
        }
        // `Bonjour ${user}` : on ne le traite que si les expressions sont simples
        // et si le texte ne contient ni antislash ni accent grave imbriqué.
        const raw = source.slice(node.start + 1, node.end - 1);
        const simple = node.expressions.every((e) => !/[{}`]/.test(source.slice(e.start, e.end)));
        if (simple && !/[\\`]/.test(raw)) add(node, raw, 'template-expr', path);
        break;
      }
      case 'ObjectExpression':
        for (const prop of node.properties) {
          if (prop.type !== 'Property' || prop.kind !== 'init') continue;
          const key = prop.computed ? '[computed]' : prop.key.type === 'Identifier' ? prop.key.name : String(prop.key.value);
          const childPath = [...path, key];
          if (ignored(key, childPath.join('.'))) continue;
          visit(prop.value, childPath);
        }
        break;
      case 'ArrayExpression':
        node.elements.forEach((element, i) => {
          if (element && element.type !== 'SpreadElement') visit(element, [...path, i]);
        });
        break;
      case 'ArrowFunctionExpression':
        // (name) => `Bienvenue ${name}` : on traite le corps, mais jamais les fonctions à bloc { … }
        if (node.expression) visit(node.body, path);
        break;
      default:
        break;
    }
  };
  visit(root, []);

  const rebuild = (get) => {
    const edits = segments
      .map((segment) => ({ segment, value: get(segment) }))
      .filter((edit) => edit.value != null)
      .sort((a, b) => b.segment.loc.start - a.segment.loc.start); // de la fin vers le début

    let out = source;
    for (const { segment, value } of edits) {
      out = out.slice(0, segment.loc.start) + encode(value, segment.loc) + out.slice(segment.loc.end);
    }
    return out;
  };

  return { segments, rebuild };
}

module.exports = { parseJs };