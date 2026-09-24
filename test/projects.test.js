'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

process.env.TRANSLATE_MOCK = '1';

let dataDir;
test.beforeEach(async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'projects-test-'));
    process.env.PROJECTS_DIR = dataDir;
    for (const key of Object.keys(require.cache)) {
        if (key.includes('/lib/projects')) delete require.cache[key];
    }
});
test.afterEach(async () => {
    await fs.rm(dataDir, { recursive: true, force: true });
});

const { parseFile } = require('../lib/parsers');
const { collectTexts, translateTexts } = require('../lib/translator');
const { getLanguage } = require('../lib/languages');
const { UserError } = require('../lib/errors');

async function makeJob(filename, source, targetsCodes, { ignoreKeys = [] } = {}) {
    const parsed = parseFile({ filename, buffer: Buffer.from(source), ignoreKeys });
    const { texts } = collectTexts(parsed.segments);
    const fr = getLanguage('fr');
    const files = [];
    for (const code of targetsCodes) {
        const target = getLanguage(code);
        const { results } = await translateTexts(texts, { source: fr, target });
        files.push({ lang: code, buffer: Buffer.from(parsed.rebuild((s) => results.get(s.text))) });
    }
    return { status: 'done', parsed, source: fr, ignoreKeys, files };
}

test('JSON : création, ajout de clés imbriquées, conflit refusé', async () => {
    const projects = require('../lib/projects');
    const job = await makeJob('fr.json', JSON.stringify({ welcome: 'Bienvenue {user} !', nested: { a: 'Un' } }), ['en', 'es']);
    const meta = await projects.createFromJob(job, { name: 'Test' });

    const result = await projects.addKeys(meta.id, JSON.stringify({ farewell: 'Au revoir', nested: { b: 'Deux' } }));
    assert.deepEqual(result.addedKeys.sort(), ['farewell', 'nested.b']);

    const { files } = await projects.getProject(meta.id);
    const en = JSON.parse(files.en);
    assert.equal(en.welcome, '[en] Bienvenue {user} !'); // jamais retraduit
    assert.equal(en.nested.a, '[en] Un');                 // clé existante préservée
    assert.equal(en.nested.b, '[en] Deux');                // nouvelle clé imbriquée fusionnée
    assert.equal(en.farewell, '[en] Au revoir');

    await assert.rejects(
        () => projects.addKeys(meta.id, JSON.stringify({ farewell: 'Bye again' })),
        (err) => err instanceof UserError && err.status === 409,
    );
});

test('JS : création, ajout de clé plate, imbrication refusée', async () => {
    const projects = require('../lib/projects');
    const source = "module.exports = {\n  greeting: (n) => `Salut ${n}`,\n  farewell: 'Bye',\n};\n";
    const job = await makeJob('fr.js', source, ['en']);
    const meta = await projects.createFromJob(job, { name: 'Bot' });

    await projects.addKeys(meta.id, JSON.stringify({ thanks: "Merci l'ami" }));
    const { files } = await projects.getProject(meta.id);

    const sandbox = { module: { exports: {} } };
    vm.runInNewContext(files.en, sandbox);
    assert.equal(sandbox.module.exports.thanks, "[en] Merci l'ami");
    assert.equal(sandbox.module.exports.farewell, '[en] Bye');
    assert.equal(sandbox.module.exports.greeting('Bob'), '[en] Salut Bob');

    await assert.rejects(() => projects.addKeys(meta.id, JSON.stringify({ nested: { a: 'x' } })), UserError);
});

test('listProjects : triés du plus récent au plus ancien', async () => {
    const projects = require('../lib/projects');
    const jobA = await makeJob('fr.json', JSON.stringify({ a: 'Un' }), ['en']);
    const jobB = await makeJob('fr.json', JSON.stringify({ a: 'Un' }), ['en']);
    const metaA = await projects.createFromJob(jobA, { name: 'A' });
    await new Promise((r) => setTimeout(r, 5));
    const metaB = await projects.createFromJob(jobB, { name: 'B' });

    const list = await projects.listProjects();
    assert.deepEqual(list.map((p) => p.id), [metaB.id, metaA.id]);
});