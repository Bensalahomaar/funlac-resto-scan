# Scan facture — Azure quotidien + Relire Gemini

Le navigateur n’appelle pas Azure ni Gemini (pas de CORS, pas de clé dans le client).
La Cloud Function `scanInvoice` envoie le document à Azure `prebuilt-invoice`.
Sur la page Vérification, **Relire avec Gemini** appelle `rereadInvoice` (quota gratuit ~5–6/jour).

Palier Azure **F0** : 500 pages/mois **sans date de fin**, 2 pages/requête, 4 Mo, 1 req/s.
Ne pas passer en S0.

## 1. Ressource Azure (gratuit permanent)

1. Compte Azure (abonnement gratuit ou payant, F0 ne facture rien dans le quota).
2. [Créer une ressource Document Intelligence](https://portal.azure.com/#create/Microsoft.CognitiveServicesFormRecognizer) :
   - Région : **West Europe** ou **France Central**
   - Tarif : **F0** (Free)
   - Nom : par ex. `funlac-di`
3. Dans la ressource → **Clés et point de terminaison** :
   - copier **Endpoint** (`https://….cognitiveservices.azure.com`)
   - copier **Clé 1**
4. Ne jamais coller la clé dans le client, Firestore, ou le dépôt Git.

## 2. Gemini (relecture manuelle)

1. Créer une clé dans [Google AI Studio](https://aistudio.google.com/apikey).
2. Dans l’app (compte **admin**) : **Mon compte** ou **Nouvelle facture** → coller la clé.
   Ça suffit pour renouveler tous les 5–6 jours, **sans ouvrir le code**.
3. En local, la clé va aussi dans `functions/.env` (ignoré par git).
4. En prod, Cloud Function `rereadInvoice` lit Firestore `settings/gemini` (illisible depuis le navigateur).
5. Ne jamais committer la clé. `localStorage` et `VITE_GEMINI_API_KEY` ne sont plus utilisés.

## 3. Firebase Blaze (obligatoire en prod)

Spark **bloque les appels HTTP sortants**. Sans Blaze, la Function ne peut pas
joindre Azure / Gemini.

1. [Console Firebase](https://console.firebase.google.com/project/funlac-resto/usage/details) → modifier le forfait → **Blaze**.
2. Le palier gratuit Functions couvre largement ~500 scans/mois.
3. Un plafond budgétaire (ex. 2 €) évite les surprises.

## 4. Secrets Functions

```bash
firebase functions:secrets:set AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT
firebase functions:secrets:set AZURE_DOCUMENT_INTELLIGENCE_KEY
firebase functions:secrets:set GEMINI_API_KEY
```

Coller l’endpoint (sans slash final) puis les clés. En local / émulateur, copier
`.env.example` vers `.env` (ignoré par git).

## 5. Déploiement

```bash
npm --prefix functions install
npm run deploy:all
```

`npm run deploy` reste hosting + Firestore uniquement, tant que Blaze / secrets
ne sont pas en place.

L’app appelle `scanInvoice` et `rereadInvoice` en `europe-west1`. Badge scan :
**Lecture facture Azure**. Relecture : bouton **Relire avec Gemini** sur la revue.

Les Functions sont **publiques** (pas d’Auth Firebase : l’app utilise le login local FUNLAC).
Les clés restent côté serveur. Les quotas Azure F0 et Gemini gratuit limitent l’abus.
