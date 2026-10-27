'use strict';

const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const JSZip = require('jszip');
const { translateTexts } = require('./translator');
const translationLog = require('./translationLog');
const { parseFile } = require('./parsers');
const { getLanguage } = require('./languages');
const { appDir } = require('./runtime');

const jobs = new Map();
// Chaque traduction est aussi écrite sur disque (un dossier par job) : un refresh de la page ou un redémarrage
// du serveur ne la fait plus disparaître. Les langues terminées sont déjà téléchargeables.
const JOBS_DIR = process.env.JOBS_DIR || path.join(appDir(), 'data', 'jobs');
const TTL_MS = (Number(process.env.JOB_RETENTION_HOURS) || 24) * 60 * 60 * 1000; // durée de conservation après la fin
const STUCK_TTL_MS = 4 * 60 * 60 * 1000; // filet de sécurité si un job reste bloqué "en cours" (ne devrait jamais arriver)
const LANGUAGE_CONCURRENCY = 3;  // langues traduites en parallèle
const MAX_WARNINGS_SENT = 50;

let running = 0;

const runningCount = () => running;

function sanitizeBase(filename) {
  const base = filename.replace(/\.[^.]+$/, '').replace(/[^\w.-]+/g, '_').replace(/^\.+/, '');
  return base || 'fichier';
}

function outputName({ base, ext, lang, naming }) {
  return naming === 'name-lang' ? `${base}.${lang}${ext}` : `${lang}${ext}`;
}

async function mapLimit(items, limit, fn) {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      await fn(items[index], index);
    }
  });
  await Promise.all(workers);
}

const jobDir = (id) => path.join(JOBS_DIR, id);

/**
 * Écrit l'état du job (job.json), son fichier d'origine et les langues terminées.
 * Les écritures d'un même job se font l'une après l'autre, et job.json est remplacé d'un bloc
 * (fichier temporaire puis renommage) pour ne jamais être lu à moitié écrit.
 */
function persist(job) {
  job.saving = (job.saving ?? Promise.resolve()).then(async () => {
    const dir = jobDir(job.id);
    await fsp.mkdir(path.join(dir, 'files'), { recursive: true });
    if (!job.inputSaved) {
      await fsp.writeFile(path.join(dir, `input${job.ext}`), job.parsed.rebuild(() => null));
      job.inputSaved = true;
    }
    for (const file of job.files) {
      if (file.saved) continue;
      await fsp.writeFile(path.join(dir, 'files', file.name), file.buffer);
      file.saved = true;
    }
    const meta = {
      id: job.id,
      base: job.base,
      ext: job.ext,
      status: job.status,
      createdAt: job.createdAt,
      finishedAt: job.finishedAt,
      total: job.total,
      sourceCode: job.source?.code ?? null,
      targetCodes: job.targetCodes,
      ignoreKeys: job.ignoreKeys,
      files: job.files.map(({ lang, label, name, providers }) => ({ lang, label, name, providers })),
      errors: job.errors,
    };
    await fsp.writeFile(path.join(dir, 'job.json.tmp'), JSON.stringify(meta, null, 2));
    await fsp.rename(path.join(dir, 'job.json.tmp'), path.join(dir, 'job.json'));
  }).catch((err) => console.warn(`[jobs] sauvegarde impossible pour ${job.id} : ${err.message}`));
  return job.saving;
}

async function run(job, { parsed, texts, source, targets, base, naming }) {
  try {
    await mapLimit(targets, LANGUAGE_CONCURRENCY, async (target) => {
      try {
        const { results, failed, reasons, providers } = await translateTexts(texts, {
          source,
          target,
          onProgress: (count) => { job.done += count; },
        });

        const content = parsed.rebuild((segment) => results.get(segment.text));
        job.files.push({
          lang: target.code,
          label: target.native,
          name: outputName({ base, ext: parsed.ext, lang: target.code, naming }),
          buffer: Buffer.from(content, 'utf8'),
          providers: [...providers],
        });

        for (const segment of parsed.segments) {
          if (!failed.has(segment.text)) continue;
          const reason = reasons.get(segment.text) ?? 'raison inconnue';
          job.warnings.push({ lang: target.code, path: segment.path, message: `Non traduit (${reason}) : texte original conservé.` });
          translationLog.log({ project: base, lang: target.code, path: segment.path, reason });
        }
      } catch (err) {
        job.errors.push({ lang: target.code, label: target.native, message: err.message });
        for (const segment of parsed.segments) translationLog.log({ project: base, lang: target.code, path: segment.path, reason: err.message });
      }
      persist(job); // chaque langue terminée est sauvegardée tout de suite
    });

    const order = new Map(targets.map((t, i) => [t.code, i]));
    job.files.sort((a, b) => order.get(a.lang) - order.get(b.lang));
    job.status = job.files.length > 0 ? 'done' : 'error';
  } catch (err) {
    console.error(err);
    job.errors.push({ lang: null, label: null, message: err.message });
    job.status = 'error';
  } finally {
    job.done = job.total;
    job.finishedAt = Date.now();
    persist(job);
  }
}

