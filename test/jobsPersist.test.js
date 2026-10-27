'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.TRANSLATE_MOCK = '1';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jobs-persist-'));
process.env.JOBS_DIR = dir;

const load = () => {
    for (const key of Object.keys(require.cache)) if (key.includes(`${path.sep}lib${path.sep}jobs`)) delete require.cache[key];
    return require('../lib/jobs');
};
const { parseFile } = require('../lib/parsers');
const { collectTexts } = require('../lib/translator');
const { getLanguage } = require('../lib/languages');

const wait = async (jobs, id) => { while (jobs.getJob(id).status === 'running') await new Promise((r) => setTimeout(r, 10)); await jobs.getJob(id).saving; };

test('une traduction terminée est retrouvée après un redémarrage du serveur', async () => {
    let jobs = load();
    const parsed = parseFile({ filename: 'fr.json', buffer: Buffer.from('{"a":"Bonjour"}') });
    const { texts, skipped } = collectTexts(parsed.segments);
    const job = jobs.createJob({ parsed, texts, skipped, source: getLanguage('fr'), targets: [getLanguage('es'), getLanguage('de')], filename: 'fr.json', naming: 'lang' });
    await wait(jobs, job.id);

    jobs = load(); // « redémarrage » : la mémoire est vide, le disque non
    const restored = jobs.getJob(job.id);
    assert.equal(restored.status, 'done');
    assert.deepEqual(restored.files.map((f) => f.lang).sort(), ['de', 'es']);
    assert.match(restored.files.find((f) => f.lang === 'es').buffer.toString(), /\[es\] Bonjour/);
    assert.equal(jobs.toPublic(restored).canSaveAsProject, true);
});

test('un job interrompu en pleine traduction garde ses langues finies et signale les autres', async () => {
    const jobs0 = load();
    const parsed = parseFile({ filename: 'fr.json', buffer: Buffer.from('{"a":"Bonjour"}') });
    const id = 'interrompu-1';
    const d = path.join(dir, id);
    fs.mkdirSync(path.join(d, 'files'), { recursive: true });
    fs.writeFileSync(path.join(d, 'input.json'), parsed.rebuild(() => null));
    fs.writeFileSync(path.join(d, 'files', 'es.json'), '{"a":"Hola"}');
    fs.writeFileSync(path.join(d, 'job.json'), JSON.stringify({
        id, base: 'fr', ext: '.json', status: 'running', createdAt: Date.now(), finishedAt: null, total: 2,
        sourceCode: 'fr', targetCodes: ['es', 'de'], ignoreKeys: [],
        files: [{ lang: 'es', label: 'Español', name: 'es.json', providers: ['DeepL'] }], warnings: [], errors: [],
    }));

    const jobs = load();
    const restored = jobs.getJob(id);
    assert.equal(restored.status, 'done');
    assert.equal(restored.files.length, 1);
    assert.equal(restored.errors.length, 1);
    assert.equal(restored.errors[0].lang, 'de');
    assert.match(restored.errors[0].message, /redémarrage/);
    void jobs0;
});

test('un job illisible ou périmé est ignoré sans empêcher le démarrage', () => {
    fs.mkdirSync(path.join(dir, 'casse'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'casse', 'job.json'), '{pas du json');
    assert.doesNotThrow(load);
    assert.equal(load().getJob('casse'), null);
});