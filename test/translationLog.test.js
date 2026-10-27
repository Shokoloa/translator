'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const logPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tlog-')), 'translation-errors.log');
process.env.TRANSLATION_LOG_PATH = logPath;
process.env.JOBS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'jobs-'));
process.env.DEEPL_API_KEY = 'test-key:fx';
process.env.PROVIDER_ORDER = 'deepl';
delete process.env.TRANSLATE_MOCK;

const { parseFile } = require('../lib/parsers');
const { collectTexts, translateTexts } = require('../lib/translator');
const jobs = require('../lib/jobs');
const { getLanguage } = require('../lib/languages');

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const realFetch = globalThis.fetch;
test.after(() => { globalThis.fetch = realFetch; });

const fr = getLanguage('fr');
const es = getLanguage('es');

test('une clé dont la variable est perdue est écrite dans le journal avec sa clé et sa langue', async () => {
    // DeepL « perd » la variable du texte qui en contient une
    globalThis.fetch = async (url, init) => {
        const { text } = JSON.parse(init.body);
        return json(200, { translations: text.map((t) => ({ text: t.includes('<x>') ? 'Sans variable' : `ES: ${t}` })) });
    };

    const parsed = parseFile({ filename: 'fr.json', buffer: Buffer.from(JSON.stringify({ ok: 'Bonjour', nested: { broken: 'Salut {user}' } })) });
    const { texts, skipped } = collectTexts(parsed.segments);
    const job = jobs.createJob({ parsed, texts, skipped, source: fr, targets: [es], filename: 'fr.json', naming: 'lang' });
    while (job.status === 'running') await new Promise((r) => setTimeout(r, 20));

    assert.equal(job.status, 'done');
    const log = fs.readFileSync(logPath, 'utf8');
    assert.match(log, /lang=es clé="nested\.broken" ->/);
    assert.doesNotMatch(log, /clé="ok"/);
    assert.equal(job.warnings.length, 1);
    assert.equal(job.warnings[0].path, 'nested.broken');
});

test('quota épuisé en cours de route : le travail déjà fait est conservé, le reste est signalé', async () => {
    let calls = 0;
    globalThis.fetch = async (url, init) => {
        const { text } = JSON.parse(init.body);
        return ++calls === 1 ? json(200, { translations: text.map((t) => ({ text: `ES: ${t}` })) }) : json(456, { message: 'Quota Exceeded' });
    };
    // 41 textes uniques = 2 lots (40 max par lot) : le 1er réussit, le 2e tombe sur le quota
    const many = Array.from({ length: 41 }, (_, i) => `Texte numéro ${i}`);
    const { results, failed, reasons } = await translateTexts(many, { source: fr, target: es });

    assert.equal(results.size, 40);
    assert.deepEqual([...failed], ['Texte numéro 40']);
    assert.match(reasons.get('Texte numéro 40'), /quota/);
});

test('rien traduit du tout : l\'erreur remonte (pas de fichier vide présenté comme un succès)', async () => {
    globalThis.fetch = async () => json(401, {});
    await assert.rejects(() => translateTexts(['Autre texte jamais traduit'], { source: fr, target: getLanguage('de') }), /Aucun service de traduction/);
});