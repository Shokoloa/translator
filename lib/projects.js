'use strict';

/**
 * Persistance des projets sur disque (un dossier par projet sous PROJECTS_DIR).
 *
 * Un projet se crée à partir d'un job de traduction déjà terminé (voir server.js :
 * "Enregistrer comme projet" réutilise tout le travail déjà fait — parsing, traduction, fichiers).
 * Il garde deux choses : le fichier source (langue d'origine, toutes les clés) et un fichier par
 * langue cible. "Ajouter des clés" ne retraduit jamais ce qui existe déjà : seules les clés
 * réellement nouvelles sont traduites, puis fusionnées dans chaque fichier existant.
 */

const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const JSZip = require('jszip');

const { parseFile } = require('./parsers');
const { appendJsProperties } = require('./parsers/js');
const { deepMerge, isPlainObject, flattenStrings } = require('./merge');
const { translateTexts, collectTexts } = require('./translator');
const { getLanguage } = require('./languages');
const { UserError } = require('./errors');

const { appDir } = require('./runtime');
const translationLog = require('./translationLog');

const ROOT = process.env.PROJECTS_DIR || path.join(appDir(), 'data', 'projects');
const LANGUAGE_CONCURRENCY = 3;
const TASK_TTL_MS = 30 * 60 * 1000;

// Traductions en cours par projet. Seul le suivi d'avancement vit en mémoire : chaque langue est écrite
// sur disque dès qu'elle est prête, un redémarrage du serveur ne fait donc perdre que celles en cours.
const tasks = new Map();
const adding = new Set(); // projets dont des clés sont en cours d'ajout
const metaLocks = new Map();

const dir = (id) => path.join(ROOT, id);
const metaPath = (id) => path.join(dir(id), 'project.json');
const sourcePath = (id, ext) => path.join(dir(id), `source${ext}`);
const targetPath = (id, lang, ext) => path.join(dir(id), `${lang}${ext}`);

const safeId = (id) => /^[a-f0-9-]{36}$/.test(String(id)); // uuid v4, évite toute évasion de chemin

async function ensureRoot() {
    await fs.mkdir(ROOT, { recursive: true });
}

async function readMeta(id) {
    if (!safeId(id)) throw new UserError('Projet introuvable.', 404);
    try {
        return JSON.parse(await fs.readFile(metaPath(id), 'utf8'));
    } catch (err) {
        if (err.code === 'ENOENT') throw new UserError('Projet introuvable.', 404);
        throw err;
    }
}

async function writeMeta(id, meta) {
    await fs.writeFile(metaPath(id), JSON.stringify(meta, null, 2) + '\n');
}

// Plusieurs langues peuvent se terminer en même temps : leurs mises à jour de project.json passent l'une après l'autre.
function withMetaLock(id, fn) {
    const run = (metaLocks.get(id) ?? Promise.resolve()).then(fn);
    metaLocks.set(id, run.catch(() => { }));
    return run;
}

async function listProjects() {
    await ensureRoot();
    const ids = await fs.readdir(ROOT).catch(() => []);
    const projects = [];
    for (const id of ids) {
        try { projects.push(await readMeta(id)); } catch { /* dossier invalide : ignoré */ }
    }
    return projects.sort((a, b) => b.updatedAt - a.updatedAt);
}

async function getProject(id) {
    const meta = await readMeta(id);
    const files = {};
    for (const code of meta.targetCodes) files[code] = await fs.readFile(targetPath(id, code, meta.ext), 'utf8');
    return { meta, files };
}

