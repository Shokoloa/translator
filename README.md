# Traducteur de fichiers

Traduit un fichier `.json` ou `.js` (`module.exports`) vers plusieurs langues, en gardant les variables
(`{user}`, `%s`, `<@123>`, `:emoji:`…) intactes. Un fichier de sortie par langue, ou un projet enregistré
auquel on peut ajouter des clés sans rien retraduire.

## Installation

```bash
npm install
cp .env.example .env     # puis renseigner au moins une clé
npm start                # http://localhost:3000
npm test
```

Sans clé, `TRANSLATE_MOCK=1` dans `.env` permet de tester l'interface (traduction factice `[fr] texte`).

## Services de traduction

Essayés dans l'ordre de `PROVIDER_ORDER` (défaut : `deepl,google,puppeteer`). Un service sans clé, au quota épuisé
ou refusé est sauté, et les textes restants passent au suivant.

| Service | Variable | Pause automatique si… |
|---|---|---|
| DeepL | `DEEPL_API_KEY` | quota épuisé : 1 h · clé refusée : 24 h · trop de requêtes : 30 s |
| Google Cloud Translation v2 | `GOOGLE_API_KEY` | idem |
| Google Traduction via Puppeteer | `ENABLE_PUPPETEER=true` | captcha ou 5 échecs d'affilée : 10 min |

## Limites des API

> Chiffres vérifiés dans la documentation officielle en octobre 2026. Les offres changent : en cas de doute,
> consultez les pages liées en bas.

### DeepL

| | API Free | API Pro |
|---|---|---|
| Caractères | **500 000 / mois** (arrêt net au-delà, reprise le mois suivant) | pas de plafond, facturation à l'usage |
| Taille d'une requête | 128 KiB | 128 KiB |
| Textes par requête | 50 | 50 |
| Endpoint | `api-free.deepl.com` (clé finissant par `:fx`) | `api.deepl.com` |

- Les caractères comptés sont ceux du texte **source** (points de code Unicode). Les balises `<x>n</x>` utilisées
  pour protéger les variables ne comptent pas comme du texte à traduire, mais le texte reste facturé même si la
  langue source et cible sont identiques.
- Traduire vers N langues = N fois le texte : 1 000 caractères × 5 langues = 5 000 caractères consommés.
- Quota dépassé : erreur HTTP `456` (le projet met DeepL en pause 1 h). Trop de requêtes : `429`/`529` (retry
  automatique avec délai, puis pause de 30 s).
- DeepL ne publie pas de plafond fixe de requêtes par seconde pour le texte : c'est le `429` qui fait foi.
- DeepL a fait évoluer ses formules API (offres « Developer » et « Growth » en plus de Free/Pro) : vérifiez
  les tarifs actuels sur leur site avant de passer à un plan payant.

### Google Cloud Translation v2 (Basic)

| | Valeur |
|---|---|
| Gratuit | **500 000 caractères / mois** (crédit de 10 $), **facturation obligatoirement activée** sur le projet |
| Au-delà | **20 $ par million de caractères** |
| Taille maximale d'une requête | 100 000 octets |
| Longueur recommandée par requête | 5 000 caractères |
| Caractères par minute et par projet | 6 000 000 |
| Caractères par jour | illimité |
| Requêtes v2 par minute et par projet | 300 000 |

- Tous les caractères envoyés comptent, **espaces compris** ; avec une clé API, la limite par utilisateur
  s'applique par adresse IP du client.
- Le crédit gratuit n'est pas reporté d'un mois sur l'autre.
- Avec les réglages par défaut du projet (lots de 40 textes / 8 000 caractères max), vous restez très en dessous
  de ces limites : le vrai plafond est le quota mensuel.

### Google Traduction via Puppeteer (dernier recours)

- **Aucune limite officielle, aucun contrat** : ce n'est pas une API. Les conditions d'utilisation de Google
  interdisent ce type d'automatisation.
- Concrètement : le site accepte ~5 000 caractères par saisie, mais au-delà de quelques centaines de requêtes depuis
  la même IP, un captcha (`/sorry/`) apparaît.
- Très lent : une page chargée par ligne de texte + 1 s de pause. Comptez plusieurs secondes par clé.
- Peut casser sans prévenir quand Google change son HTML (voir `PUPPETEER_RESULT_SELECTOR`).

Pour un usage régulier, préférez DeepL Free ou Google avec clé API.

## Journal des clés non traduites

Chaque clé qui n'a pas pu être traduite est ajoutée au fichier **`translation-errors.log`**
(à côté de `server.js`, ou de l'exécutable si le projet est empaqueté ; chemin modifiable avec `TRANSLATION_LOG_PATH`).
Une ligne par clé :

```
[2026-10-23T14:02:11.482Z] projet=fr lang=es clé="nested.broken" -> DeepL : quota mensuel épuisé
[2026-10-23T14:02:12.019Z] projet=fr lang=de clé="shop.title" -> variable perdue ou réponse vide du service
[2026-10-23T14:02:12.020Z] projet=fr clé="count" -> Message ICU (plural/select) non pris en charge : texte conservé tel quel.
```

- La clé est le chemin pointé (`nested.broken`), la raison vient du service qui a échoué.
- Dans le fichier de sortie, le texte **d'origine** est conservé pour ces clés : il suffit de les chercher dans le log.
- Les mêmes clés apparaissent aussi dans les avertissements de l'interface.
- Au-delà de 5 Mo, le log passe en `translation-errors.log.old` (une seule archive).
- Le journal ne bloque jamais une traduction : si l'écriture échoue, l'erreur est ignorée.

## Réglages utiles (`.env`)

| Variable | Rôle | Défaut |
|---|---|---|
| `PROVIDER_ORDER` | ordre de bascule des services | `deepl,google,puppeteer` |
| `MAX_CHARS_PER_JOB` | caractères max par traduction (toutes langues cumulées) | 100 000 |
| `RATE_LIMIT_PER_HOUR` | traductions par heure et par IP | 20 |
| `MAX_FILE_SIZE_KB` | taille max du fichier envoyé | 512 |
| `PUPPETEER_HEADLESS` | `false` = fenêtre Chrome visible (captcha, débogage) | `true` |
| `PUPPETEER_RESULT_SELECTOR` | sélecteur CSS du texte traduit si Google change sa page | voir `.env.example` |
| `TRANSLATION_LOG_PATH` | emplacement du journal | `translation-errors.log` |

## Sources

- DeepL — limites : https://developers.deepl.com/docs/resources/usage-limits
- DeepL — gros volumes : https://developers.deepl.com/docs/translate/translating-large-volumes
- Google Cloud Translation — quotas : https://docs.cloud.google.com/translate/quotas
- Google Cloud Translation — tarifs : https://cloud.google.com/translate/pricing