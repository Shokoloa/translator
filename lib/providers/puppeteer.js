/**
 * DERNIER RECOURS. Ouvre translate.google.com dans un Chrome sans interface et tape le texte
 * directement dans le champ (plutôt que de le passer dans l'URL, moins repérable comme trafic
 * automatisé). Un texte qui ne répond pas au bout de 15 secondes est simplement écarté : il
 * n'interrompt pas les autres, et repart vers le service suivant configuré dans PROVIDER_ORDER
 * s'il y en a un après Puppeteer (sinon le texte d'origine est conservé et signalé à l'utilisateur).
 *
 * À savoir avant de l'activer (ENABLE_PUPPETEER=true, puis `npm install puppeteer`) :
 *  - c'est lent : le champ est retapé pour chaque texte, avec un aller-retour de page à chaque fois ;
 *  - ça peut casser à tout moment : Google change régulièrement son HTML (voir RESULT_SELECTOR
 *    et acceptGoogleConsent) ;
 *  - Google peut afficher un captcha ou bloquer l'IP au-delà de quelques centaines de requêtes ;
 *  - ce type d'automatisation n'est pas autorisé par les conditions d'utilisation de Google Traduction.
 * Pour un usage régulier, préférez l'API officielle (GOOGLE_API_KEY).
 *
 * Pour que Puppeteer serve de garde-fou avant l'API (et non l'inverse), placez-le en tête :
 * PROVIDER_ORDER=puppeteer,deepl,google — un texte qu'il ne traduit pas à temps est alors
 * automatiquement retenté avec la clé API configurée. Avec l'ordre par défaut (deepl,google,puppeteer),
 * Puppeteer est déjà le dernier recours : un texte qui échoue là n'a plus personne à qui passer la main.
 */

'use strict';

const { ProviderError } = require('../errors');

const NAME = 'puppeteer';
// Modifiable sans toucher au code (PUPPETEER_RESULT_SELECTOR) quand Google change son HTML.
const RESULT_SELECTOR = process.env.PUPPETEER_RESULT_SELECTOR || 'span.ryNqvb[jsname="W297wb"]';
const TEXT_TIMEOUT_MS = 15_000;
const PAUSE_BETWEEN_REQUESTS_MS = 1000;
const MAX_CONSECUTIVE_FAILURES = 5;   // au-delà, on suppose un blocage de Google et on arrête de l'insister
const COOLDOWN_MS = 10 * 60 * 1000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const fail = (message, code = 'other') => new ProviderError(message, { code, provider: NAME });

let browserPromise = null;
let currentBrowser = null;
let cooldownUntil = 0; // Google a bloqué / ne répond plus : Puppeteer est mis de côté jusqu'à cette date

// Une seule page travaille à la fois : plusieurs langues en parallèle depuis la même IP déclencheraient le captcha.
let queue = Promise.resolve();
const exclusive = (fn) => {
  const run = queue.then(fn);
  queue = run.catch(() => { });
  return run;
};

// Ne laisse jamais un Chrome orphelin derrière un plantage ou un arrêt brutal du serveur.
process.on('exit', () => { try { currentBrowser?.process()?.kill(); } catch { /* déjà fermé */ } });

function getBrowser() {
  if (!browserPromise) {
    let puppeteer;
    try {
      puppeteer = require('puppeteer');
    } catch {
      throw fail("le paquet « puppeteer » n'est pas installé (npm install puppeteer)", 'config');
    }
    const promise = puppeteer.launch({
      headless: process.env.PUPPETEER_HEADLESS !== 'false', // PUPPETEER_HEADLESS=false : fenêtre visible (captcha, débogage)
      timeout: 30_000,
      protocolTimeout: 60_000,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });
    browserPromise = promise;
    // Si Chrome plante ou est fermé à la main, on repart d'un navigateur neuf au lieu de réutiliser un mort.
    promise.then((browser) => {
      currentBrowser = browser;
      browser.on('disconnected', () => { if (browserPromise === promise) browserPromise = null; });
    }, () => { if (browserPromise === promise) browserPromise = null; });
  }
  return browserPromise;
}

async function closeBrowser() {
  if (!browserPromise) return;
  const pending = browserPromise;
  browserPromise = null;
  try {
    await (await pending).close();
  } catch { /* déjà fermé */ }
}

// Page de consentement aux cookies, affichée à la première visite (surtout en Europe).
async function acceptGoogleConsent(page) {
  try {
    await sleep(1000);
    const clicked = await page.evaluate(() => {
      const button = document.querySelector('button[jsname="b3VHJd"]') || document.querySelector('button[aria-label="Tout accepter"]') || [...document.querySelectorAll('button')].find((b) => ['tout accepter', 'accept all', "j'accepte", 'i agree'].some((label) => b.textContent.trim().toLowerCase().includes(label)));
      if (button) { button.click(); return true; }
      return false;
    });
    if (clicked) await sleep(1500); // laisse Google recharger la page après le clic
  } catch { /* pas de bannière, ou déjà acceptée */ }
}

async function openPage(browser) {
  const page = await browser.newPage();
  page.setDefaultTimeout(30_000);
  // « HeadlessChrome » dans l'User-Agent déclenche bien plus vite un captcha.
  const userAgent = (await browser.userAgent()).replace('HeadlessChrome', 'Chrome');
  await page.setUserAgent({ userAgent });
  // Images, polices et médias ne servent à rien ici : on les bloque pour accélérer et alléger.
  await page.setRequestInterception(true);
  page.on('request', (request) => {
    const blocked = ['image', 'media', 'font'].includes(request.resourceType());
    (blocked ? request.abort() : request.continue()).catch(() => { });
  });
  return page;
}

