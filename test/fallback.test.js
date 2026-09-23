'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.DEEPL_API_KEY = 'test-key:fx';
process.env.GOOGLE_API_KEY = 'test-key';
process.env.PROVIDER_ORDER = 'deepl,google';
delete process.env.TRANSLATE_MOCK;

const providers = require('../lib/providers');
const { getLanguage } = require('../lib/languages');

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const calls = [];
const realFetch = globalThis.fetch;
let deeplBehaviour = 'quota';

globalThis.fetch = async (url, init) => {
  const body = JSON.parse(init.body);
  calls.push({ provider: String(url).includes('deepl') ? 'deepl' : 'google', url: String(url), body });

  if (String(url).includes('deepl.com')) {
    if (deeplBehaviour === 'quota') return json(456, { message: 'Quota Exceeded' });
    // « lose-variable » : DeepL renvoie la traduction mais en perdant la variable du 2e texte
    return json(200, { translations: body.text.map((t, i) => ({ text: i === 1 ? 'Sans variable' : `DE: ${t}` })) });
  }
  if (String(url).includes('translation.googleapis.com')) {
    // Google renvoie du HTML : apostrophes encodées en &#39;
    return json(200, { data: { translations: body.q.map((t) => ({ translatedText: `ES: ${t}`.replace(/'/g, '&#39;') })) } });
  }
  throw new Error(`URL inattendue : ${url}`);
};

test.after(() => { globalThis.fetch = realFetch; });

const es = getLanguage('es');
const fr = getLanguage('fr');

test('quota DeepL épuisé : bascule sur Google, variables et apostrophes intactes', async () => {
  const { results, providers: used } = await providers.translateBatch(["Bienvenue {user} & l'ami", 'Au revoir'], { source: fr, target: es });

  assert.deepEqual(results, ["ES: Bienvenue {user} & l'ami", 'ES: Au revoir']);
  assert.deepEqual([...used], ['Google']);

  const deepl = calls.find((c) => c.provider === 'deepl');
  assert.equal(deepl.url, 'https://api-free.deepl.com/v2/translate');
  assert.equal(deepl.body.target_lang, 'ES');
  assert.equal(deepl.body.source_lang, 'FR');
  assert.equal(deepl.body.tag_handling, 'xml');
  assert.deepEqual(deepl.body.ignore_tags, ['x']);
  assert.equal(deepl.body.text[0], "Bienvenue <x>0</x> &amp; l'ami");

  const google = calls.find((c) => c.provider === 'google');
  assert.equal(google.body.format, 'html');
  assert.equal(google.body.target, 'es');
});

test('après un quota épuisé, DeepL est mis en pause et n\'est plus appelé', async () => {
  assert.equal(providers.status().find((p) => p.name === 'deepl').state, 'paused');
  const before = calls.filter((c) => c.provider === 'deepl').length;
  await providers.translateBatch(['Bonjour'], { source: fr, target: es });
  assert.equal(calls.filter((c) => c.provider === 'deepl').length, before);
});

test('une variable perdue par un service : seul ce texte passe au service suivant', async () => {
  // On remet DeepL en service pour ce test (le module garde l'état en mémoire, on le contourne via une nouvelle instance).
  for (const key of Object.keys(require.cache)) {
    if (key.includes('/lib/providers/') || key.includes('/lib/placeholders')) delete require.cache[key];
  }
  const fresh = require('../lib/providers');
  deeplBehaviour = 'lose-variable';
  calls.length = 0;

  const { results, providers: used } = await fresh.translateBatch(['Salut', 'Bonjour {user}', 'Merci'], { source: fr, target: getLanguage('de') });

  assert.equal(results[0], 'DE: Salut');
  assert.equal(results[1], 'ES: Bonjour {user}'); // repris par Google (dont le faux préfixe est toujours « ES: »)
  assert.equal(results[2], 'DE: Merci');
  assert.deepEqual([...used].sort(), ['DeepL', 'Google']);

  const googleCall = calls.find((c) => c.provider === 'google');
  assert.deepEqual(googleCall.body.q, ['Bonjour <x>0</x>']);
});

test('langue non gérée par DeepL (hébreu) : Google directement', async () => {
  const fresh = require('../lib/providers');
  calls.length = 0;
  const { results } = await fresh.translateBatch(['Bonjour'], { source: fr, target: getLanguage('he') });
  assert.equal(results[0], 'ES: Bonjour');
  assert.deepEqual(calls.map((c) => c.provider), ['google']);
});