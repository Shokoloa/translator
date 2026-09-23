'use strict';

const { ProviderError } = require('../errors');

const NAME = 'google';
const LABEL = 'Google';
const ENDPOINT = 'https://translation.googleapis.com/language/translate/v2';

const apiKey = () => (process.env.GOOGLE_API_KEY || '').trim();

async function toError(res) {
  let message = '';
  try {
    message = (await res.json()).error?.message || '';
  } catch { /* corps vide */ }
  const retryAfter = Number(res.headers.get('retry-after')) * 1000 || null;
  const opts = { provider: NAME, retryAfter };

  if (res.status === 429) return new ProviderError('trop de requêtes', { ...opts, code: 'rate' });
  if (res.status === 403 && /quota|limit/i.test(message)) return new ProviderError('quota épuisé', { ...opts, code: 'quota' });
  if (res.status === 403 || (res.status === 400 && /api key/i.test(message))) return new ProviderError(`clé API refusée${message ? ` (${message})` : ''}`, { ...opts, code: 'auth' });
  return new ProviderError(`erreur HTTP ${res.status}${message ? ` (${message})` : ''}`, { ...opts, code: res.status >= 500 ? 'network' : 'other' });
}

module.exports = {
  name: NAME,
  label: LABEL,
  format: 'xml',
  isConfigured: () => apiKey().length > 0,
  supports: (target) => Boolean(target.google),

  async translate(texts, { source, target }) {
    const body = { q: texts, target: target.google, format: 'html' };
    if (source) body.source = source.google;

    let res;
    try {
      res = await fetch(`${ENDPOINT}?key=${encodeURIComponent(apiKey())}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (err) {
      throw new ProviderError(`injoignable (${err.message})`, { code: 'network', provider: NAME });
    }

    if (!res.ok) throw await toError(res);

    const data = await res.json();
    return data.data.translations.map((t) => t.translatedText);
  },
};