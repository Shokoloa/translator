'use strict';

const providers = require('./providers');
const { skipReason } = require('./placeholders');

// Cache en mémoire : un texte déjà traduit vers une langue ne consomme plus de quota.
const cache = new Map();
const CACHE_MAX_ENTRIES = 50_000;

const BATCH_MAX_ITEMS = 40;
const BATCH_MAX_CHARS = 8_000;

const cacheKey = (source, target, text) => `${source?.code ?? 'auto'}\u0000${target.code}\u0000${text}`;

function remember(key, value) {
  if (cache.size >= CACHE_MAX_ENTRIES) cache.delete(cache.keys().next().value);
  cache.set(key, value);
}

/** Textes uniques à traduire + avertissements pour ceux qu'on laisse volontairement de côté. */
function collectTexts(segments) {
  const texts = new Set();
  const skipped = [];
  for (const segment of segments) {
    const reason = skipReason(segment.text);
    if (!reason) texts.add(segment.text);
    else if (reason === 'icu') skipped.push({ path: segment.path, message: 'Message ICU (plural/select) non pris en charge : texte conservé tel quel.' });
  }
  return { texts: [...texts], skipped };
}

function* batches(texts, maxItems = BATCH_MAX_ITEMS) {
  let batch = [];
  let chars = 0;
  for (const text of texts) {
    if (batch.length && (batch.length >= maxItems || chars + text.length > BATCH_MAX_CHARS)) {
      yield batch;
      batch = [];
      chars = 0;
    }
    batch.push(text);
    chars += text.length;
  }
  if (batch.length) yield batch;
}

// Si aucune API n'est disponible (donc Puppeteer va être utilisé), on traduit un texte à la fois :
// Puppeteer les traite déjà un par un en interne, et ça permet d'écrire chaque clé sur disque dès
// qu'elle est prête plutôt que d'attendre un lot entier.
function effectiveBatchSize() {
  const list = providers.status();
  if (list.some((p) => ['deepl', 'google'].includes(p.name) && p.state === 'ready')) return BATCH_MAX_ITEMS;
  return list.some((p) => p.name === 'puppeteer' && p.state === 'ready') ? 1 : BATCH_MAX_ITEMS;
}

// Les services suppriment parfois les espaces autour du texte : on les remet comme à l'origine.
function splitWhitespace(text) {
  const [, lead, core, trail] = /^(\s*)([\s\S]*?)(\s*)$/.exec(text);
  return { lead, core, trail };
}

/**
 * Traduit `texts` vers `target`.
 * Renvoie { results: Map(texte -> traduction), failed: Set(textes non traduits), providers: Set(noms) }.
 */
async function translateTexts(texts, { source, target, onProgress = () => { }, onResult = () => { } }) {
  const results = new Map();
  const failed = new Set();
  const usedProviders = new Set();
  const pending = [];

  for (const text of texts) {
    const cached = cache.get(cacheKey(source, target, text));
    if (cached !== undefined) { results.set(text, cached); onResult(text, cached); }
    else pending.push(text);
  }
  onProgress(results.size);

  for (const batch of batches(pending, effectiveBatchSize())) {
    const parts = batch.map(splitWhitespace);
    let reported = 0;
    const { results: translated, providers: used } = await providers.translateBatch(parts.map((p) => p.core), { source, target, onItem: () => { reported++; onProgress(1); } });
    used.forEach((name) => usedProviders.add(name));

    batch.forEach((text, i) => {
      if (translated[i] == null) {
        failed.add(text);
        onResult(text, null);
        return;
      }
      const value = parts[i].lead + translated[i].trim() + parts[i].trail;
      results.set(text, value);
      remember(cacheKey(source, target, text), value);
      onResult(text, value);
    });
    // DeepL/Google ne rapportent rien via onItem (un seul appel HTTP par lot) :
    // on ajoute alors le reliquat d'un coup, comme avant.
    if (reported < batch.length) onProgress(batch.length - reported);
  }

  return { results, failed, providers: usedProviders };
}

module.exports = { collectTexts, translateTexts };