const readResult = (page) => page.evaluate((s) => [...document.querySelectorAll(s)].map((el) => el.innerText).join('').trim(), RESULT_SELECTOR);

function blockedError() {
  return Object.assign(new Error('Google affiche un captcha ou a bloqué cette IP'), { blocked: true });
}

/**
+ * Traduit une seule ligne. Renvoie null si rien n'est revenu sous 15 secondes.
+ * Lève une erreur si la page est cassée (réseau, crash, interface changée) ou si Google bloque (err.blocked).
+ */
async function translateLine(page, line, source, target) {
  await page.goto(`https://translate.google.com/?sl=${source ? source.google : 'auto'}&tl=${target.google}&op=translate`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  if (page.url().includes('/sorry/')) throw blockedError();

  // La page est une application JS : le champ n'existe pas encore juste après domcontentloaded.
  const textarea = await page.waitForSelector('textarea', { timeout: 10_000 }).catch(() => null);
  if (!textarea) throw fail("champ de saisie introuvable : l'interface de Google Traduction a probablement changé");

  await textarea.click({ clickCount: 3 });
  await page.keyboard.press('Backspace');
  await textarea.type(line, { delay: 20 });

  try {
    await page.waitForFunction((selector) => {
      const el = document.querySelector(selector);
      return el && el.innerText.trim().length > 0;
    }, { timeout: TEXT_TIMEOUT_MS }, RESULT_SELECTOR);
  } catch {
    if (page.url().includes('/sorry/')) throw blockedError();
    return null; // pas de réponse à temps : ce texte est écarté, sans faire échouer les autres
  }

  // Google traduit pendant la frappe : on attend que le résultat soit identique à deux lectures de suite.
  // (Un texte de plusieurs phrases est réparti sur plusieurs <span> : readResult les réunit tous.)
  let previous = await readResult(page);
  for (let i = 0, stable = 0; i < 10 && stable < 2; i++) {
    await sleep(400);
    const current = await readResult(page);
    stable = current === previous ? stable + 1 : 0;
    previous = current;
  }
  return previous || null;
}

module.exports = {
  name: NAME,
  label: 'Google (navigateur)',
  format: 'plain', // l'interface web ne comprend pas les balises : les variables deviennent [[0]], [[1]]…
  isConfigured: () => process.env.ENABLE_PUPPETEER === 'true',
  supports: (target) => Boolean(target.google),

  /**
   * texts : chaînes déjà protégées (variables remplacées par [[n]]).
   * onItem : appelé une fois par texte traité (succès ou échec), pour faire avancer la barre de progression.
   */
  async translate(texts, { source, target, onItem = () => { } }) {
    return exclusive(async () => {
      if (Date.now() < cooldownUntil) throw fail('en pause après un blocage probable de Google', 'other');
      let browser;
      try {
        browser = await getBrowser();
      } catch (err) {
        if (err instanceof ProviderError) throw err;
        throw fail(`Chrome n'a pas pu démarrer (${err.message})`, 'config');
      }

      let page = await openPage(browser).catch((err) => { throw fail(`Chrome ne répond pas (${err.message})`, 'network'); });
      let failures = 0;
      try {
        const out = [];
        for (const text of texts) {
          if (Date.now() < cooldownUntil) { out.push(''); onItem(); continue; } // blocage détecté pendant ce lot
          const lines = [];
          let ok = true;
          for (const line of text.split('\n')) {
            if (!line.trim()) { lines.push(''); continue; }

            let translated = null;
            for (let attempt = 1; attempt <= 2; attempt++) {
              try {
                translated = await translateLine(page, line, source, target);
                break;
              } catch (err) {
                if (err.blocked) {
                  cooldownUntil = Date.now() + COOLDOWN_MS;
                  console.warn(`[traduction] Puppeteer : ${err.message}. Mis de côté pendant ${COOLDOWN_MS / 60_000} minutes.`);
                  break;
                }
                console.warn(`[traduction] Puppeteer : ${err.message} (essai ${attempt}/2)`);
                await page.close().catch(() => { });
                page = await openPage(browser); // page cassée : on repart d'une page neuve
              }
            }

            if (translated == null) {
              console.warn(`[traduction] Puppeteer : pas de traduction pour « ${line.slice(0, 60)} », texte écarté.`);
              ok = false;
              break; // on ne reconstitue pas un texte multi-lignes à moitié traduit
            }
            lines.push(translated);
            await sleep(PAUSE_BETWEEN_REQUESTS_MS);
          }
          out.push(ok ? lines.join('\n') : ''); // chaîne vide = échec pour ce texte ; le suivant du chemin le reprend
          failures = ok ? 0 : failures + 1;
          if (failures >= MAX_CONSECUTIVE_FAILURES && Date.now() >= cooldownUntil) {
            cooldownUntil = Date.now() + COOLDOWN_MS;
            console.warn(`[traduction] Puppeteer : ${failures} échecs d'affilée, Google bloque sans doute. Mis de côté pendant ${COOLDOWN_MS / 60_000} minutes.`);
          }
          onItem();
        }
        return out;
      } finally {
        await page.close().catch(() => { });
      }
    });
  },

  pausedUntil: () => cooldownUntil,
  closeBrowser,
};