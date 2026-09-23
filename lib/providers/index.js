'use strict';

const { ProviderError } = require('../errors');
const { protect, restore } = require('../placeholders');

const REGISTRY = {
    deepl: require('./deepl'),
    google: require('./google'),
    puppeteer: require('./puppeteer'),
    mock: require('./mock'),
};

const pausedUntil = new Map(); // nom du service -> timestamp de reprise
const HOUR = 60 * 60 * 1000;

/** Ordre des services : PROVIDER_ORDER (défaut : deepl,google,puppeteer). TRANSLATE_MOCK=1 les remplace par la simulation. */
function chain() {
    if (process.env.TRANSLATE_MOCK === '1') return [REGISTRY.mock];
    return (process.env.PROVIDER_ORDER || 'deepl,google,puppeteer')
        .split(',')
        .map((name) => REGISTRY[name.trim()])
        .filter(Boolean);
}

const isPaused = (provider) => (pausedUntil.get(provider.name) ?? 0) > Date.now();
const pause = (provider, ms) => pausedUntil.set(provider.name, Date.now() + ms);

const hasConfiguredProvider = () => chain().some((provider) => provider.isConfigured());

/** État affiché dans l'interface : 'ready' | 'paused' | 'off' */
function status() {
    return chain().map((provider) => ({
        name: provider.name,
        label: provider.label,
        state: !provider.isConfigured() ? 'off' : isPaused(provider) ? 'paused' : 'ready',
    }));
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Réessaie (2 fois max) quand le service dit « trop vite » ou en cas de coupure réseau.
async function withRetry(fn) {
    for (let attempt = 0; ; attempt++) {
        try {
            return await fn();
        } catch (err) {
            const retryable = err instanceof ProviderError && (err.code === 'rate' || err.code === 'network');
            if (!retryable || attempt >= 2) throw err;
            await sleep(Math.min(err.retryAfter ?? 1000 * 2 ** attempt, 10_000));
        }
    }
}

function onFailure(provider, err, errors) {
    const code = err.code ?? 'other';
    errors.push(`${provider.label} : ${err.message}`);
    console.warn(`[traduction] ${provider.label} a échoué (${code}) : ${err.message}`);

    if (code === 'quota') pause(provider, HOUR);
    else if (code === 'auth' || code === 'config') pause(provider, 24 * HOUR);
    else if (code === 'rate') pause(provider, 30_000);
}

/**
 * Traduit une liste de textes bruts. Essaie chaque service dans l'ordre ; si un service échoue
 * (quota, clé, réseau…) ou perd une variable dans un texte, les textes restants passent au suivant.
 *
 * Renvoie { results, providers } : results[i] est la traduction, ou null si aucun service n'a réussi.
 * Lève une erreur uniquement si aucun service n'a pu répondre du tout.
 */
async function translateBatch(texts, { source, target }) {
    const results = new Array(texts.length).fill(null);
    let pending = texts.map((_, i) => i);
    const used = new Set();
    const errors = [];
    let anyResponse = false;

    for (const provider of chain()) {
        if (pending.length === 0) break;
        if (!provider.isConfigured() || isPaused(provider)) continue;
        if (!provider.supports(target, source)) {
            errors.push(`${provider.label} ne gère pas cette langue`);
            continue;
        }

        const prepared = pending.map((i) => protect(texts[i], provider.format));

        try {
            const translated = await withRetry(() =>
                provider.translate(prepared.map((p) => p.text), { source, target }),
            );
            if (!Array.isArray(translated) || translated.length !== prepared.length) {
                throw new ProviderError('réponse inattendue', { provider: provider.name });
            }
            anyResponse = true;

            const stillPending = [];
            pending.forEach((textIndex, k) => {
                const { text, ok } = restore(String(translated[k] ?? ''), prepared[k].tokens, provider.format);
                if (ok && text.trim()) results[textIndex] = text;
                else stillPending.push(textIndex);
            });
            if (stillPending.length < pending.length) used.add(provider.label);
            pending = stillPending;
        } catch (err) {
            onFailure(provider, err, errors);
        }
    }

    if (!anyResponse) throw new Error(errors.length ? `Aucun service de traduction n'a répondu (${errors.join(' ; ')}).` : "Aucun service de traduction n'est disponible pour cette langue.");
    return { results, providers: used };
}

async function closeAll() {
    await REGISTRY.puppeteer.closeBrowser();
}

module.exports = { translateBatch, status, hasConfiguredProvider, closeAll };