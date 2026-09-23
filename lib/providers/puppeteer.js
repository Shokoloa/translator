'use strict';

/**
 * DERNIER RECOURS. Ouvre translate.google.com dans un Chrome sans interface et lit le résultat.
 *
 * À savoir avant de l'activer (ENABLE_PUPPETEER=true, puis `npm install puppeteer`) :
 *  - c'est lent : une page chargée par ligne de texte ;
 *  - ça peut casser à tout moment : Google change régulièrement son HTML (voir RESULT_SELECTOR) ;
 *  - Google peut afficher un captcha ou bloquer l'IP au-delà de quelques centaines de requêtes ;
 *  - ce type d'automatisation n'est pas autorisé par les conditions d'utilisation de Google Traduction.
 * Pour un usage régulier, préférez l'API officielle (GOOGLE_API_KEY).
 */

const { ProviderError } = require('../errors');

const NAME = 'puppeteer';
const RESULT_SELECTOR = 'span[jsname="W297wb"], .ryNqvb'; // à ajuster si Google change son interface
const PAUSE_BETWEEN_REQUESTS_MS = 500;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const fail = (message, code = 'other') => new ProviderError(message, { code, provider: NAME });

let browserPromise = null;

function getBrowser() {
  if (!browserPromise) {
    let puppeteer;
    try {
      puppeteer = require('puppeteer');
    } catch {
      throw fail("le paquet « puppeteer » n'est pas installé (npm install puppeteer)", 'config');
    }
    browserPromise = puppeteer.launch({ headless: false, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    browserPromise.catch(() => { browserPromise = null; });
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

// En Europe, Google affiche d'abord une page de consentement aux cookies.
async function dismissConsent(page) {
  const clicked = await page.evaluate(() => {
    const labels = ['tout refuser', 'reject all', 'refuser'];
    const button = [...document.querySelectorAll('button')].find((b) => labels.some((label) => b.textContent.trim().toLowerCase().includes(label)));
    if (button) button.click();
    return Boolean(button);
  });
  if (clicked) await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15_000 }).catch(() => { });
}

function readResult(page) {
  return page.evaluate((selector) => {
    const found = [...document.querySelectorAll(selector)];
    // on écarte les éléments contenus dans un autre élément trouvé, sinon le texte serait doublé
    const outer = found.filter((el) => !found.some((other) => other !== el && other.contains(el)));
    return outer.map((el) => el.textContent).join('');
  }, RESULT_SELECTOR);
}

async function translateLine(page, line, source, target) {
  const url = `https://translate.google.com/?sl=${source ? source.google : 'auto'}` + `&tl=${target.google}&text=${encodeURIComponent(line)}&op=translate`;

  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  if (page.url().includes('consent.google.')) await dismissConsent(page);

  try {
    await page.waitForFunction((selector) => [...document.querySelectorAll(selector)].some((el) => el.textContent.trim()), { timeout: 15_000 }, RESULT_SELECTOR);
  } catch {
    throw fail("résultat introuvable : l'interface de Google Traduction a probablement changé, ou un captcha s'affiche");
  }

  // Le texte peut encore évoluer un court instant : on attend qu'il soit stable.
  let previous = await readResult(page);
  for (let i = 0; i < 5; i++) {
    await sleep(400);
    const current = await readResult(page);
    if (current === previous) break;
    previous = current;
  }
  return previous;
}

module.exports = {
  name: NAME,
  label: 'Google (navigateur)',
  format: 'plain', // l'interface web ne comprend pas les balises : les variables deviennent [[0]], [[1]]…
  isConfigured: () => process.env.ENABLE_PUPPETEER === 'true',
  supports: (target) => Boolean(target.google),

  async translate(texts, { source, target }) {
    let browser;
    try {
      browser = await getBrowser();
    } catch (err) {
      if (err instanceof ProviderError) throw err;
      throw fail(`Chrome n'a pas pu démarrer (${err.message})`, 'config');
    }

    const page = await browser.newPage();
    try {
      const out = [];
      for (const text of texts) {
        const lines = [];
        for (const line of text.split('\n')) {
          lines.push(line.trim() ? await translateLine(page, line, source, target) : line);
          await sleep(PAUSE_BETWEEN_REQUESTS_MS);
        }
        out.push(lines.join('\n'));
      }
      return out;
    } finally {
      await page.close().catch(() => { });
    }
  },

  closeBrowser,
};