'use strict';

const path = require('path');
const { ParseError } = require('../errors');
const { parseJson } = require('./json');
const { parseJs } = require('./js');

const SUPPORTED_EXTENSIONS = ['.json', '.js', '.cjs', '.mjs'];

function parseFile({ filename, buffer, ignoreKeys = [] }) {
  const ext = path.extname(filename).toLowerCase();
  const source = buffer.toString('utf8').replace(/^\uFEFF/, '');

  if (ext === '.json') return { format: 'json', ext, ...parseJson(source, { ignoreKeys }) };
  if (['.js', '.cjs', '.mjs'].includes(ext)) return { format: 'js', ext, ...parseJs(source, { ignoreKeys }) };

  throw new ParseError(`Format non pris en charge (${ext || 'sans extension'}). Envoyez un fichier .json ou .js.`);
}

module.exports = { parseFile, SUPPORTED_EXTENSIONS };