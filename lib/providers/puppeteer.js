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
const RESULT_SELECTOR = 'span.ryNqvb[jsname="W297wb"]';
const TEXT_TIMEOUT_MS = 15_000;
const PAUSE_BETWEEN_REQUESTS_MS = 400;

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

// Page de consentement aux cookies, affichée à la première visite (surtout en Europe).
async function acceptGoogleConsent(page) {
  try {
    await sleep(1000);
    const clicked = await page.evaluate(() => {
      const button =
        document.querySelector('button[jsname="b3VHJd"]') ||
        document.querySelector('button[aria-label="Tout accepter"]') ||
        [...document.querySelectorAll('button')].find((b) =>
          ['tout accepter', 'accept all', "j'accepte", 'i agree'].some((label) =>
            b.textContent.trim().toLowerCase().includes(label)),
        );
      if (button) { button.click(); return true; }
      return false;
    });
    if (clicked) await sleep(1500); // laisse Google recharger la page après le clic
  } catch { /* pas de bannière, ou déjà acceptée */ }
}

/** Traduit une seule ligne. Renvoie null (et jamais ne lève) si rien n'est revenu sous 15 secondes. */
async function translateLine(page, line, source, target) {
  await page.goto(
    `https://translate.google.com/?sl=${source ? source.google : 'auto'}&tl=${target.google}&op=translate`,
    { waitUntil: 'domcontentloaded', timeout: 30_000 },
  );
  if (page.url().includes('consent.google.')) await acceptGoogleConsent(page);

  const textarea = await page.$('textarea');
  if (!textarea) throw fail("champ de saisie introuvable : l'interface de Google Traduction a probablement changé");

  await textarea.click({ clickCount: 3 });
  await page.keyboard.press('Backspace');
  await textarea.type(line, { delay: 10 });

  try {
    await page.waitForFunction(
      (selector) => {
        const el = document.querySelector(selector);
        return el && el.innerText.trim().length > 0;
      },
      { timeout: TEXT_TIMEOUT_MS },
      RESULT_SELECTOR,
    );
  } catch {
    return null; // pas de réponse à temps : ce texte est écarté, sans faire échouer les autres
  }

  // Le texte peut encore évoluer un court instant : on attend qu'il soit stable.
  let previous = await page.evaluate((s) => document.querySelector(s)?.innerText.trim() ?? '', RESULT_SELECTOR);
  for (let i = 0; i < 5; i++) {
    await sleep(400);
    const current = await page.evaluate((s) => document.querySelector(s)?.innerText.trim() ?? '', RESULT_SELECTOR);
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

  /**
   * texts : chaînes déjà protégées (variables remplacées par [[n]]).
   * onItem : appelé une fois par texte traité (succès ou échec), pour faire avancer la barre de progression.
   */
  async translate(texts, { source, target, onItem = () => { } }) {
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
        let ok = true;
        for (const line of text.split('\n')) {
          if (!line.trim()) { lines.push(''); continue; }
          const translated = await translateLine(page, line, source, target);
          if (translated == null) {
            console.warn(`[traduction] Puppeteer : pas de réponse sous 15 s pour « ${line.slice(0, 60)} », texte écarté.`);
            ok = false;
            break; // on ne reconstitue pas un texte multi-lignes à moitié traduit
          }
          lines.push(translated);
          await sleep(PAUSE_BETWEEN_REQUESTS_MS);
        }
        out.push(ok ? lines.join('\n') : ''); // chaîne vide = échec pour ce texte ; le suivant du chemin le reprend
        onItem();
      }
      return out;
    } finally {
      await page.close().catch(() => { });
    }
  },

  closeBrowser,
};