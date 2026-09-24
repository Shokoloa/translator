'use strict';

const crypto = require('crypto');
const JSZip = require('jszip');
const { translateTexts } = require('./translator');

const jobs = new Map();
const TTL_MS = 30 * 60 * 1000;   // les fichiers générés sont supprimés 30 minutes après la fin
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

async function run(job, { parsed, texts, source, targets, base, naming }) {
  try {
    await mapLimit(targets, LANGUAGE_CONCURRENCY, async (target) => {
      try {
        const { results, failed, providers } = await translateTexts(texts, {
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
          if (failed.has(segment.text)) {
            job.warnings.push({
              lang: target.code,
              path: segment.path,
              message: 'Une variable a été perdue à la traduction : texte original conservé.',
            });
          }
        }
      } catch (err) {
        job.errors.push({ lang: target.code, label: target.native, message: err.message });
      }
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
  };
  jobs.set(job.id, job);

  running++;
  run(job, { parsed, texts, source, targets, base, naming })
    .finally(() => { running--; });

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

setInterval(() => {
  const now = Date.now();
  for (const [id, job] of jobs) {
    const reference = job.finishedAt ?? job.createdAt;
    if (now - reference > TTL_MS) jobs.delete(id);
  }
}, 5 * 60 * 1000).unref();

module.exports = { createJob, getJob, toPublic, buildZip, runningCount, sanitizeBase };