function createJob({ parsed, texts, skipped, source, targets, filename, naming, ignoreKeys = [] }) {
  const base = sanitizeBase(filename);
  const job = {
    id: crypto.randomUUID(),
    base,
    status: 'running',
    createdAt: Date.now(),
    finishedAt: null,
    done: 0,
    total: texts.length * targets.length,
    files: [],
    warnings: skipped.map((s) => ({ lang: null, path: s.path, message: s.message })),
    errors: [],
    // Conservés pour permettre d'enregistrer ce job comme projet une fois terminé (voir lib/projects.js).
    parsed,
    source,
    ignoreKeys,
    ext: parsed.ext,
    targetCodes: targets.map((t) => t.code),
  };
  jobs.set(job.id, job);
  persist(job);
  for (const s of skipped) translationLog.log({ project: base, path: s.path, reason: s.message });

  running++;
  run(job, { parsed, texts, source, targets, base, naming }).finally(() => { running--; });

  return job;
}

const getJob = (id) => jobs.get(id) ?? null;

/** Version du job renvoyée au navigateur (sans les contenus des fichiers). */
function toPublic(job) {
  const url = `/api/jobs/${job.id}`;
  return {
    id: job.id,
    status: job.status,
    done: job.done,
    total: job.total,
    files: job.files.map((f) => ({
      lang: f.lang,
      label: f.label,
      name: f.name,
      size: f.buffer.length,
      providers: f.providers,
      url: `${url}/files/${encodeURIComponent(f.name)}`,
    })),
    zipUrl: job.files.length > 1 ? `${url}/zip` : null,
    canSaveAsProject: job.status === 'done' && job.files.length > 0,
    warnings: job.warnings.slice(0, MAX_WARNINGS_SENT),
    warningsTotal: job.warnings.length,
    errors: job.errors,
  };
}

async function buildZip(job) {
  const zip = new JSZip();
  for (const file of job.files) zip.file(file.name, file.buffer);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

const forget = (id) => {
  jobs.delete(id);
  fsp.rm(jobDir(id), { recursive: true, force: true }).catch(() => { });
};

/**
 * Au démarrage : recharge les jobs conservés sur disque. Un job qui tournait quand le serveur s'est arrêté
 * ne peut pas reprendre tout seul : ses langues terminées restent disponibles, les autres sont signalées.
 */
function restoreJobs() {
  let ids = [];
  try { ids = fs.readdirSync(JOBS_DIR); } catch { return; }

  for (const id of ids) {
    const dir = jobDir(id);
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(dir, 'job.json'), 'utf8'));
      if (Date.now() - (meta.finishedAt ?? meta.createdAt) > TTL_MS) { fs.rmSync(dir, { recursive: true, force: true }); continue; }

      const job = {
        ...meta,
        done: meta.total,
        source: meta.sourceCode ? getLanguage(meta.sourceCode) : null,
        parsed: parseFile({ filename: `input${meta.ext}`, buffer: fs.readFileSync(path.join(dir, `input${meta.ext}`)), ignoreKeys: meta.ignoreKeys }),
        files: meta.files.map((f) => ({ ...f, buffer: fs.readFileSync(path.join(dir, 'files', f.name)), saved: true })),
        inputSaved: true,
      };

      if (job.status === 'running') {
        const handled = new Set([...job.files.map((f) => f.lang), ...job.errors.map((e) => e.lang)]);
        for (const code of job.targetCodes) {
          if (handled.has(code)) continue;
          job.errors.push({ lang: code, label: getLanguage(code)?.native ?? code, message: 'Interrompue par un redémarrage du serveur : relancez cette langue.' });
        }
        job.status = job.files.length > 0 ? 'done' : 'error';
        job.finishedAt = Date.now();
        persist(job);
      }
      jobs.set(job.id, job);
    } catch (err) {
      console.warn(`[jobs] job ${id} illisible, ignoré : ${err.message}`);
    }
  }
}
restoreJobs();

setInterval(() => {
  const now = Date.now();
  for (const [id, job] of jobs) {
    if (job.status === 'running') {
      // Une traduction via Puppeteer peut légitimement prendre plus de 30 minutes : on ne la
      // supprime jamais tant qu'elle tourne, sauf filet de sécurité en cas de blocage anormal.
      if (now - job.createdAt > STUCK_TTL_MS) forget(id);
      continue;
    }
    if (now - job.finishedAt > TTL_MS) forget(id);
  }
}, 5 * 60 * 1000).unref();

module.exports = { createJob, getJob, toPublic, buildZip, runningCount, sanitizeBase };