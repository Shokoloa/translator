'use strict';

/**
 * Tout ce qui correspond à ces motifs est remplacé par un jeton avant l'envoi
 * au service de traduction, puis remis à sa place ensuite.
 */
const PATTERNS = [
  /<a?:\w+:\d+>/,                                        // emoji Discord personnalisé  <:nom:123>
  /<(?:@[!&]?|#)\d+>/,                                   // mentions Discord  <@123> <@&123> <#123>
  /<t:-?\d+(?::[a-zA-Z])?>/,                             // timestamp Discord  <t:1700000000:R>
  /<\/?[a-zA-Z][^<>]*>/,                                 // balises HTML
  /\$\{[^}]*\}/,                                         // ${variable}
  /\{\{[^}]*\}\}/,                                       // {{variable}}
  /\{[^{}]*\}/,                                          // {variable}
  /%(?:\d+\$)?[-+0#]*\d*(?:\.\d+)?[sdifoxXeEgGcu](?![A-Za-z])/, // printf : %s %d %1$s %.2f
  /%%/,                                                  // % littéral
  /:[a-zA-Z_][a-zA-Z0-9_]*:/,                            // :emoji_shortcode:
];

const PLACEHOLDER_RE = new RegExp(PATTERNS.map((p) => `(?:${p.source})`).join('|'), 'g');

const escapeXml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const NAMED_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00A0' };

function decodeEntities(s) {
  return s.replace(/&(#[xX][0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (match, entity) => {
    if (entity[0] === '#') {
      const hex = entity[1] === 'x' || entity[1] === 'X';
      const cp = parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10);
      return Number.isInteger(cp) && cp >= 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : match;
    }
    return NAMED_ENTITIES[entity] ?? match;
  });
}

/**
 * Deux formats de jetons, selon ce que le service sait préserver :
 *  - 'xml'   : <x>0</x> (DeepL avec ignore_tags, Google en mode HTML). Le texte est échappé.
 *  - 'plain' : [[0]] (interface web de Google Traduction, qui ne connaît pas le HTML)
 */
const MARK = {
  xml: (i) => `<x>${i}</x>`,
  plain: (i) => `[[${i}]]`,
};

const TOKEN_RE = {
  xml: /<\s*x\s*>\s*(\d+)\s*<\s*\/\s*x\s*>/gi,
  plain: /\[\[\s*(\d+)\s*\]\]/g,
};

function protect(text, format = 'xml') {
  const escape = format === 'xml' ? escapeXml : (s) => s;
  const tokens = [];
  let out = '';
  let last = 0;

  for (const match of text.matchAll(PLACEHOLDER_RE)) {
    out += escape(text.slice(last, match.index)) + MARK[format](tokens.length);
    tokens.push(match[0]);
    last = match.index + match[0].length;
  }
  out += escape(text.slice(last));

  return { text: out, tokens };
}

/** Remet les variables d'origine. `ok` est faux si le service en a perdu une. */
function restore(translated, tokens, format = 'xml') {
  const decode = format === 'xml' ? decodeEntities : (s) => s;
  const seen = new Set();
  let out = '';
  let last = 0;

  for (const match of translated.matchAll(TOKEN_RE[format])) {
    out += decode(translated.slice(last, match.index));
    const i = Number(match[1]);
    if (i < tokens.length) {
      out += tokens[i];
      seen.add(i);
    }
    last = match.index + match[0].length;
  }
  out += decode(translated.slice(last));

  return { text: out, ok: seen.size === tokens.length };
}

const URL_RE = /^(?:https?:\/\/|www\.)\S+$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const HEX_COLOR_RE = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const IDENTIFIER_RE = /^[A-Za-z0-9]+(?:[._][A-Za-z0-9]+)+$/;        // GUILD_TEXT, user.name, file.txt
const ICU_RE = /\{[^{}]+,\s*(?:plural|select|selectordinal)\s*,/;   // {n, plural, one {…} other {…}}

/**
 * Renvoie null si le texte doit être traduit, sinon la raison de l'exclusion :
 * 'empty' | 'technical' | 'no-text' | 'icu'
 */
function skipReason(text) {
  const t = text.trim();
  if (!t) return 'empty';
  if (ICU_RE.test(t)) return 'icu';
  if (URL_RE.test(t) || EMAIL_RE.test(t) || HEX_COLOR_RE.test(t) || IDENTIFIER_RE.test(t)) return 'technical';
  if (!/\p{L}/u.test(t.replace(PLACEHOLDER_RE, ''))) return 'no-text';
  return null;
}

module.exports = { protect, restore, skipReason, decodeEntities };