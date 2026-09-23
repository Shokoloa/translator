'use strict';

const { ParseError } = require('../errors');
const { makeIgnore } = require('./shared');

/**
 * Renvoie { segments, rebuild }.
 *  - segments : [{ id, text, path, loc }] pour chaque chaîne du fichier (les clés ne sont jamais traduites)
 *  - rebuild(get) : produit le fichier final, get(segment) renvoie la traduction (ou undefined pour garder l'original)
 */
function parseJson(source, { ignoreKeys = [] } = {}) {
  let data;
  try {
    data = JSON.parse(source);
  } catch (err) {
    throw new ParseError(`JSON invalide : ${err.message}`);
  }

  const ignored = makeIgnore(ignoreKeys);
  const segments = [];

  const visit = (node, loc) => {
    if (typeof node === 'string') segments.push({ id: segments.length, text: node, path: loc.join('.'), loc });
    else if (Array.isArray(node)) node.forEach((child, i) => visit(child, [...loc, i]));
    else if (node && typeof node === 'object') {
      for (const [key, child] of Object.entries(node)) {
        if (key === '__proto__') continue;
        const childLoc = [...loc, key];
        if (ignored(key, childLoc.join('.'))) continue;
        visit(child, childLoc);
      }
    }
  };
  visit(data, []);

  // On garde l'indentation d'origine (tabulations, 2 ou 4 espaces, ou fichier minifié).
  const indentMatch = /^([ \t]+)\S/m.exec(source);
  const indent = source.includes('\n') ? (indentMatch ? indentMatch[1] : 2) : 0;
  const trailingNewline = source.endsWith('\n') ? '\n' : '';

  const rebuild = (get) => {
    const copy = structuredClone(data);
    let root = copy;

    for (const segment of segments) {
      const value = get(segment);
      if (value == null) continue;
      if (segment.loc.length === 0) {
        root = value;
        continue;
      }
      let target = copy;
      for (const key of segment.loc.slice(0, -1)) target = target[key];
      target[segment.loc[segment.loc.length - 1]] = value;
    }

    return JSON.stringify(root, null, indent) + trailingNewline;
  };

  return { segments, rebuild };
}

module.exports = { parseJson };