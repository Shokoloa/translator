'use strict';

require('dotenv').config();

const path = require('path');
const express = require('express');
const multer = require('multer');
const { rateLimit } = require('express-rate-limit');

const { LANGUAGES, SOURCE_LANGUAGES, getLanguage } = require('./lib/languages');
const { parseFile, SUPPORTED_EXTENSIONS } = require('./lib/parsers');
const { collectTexts } = require('./lib/translator');
const providers = require('./lib/providers');
const jobs = require('./lib/jobs');
const { ParseError, UserError } = require('./lib/errors');

const PORT = Number(process.env.PORT) || 3000;
const MAX_FILE_KB = Number(process.env.MAX_FILE_SIZE_KB) || 512;
const MAX_CHARS_PER_JOB = Number(process.env.MAX_CHARS_PER_JOB) || 100_000;
const MAX_RUNNING_JOBS = Number(process.env.MAX_RUNNING_JOBS) || 4;
const RATE_LIMIT_PER_HOUR = Number(process.env.RATE_LIMIT_PER_HOUR) || 20;

const app = express();
app.disable('x-powered-by');
if (process.env.TRUST_PROXY) {
  // Derrière nginx / Cloudflare : TRUST_PROXY=1 (nombre de proxys) pour que la limite s'applique à la bonne IP.
  const value = Number(process.env.TRUST_PROXY);
  app.set('trust proxy', Number.isNaN(value) ? process.env.TRUST_PROXY : value);
}
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_KB * 1024, files: 1, fields: 20 },
  fileFilter(req, file, cb) {
    const ext = path.extname(file.originalname).toLowerCase();
    if (SUPPORTED_EXTENSIONS.includes(ext)) return cb(null, true);
    cb(new UserError('Format non pris en charge. Envoyez un fichier .json ou .js.', 415));
  },
});

// Chaque traduction consomme le quota des APIs : on limite le nombre d'envois par IP.
const createLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: RATE_LIMIT_PER_HOUR,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  handler: (req, res) => res.status(429).json({ error: `Limite atteinte : ${RATE_LIMIT_PER_HOUR} traductions par heure. Réessayez plus tard.` }),
});

app.get('/', (req, res) => {
  res.render('index', {
    languages: LANGUAGES,
    sourceLanguages: SOURCE_LANGUAGES,
    maxFileKb: MAX_FILE_KB,
    extensions: SUPPORTED_EXTENSIONS,
  });
});

app.get('/api/providers', (req, res) => {
  res.json(providers.status());
});

app.post('/api/jobs', createLimiter, upload.single('file'), (req, res) => {
  if (!req.file) throw new UserError('Choisissez un fichier à traduire.');
  if (!providers.hasConfiguredProvider()) throw new UserError("Aucun service de traduction n'est configuré (voir le fichier .env).", 503);
  if (jobs.runningCount() >= MAX_RUNNING_JOBS) throw new UserError('Trop de traductions en cours. Réessayez dans un instant.', 429);

  const sourceCode = String(req.body.source || 'auto');
  const source = sourceCode === 'auto' ? null : getLanguage(sourceCode);
  if (sourceCode !== 'auto' && !source) throw new UserError('Langue source inconnue.');

  const codes = [...new Set([].concat(req.body.targets ?? []))];
  const requested = codes.map(getLanguage);
  if (requested.some((language) => !language)) throw new UserError('Langue cible inconnue.');
  const targets = requested.filter((language) => !source || language.code !== source.code);
  if (targets.length === 0) throw new UserError('Choisissez au moins une langue cible différente de la langue du fichier.');

  const ignoreKeys = String(req.body.ignoreKeys ?? '').split(/[,\n]/).map((key) => key.trim()).filter(Boolean).slice(0, 100);
  const naming = req.body.naming === 'name-lang' ? 'name-lang' : 'lang';

  const parsed = parseFile({ filename: req.file.originalname, buffer: req.file.buffer, ignoreKeys });
  const { texts, skipped } = collectTexts(parsed.segments);
  if (texts.length === 0) throw new ParseError('Aucun texte à traduire dans ce fichier. Vérifiez aussi la liste des clés ignorées.');

  const chars = texts.reduce((sum, text) => sum + text.length, 0) * targets.length;
  if (chars > MAX_CHARS_PER_JOB) {
    throw new UserError(
      `Cette traduction représente ${chars.toLocaleString('fr-FR')} caractères ` +
      `(${targets.length} langue${targets.length > 1 ? 's' : ''}), la limite est de ${MAX_CHARS_PER_JOB.toLocaleString('fr-FR')}. ` +
      'Réduisez le nombre de langues ou la taille du fichier.',
      413,
    );
  }

  const job = jobs.createJob({ parsed, texts, skipped, source, targets, filename: req.file.originalname, naming });
  res.status(202).json({ id: job.id });
});

function findJob(req) {
  const job = jobs.getJob(req.params.id);
  if (!job) throw new UserError('Cette traduction a expiré ou n\'existe pas.', 404);
  return job;
}

app.get('/api/jobs/:id', (req, res) => {
  res.json(jobs.toPublic(findJob(req)));
});

app.get('/api/jobs/:id/files/:name', (req, res) => {
  const job = findJob(req);
  const file = job.files.find((f) => f.name === req.params.name);
  if (!file) throw new UserError('Fichier introuvable.', 404);
  res.attachment(file.name);
  res.type(file.name.endsWith('.json') ? 'application/json; charset=utf-8' : 'text/javascript; charset=utf-8');
  res.send(file.buffer);
});

app.get('/api/jobs/:id/zip', async (req, res) => {
  const job = findJob(req);
  if (job.files.length === 0) throw new UserError('Aucun fichier à télécharger.', 404);
  const zip = await jobs.buildZip(job);
  res.attachment(`${job.base}-traductions.zip`);
  res.type('application/zip');
  res.send(zip);
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    const tooBig = err.code === 'LIMIT_FILE_SIZE';
    return res.status(tooBig ? 413 : 400).json({ error: tooBig ? `Fichier trop volumineux (${MAX_FILE_KB} Ko maximum).` : "Le fichier n'a pas pu être envoyé." });
  }
  if (err instanceof UserError) return res.status(err.status).json({ error: err.message });
  if (err instanceof ParseError) return res.status(422).json({ error: err.message });

  console.error(err);
  res.status(500).json({ error: 'Erreur interne du serveur.' });
});

const server = app.listen(PORT, () => {
  console.log(`Traducteur de fichiers : http://localhost:${PORT}`);
  for (const p of providers.status()) console.log(`  ${p.label} : ${p.state === 'off' ? 'non configuré' : p.state}`);
  if (!providers.hasConfiguredProvider()) console.warn('  Aucun service configuré : renseignez DEEPL_API_KEY et/ou GOOGLE_API_KEY dans .env (ou TRANSLATE_MOCK=1 pour tester).');
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    server.close();
    await providers.closeAll();
    process.exit(0);
  });
}