/** Crée un projet à partir d'un job de traduction déjà terminé (voir jobs.js). */
async function createFromJob(job, { name }) {
    if (job.status !== 'done') throw new UserError("Cette traduction n'est pas terminée.");
    if (!job.parsed) throw new UserError('Cette traduction ne peut plus être enregistrée comme projet (expirée).');
    if (!name || !name.trim()) throw new UserError('Donnez un nom au projet.');
    if (name.trim().length > 120) throw new UserError('Nom de projet trop long (120 caractères maximum).');

    await ensureRoot();
    const id = crypto.randomUUID();
    await fs.mkdir(dir(id), { recursive: true });

    // Fichier source : le fichier d'origine reconstruit tel quel (aucun segment remplacé).
    const sourceContent = job.parsed.rebuild(() => null);
    await fs.writeFile(sourcePath(id, job.parsed.ext), sourceContent);
    for (const file of job.files) await fs.writeFile(targetPath(id, file.lang, job.parsed.ext), file.buffer);

    const meta = {
        id,
        name: name.trim(),
        format: job.parsed.format,
        ext: job.parsed.ext,
        sourceCode: job.source?.code ?? null,
        targetCodes: job.files.map((f) => f.lang),
        ignoreKeys: job.ignoreKeys ?? [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
    };
    await writeMeta(id, meta);
    return meta;
}

/**
 * Crée un projet vide : seulement le fichier source, aucune langue cible.
 * Les langues se demandent ensuite, quand on veut, avec startTranslation().
 */
async function createEmpty({ name, filename, buffer, sourceCode, ignoreKeys = [] }) {
    if (!name || !name.trim()) throw new UserError('Donnez un nom au projet.');
    if (name.trim().length > 120) throw new UserError('Nom de projet trop long (120 caractères maximum).');

    const parsed = parseFile({ filename, buffer, ignoreKeys });
    if (collectTexts(parsed.segments).texts.length === 0) {
        throw new UserError('Aucun texte à traduire dans ce fichier. Vérifiez aussi la liste des clés ignorées.', 422);
    }

    await ensureRoot();
    const id = crypto.randomUUID();
    await fs.mkdir(dir(id), { recursive: true });
    await fs.writeFile(sourcePath(id, parsed.ext), parsed.rebuild(() => null));

    const meta = {
        id,
        name: name.trim(),
        format: parsed.format,
        ext: parsed.ext,
        sourceCode: sourceCode ?? null,
        targetCodes: [],
        ignoreKeys,
        createdAt: Date.now(),
        updatedAt: Date.now(),
    };
    await writeMeta(id, meta);
    return meta;
}

async function translateLanguage(id, task, { target, texts, parsed, source, name }) {
    let got = 0;
    try {
        const { results, failed, reasons } = await translateTexts(texts, {
            source,
            target,
            onProgress: (count) => { got += count; task.done += count; },
        });

        await fs.writeFile(targetPath(id, target.code, parsed.ext), parsed.rebuild((segment) => results.get(segment.text)));

        for (const segment of parsed.segments) {
            if (!failed.has(segment.text)) continue;
            const reason = reasons.get(segment.text) ?? 'raison inconnue';
            task.warnings.push({ lang: target.code, path: segment.path, message: `Non traduit (${reason}) : texte original conservé.` });
            translationLog.log({ project: name, lang: target.code, path: segment.path, reason });
        }

        await withMetaLock(id, async () => {
            const meta = await readMeta(id);
            if (!meta.targetCodes.includes(target.code)) meta.targetCodes.push(target.code);
            meta.updatedAt = Date.now();
            await writeMeta(id, meta);
        });
    } catch (err) {
        task.errors.push({ lang: target.code, label: target.native, message: err.message });
        for (const segment of parsed.segments) translationLog.log({ project: name, lang: target.code, path: segment.path, reason: err.message });
    } finally {
        task.done += texts.length - got; // la barre doit pouvoir arriver au bout même si cette langue a échoué
        task.pending.delete(target.code);
    }
}

function pump(id, task) {
    while (task.active < LANGUAGE_CONCURRENCY && task.queue.length) {
        const item = task.queue.shift();
        task.active++;
        translateLanguage(id, task, item).finally(() => {
            task.active--;
            if (task.queue.length) pump(id, task);
            else if (task.active === 0) task.finishedAt = Date.now();
        });
    }
}

/**
 * Lance (ou complète) la traduction du fichier source vers de nouvelles langues.
 * Peut être rappelée pendant qu'une traduction tourne : les langues s'ajoutent à la file d'attente.
 * Les langues déjà dans le projet, déjà en file d'attente ou identiques à la langue d'origine sont ignorées.
 */
async function startTranslation(id, codes, { maxChars } = {}) {
    if (adding.has(id)) throw new UserError("Des clés sont en cours d'ajout : réessayez dans un instant.", 409);
    const meta = await readMeta(id);
    const source = meta.sourceCode ? getLanguage(meta.sourceCode) : null;
    let task = tasks.get(id);

    const requested = [...new Set(codes)];
    if (requested.length === 0) throw new UserError('Choisissez au moins une langue.');
    const languages = requested.map(getLanguage);
    if (languages.some((language) => !language)) throw new UserError('Langue cible inconnue.');

    const taken = new Set([...meta.targetCodes, ...(task?.pending ?? [])]);
    const targets = languages.filter((language) => !taken.has(language.code) && language.code !== source?.code);
    if (targets.length === 0) throw new UserError('Ces langues sont déjà dans le projet, en cours de traduction, ou identiques à la langue d\'origine.', 409);

    const sourceText = await fs.readFile(sourcePath(id, meta.ext), 'utf8');
    const parsed = parseFile({ filename: `source${meta.ext}`, buffer: Buffer.from(sourceText), ignoreKeys: meta.ignoreKeys });
    const { texts, skipped } = collectTexts(parsed.segments);
    if (texts.length === 0) throw new UserError('Aucun texte à traduire dans ce projet.');

    const chars = texts.reduce((sum, text) => sum + text.length, 0) * targets.length;
    if (maxChars && chars > maxChars) {
        throw new UserError(
            `Cette demande représente ${chars.toLocaleString('fr-FR')} caractères (${targets.length} langue${targets.length > 1 ? 's' : ''}), ` +
            `la limite est de ${maxChars.toLocaleString('fr-FR')}. Lancez moins de langues à la fois, ou augmentez MAX_CHARS_PER_JOB dans .env.`,
            413,
        );
    }

    if (!task || task.pending.size === 0) {
        task = { done: 0, total: 0, errors: [], warnings: skipped.map((s) => ({ lang: null, path: s.path, message: s.message })), queue: [], active: 0, pending: new Set(), finishedAt: null };
        tasks.set(id, task);
        for (const s of skipped) translationLog.log({ project: meta.name, path: s.path, reason: s.message });
    }
    task.finishedAt = null;
    task.total += texts.length * targets.length;
    for (const target of targets) {
        task.pending.add(target.code);
        task.queue.push({ target, texts, parsed, source, name: meta.name });
    }
    pump(id, task);
}

/** État du projet et de sa traduction en cours (ou terminée il y a moins de 30 minutes). */
async function getStatus(id) {
    const meta = await readMeta(id);
    const task = tasks.get(id);
    return {
        running: Boolean(task && task.pending.size > 0),
        hasTask: Boolean(task),
        done: Math.min(task?.done ?? 0, task?.total ?? 0),
        total: task?.total ?? 0,
        pending: [...(task?.pending ?? [])],
        errors: task?.errors ?? [],
        warnings: (task?.warnings ?? []).slice(0, 50),
        warningsTotal: task?.warnings.length ?? 0,
        targetCodes: meta.targetCodes,
    };
}

setInterval(() => {
    for (const [id, task] of tasks) if (task.finishedAt && Date.now() - task.finishedAt > TASK_TTL_MS) tasks.delete(id);
}, 5 * 60 * 1000).unref();

function detectIndent(text) {
    const m = /^([ \t]+)\S/m.exec(text);
    return m ? m[1] : 2;
}

/** Valide et met à plat le JSON envoyé par l'utilisateur pour l'ajout de clés. */
function toEntries(snippet, format) {
    let data;
    try {
        data = JSON.parse(snippet);
    } catch (err) {
        throw new UserError(`JSON invalide : ${err.message}`);
    }
    if (!isPlainObject(data)) throw new UserError('Le contenu doit être un objet JSON, par exemple {"clé": "texte"}.');

    if (format === 'js') {
        const flat = Object.entries(data);
        for (const [key, value] of flat) {
            if (typeof value !== 'string') throw new UserError(`Pour un fichier .js, chaque clé doit avoir un texte simple, sans imbrication (« ${key} » n'en a pas).`);
        }
        return { flat, tree: data };
    }
    return { flat: flattenStrings(data), tree: data };
}

/** Reconstruit un objet imbriqué à partir de paires [chemin.pointé, valeur]. */
function unflatten(entries) {
    const tree = {};
    for (const [keyPath, value] of entries) {
        const parts = keyPath.split('.');
        let node = tree;
        for (const part of parts.slice(0, -1)) node = node[part] ??= {};
        node[parts.at(-1)] = value;
    }
    return tree;
}

/**
 * Ajoute de nouvelles clés au projet et les traduit dans toutes ses langues cibles.
 * Ne retraduit et ne réécrit jamais ce qui existe déjà — refuse si une clé du même nom existe déjà.
 */
async function addKeys(id, snippet) {
    if (tasks.get(id)?.pending.size) throw new UserError('Une traduction est en cours pour ce projet : attendez qu\'elle se termine avant d\'ajouter des clés.', 409);
    adding.add(id);
    try {
        return await addKeysNow(id, snippet);
    } finally {
        adding.delete(id);
    }
}

async function addKeysNow(id, snippet) {
    const meta = await readMeta(id);
    const source = meta.sourceCode ? getLanguage(meta.sourceCode) : null;

    const currentSourceText = await fs.readFile(sourcePath(id, meta.ext), 'utf8');
    const existing = parseFile({ filename: `source${meta.ext}`, buffer: Buffer.from(currentSourceText), ignoreKeys: meta.ignoreKeys });
    const existingPaths = new Set(existing.segments.map((s) => s.path));

    const { flat, tree } = toEntries(snippet, meta.format);
    if (flat.length === 0) throw new UserError('Aucune clé à ajouter.');

    const conflicts = flat.filter(([keyPath]) => existingPaths.has(keyPath)).map(([keyPath]) => keyPath);
    if (conflicts.length) throw new UserError(`Ces clés existent déjà dans le projet : ${conflicts.join(', ')}.`, 409);

    // --- fichier source (langue d'origine) : les nouvelles clés y sont ajoutées telles quelles ---
    if (meta.format === 'json') {
        const obj = JSON.parse(currentSourceText);
        deepMerge(obj, tree);
        await fs.writeFile(sourcePath(id, meta.ext), JSON.stringify(obj, null, detectIndent(currentSourceText)) + '\n');
    } else await fs.writeFile(sourcePath(id, meta.ext), appendJsProperties(currentSourceText, flat));

    // --- traduction des langues cibles, quelques-unes en parallèle ---
    const texts = [...new Set(flat.map(([, value]) => value))];
    const warnings = [];
    const errors = [];
    const codes = [...meta.targetCodes];
    let cursor = 0;

    async function worker() {
        while (cursor < codes.length) {
            const code = codes[cursor++];
            const target = getLanguage(code);
            try {
                const { results, failed, reasons } = await translateTexts(texts, { source, target });
                for (const [keyPath, value] of flat) {
                    if (!failed.has(value)) continue;
                    const reason = reasons.get(value) ?? 'raison inconnue';
                    warnings.push({ lang: code, path: keyPath, message: `« ${value} » n'a pas pu être traduit (${reason}) : texte d'origine conservé.` });
                    translationLog.log({ project: meta.name, lang: code, path: keyPath, reason });
                }

                const translatedFlat = flat.map(([keyPath, value]) => [keyPath, results.get(value) ?? value]);
                const currentTargetText = await fs.readFile(targetPath(id, code, meta.ext), 'utf8');

                if (meta.format === 'json') {
                    const obj = JSON.parse(currentTargetText);
                    deepMerge(obj, unflatten(translatedFlat));
                    await fs.writeFile(targetPath(id, code, meta.ext), JSON.stringify(obj, null, detectIndent(currentTargetText)) + '\n');
                } else await fs.writeFile(targetPath(id, code, meta.ext), appendJsProperties(currentTargetText, translatedFlat));
            } catch (err) {
                errors.push({ lang: code, message: err.message });
                for (const [keyPath] of flat) translationLog.log({ project: meta.name, lang: code, path: keyPath, reason: err.message });
            }
        }
    }
    await Promise.all(Array.from({ length: Math.min(LANGUAGE_CONCURRENCY, codes.length) }, worker));

    meta.updatedAt = Date.now();
    await writeMeta(id, meta);

    return { addedKeys: flat.map(([keyPath]) => keyPath), warnings, errors };
}

async function buildZip(id) {
    const meta = await readMeta(id);
    const zip = new JSZip();
    for (const code of meta.targetCodes) zip.file(`${code}${meta.ext}`, await fs.readFile(targetPath(id, code, meta.ext)));
    return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

module.exports = { listProjects, getProject, createFromJob, createEmpty, startTranslation, getStatus, addKeys, buildZip, targetPath, sourcePath, safeId };