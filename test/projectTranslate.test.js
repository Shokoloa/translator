'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

process.env.TRANSLATE_MOCK = '1';

let dataDir;
let projects;
test.beforeEach(async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'projects-translate-'));
    process.env.PROJECTS_DIR = dataDir;
    for (const key of Object.keys(require.cache)) if (key.includes('/lib/projects')) delete require.cache[key];
    projects = require('../lib/projects');
});
test.afterEach(async () => { await fs.rm(dataDir, { recursive: true, force: true }); });

const buffer = Buffer.from("module.exports = {\n  hello: 'Bonjour',\n  bye: 'Au revoir',\n};\n");
const create = () => projects.createEmpty({ name: 'Test', filename: 'fr.js', buffer, sourceCode: 'fr' });

async function finish(id) {
    for (; ;) {
        const status = await projects.getStatus(id);
        if (!status.running) return status;
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
}

test('un projet se crée sans aucune langue, avec seulement le fichier source', async () => {
    const meta = await create();
    assert.deepEqual(meta.targetCodes, []);
    assert.match(await fs.readFile(projects.sourcePath(meta.id, '.js'), 'utf8'), /Bonjour/);
    assert.equal((await projects.getStatus(meta.id)).running, false);
});

test('les langues se demandent après coup, et se cumulent sans retraduire les existantes', async () => {
    const { id } = await create();

    await projects.startTranslation(id, ['es', 'de']);
    await projects.startTranslation(id, ['it']); // pendant que la première demande tourne
    const status = await finish(id);
    assert.deepEqual([...status.targetCodes].sort(), ['de', 'es', 'it']);
    assert.equal(status.done, status.total);

    const es = await fs.readFile(projects.targetPath(id, 'es', '.js'), 'utf8');
    assert.match(es, /\[es\] Bonjour/);

    // Plus tard : une langue de plus ; es est ignorée car déjà là
    await projects.startTranslation(id, ['es', 'pt']);
    assert.deepEqual([...(await finish(id)).targetCodes].sort(), ['de', 'es', 'it', 'pt']);

    await assert.rejects(() => projects.startTranslation(id, ['es', 'fr']), { status: 409 }); // déjà là / langue d'origine
});

test('la limite de caractères refuse une demande trop grosse avec un 413', async () => {
    const { id } = await create();
    await assert.rejects(() => projects.startTranslation(id, ['es', 'de', 'it'], { maxChars: 10 }), { status: 413 });
    assert.deepEqual((await projects.getStatus(id)).targetCodes, []);
});

test('ajouter des clés est refusé pendant qu\'une traduction tourne', async () => {
    const { id } = await create();
    await projects.startTranslation(id, ['es']);
    await assert.rejects(() => projects.addKeys(id, '{"x":"Salut"}'), { status: 409 });
    await finish(id);
    const result = await projects.addKeys(id, '{"x":"Salut"}');
    assert.deepEqual(result.addedKeys, ['x']);
});