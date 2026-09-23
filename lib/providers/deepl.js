'use strict';

const { ProviderError } = require('../errors');

const NAME = 'deepl';
const LABEL = 'DeepL';

const apiKey = () => (process.env.DEEPL_API_KEY || '').trim();

// Les clés du plan gratuit se terminent par ":fx" et utilisent un autre domaine.
const endpoint = () => process.env.DEEPL_API_URL || (apiKey().endsWith(':fx') ? 'https://api-free.deepl.com/v2/translate' : 'https://api.deepl.com/v2/translate');

async function toError(res) {
  let detail = '';
  try {
    detail = (await res.json()).message || '';
  } catch { /* corps vide */ }
  const retryAfter = Number(res.headers.get('retry-after')) * 1000 || null;
  const opts = { provider: NAME, retryAfter };

  switch (res.status) {
    case 456:
      return new ProviderError('quota mensuel épuisé', { ...opts, code: 'quota' });
    case 429:
    case 529:
      return new ProviderError('trop de requêtes', { ...opts, code: 'rate' });
    case 401:
    case 403:
      return new ProviderError('clé API refusée', { ...opts, code: 'auth' });
    default:
      return new ProviderError(`erreur HTTP ${res.status}${detail ? ` (${detail})` : ''}`, { ...opts, code: res.status >= 500 ? 'network' : 'other' });
  }
}

module.exports = {
  name: NAME,
  label: LABEL,
  format: 'xml',
  isConfigured: () => apiKey().length > 0,
  supports: (target, source) => Boolean(target.deepl) && (!source || Boolean(source.deepl)),

  /** texts : chaînes déjà protégées (variables remplacées par <x>n</x>). */
  async translate(texts, { source, target }) {
    const body = {
      text: texts,
      target_lang: target.deepl,
      tag_handling: 'xml',
      ignore_tags: ['x'],
      preserve_formatting: true,
    };
    // DeepL n'accepte pas les variantes régionales comme langue source (EN-US → EN).
    if (source) body.source_lang = source.deepl.split('-')[0];

    let res;
    try {
      res = await fetch(endpoint(), {
        method: 'POST',
        headers: {
          Authorization: `DeepL-Auth-Key ${apiKey()}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (err) {
      throw new ProviderError(`injoignable (${err.message})`, { code: 'network', provider: NAME });
    }

    if (!res.ok) throw await toError(res);

    const data = await res.json();
    return data.translations.map((t) => t.text);
  },
};