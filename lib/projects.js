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
const { translateTexts } = require('./translator');
const { getLanguage } = require('./languages');
const { UserError } = require('./errors');

const ROOT = process.env.PROJECTS_DIR || path.join(__dirname, '..', 'data', 'projects');
const LANGUAGE_CONCURRENCY = 3;

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
            if (typeof value !== 'string') {
                throw new UserError(
                    `Pour un fichier .js, chaque clé doit avoir un texte simple, sans imbrication (« ${key} » n'en a pas).`,
                );
            }
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
    } else {
        await fs.writeFile(sourcePath(id, meta.ext), appendJsProperties(currentSourceText, flat));
    }

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
                const { results, failed } = await translateTexts(texts, { source, target });
                for (const text of failed) {
                    warnings.push({ lang: code, message: `« ${text} » n'a pas pu être traduit : texte d'origine conservé.` });
                }

                const translatedFlat = flat.map(([keyPath, value]) => [keyPath, results.get(value) ?? value]);
                const currentTargetText = await fs.readFile(targetPath(id, code, meta.ext), 'utf8');

                if (meta.format === 'json') {
                    const obj = JSON.parse(currentTargetText);
                    deepMerge(obj, unflatten(translatedFlat));
                    await fs.writeFile(targetPath(id, code, meta.ext), JSON.stringify(obj, null, detectIndent(currentTargetText)) + '\n');
                } else {
                    await fs.writeFile(targetPath(id, code, meta.ext), appendJsProperties(currentTargetText, translatedFlat));
                }
            } catch (err) {
                errors.push({ lang: code, message: err.message });
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

module.exports = { listProjects, getProject, createFromJob, addKeys, buildZip, targetPath, sourcePath, safeId };