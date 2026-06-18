# Wavemap — Paiement & modération

Le site est maintenant servi par un petit serveur Node (`server.js`) qui gère aussi
le paiement Stripe et la vérification automatique des visuels (OpenAI).

## 1. Récupérer les clés (mode test, gratuit)

### Stripe (clé secrète de test)
1. Crée un compte sur https://stripe.com (gratuit).
2. Reste en **Mode test** (interrupteur en haut à droite du tableau de bord).
3. Va dans **Développeurs → Clés API**.
4. Copie la **clé secrète** qui commence par `sk_test_...`.

### OpenAI (modération)
1. Va sur https://platform.openai.com/api-keys
2. Crée une clé, copie-la (commence par `sk-...`).
3. La modération utilise le modèle gratuit `omni-moderation-latest`.

## 2. Renseigner le fichier `.env`

Ouvre `.env` à la racine et colle tes clés :

```
STRIPE_SECRET_KEY=sk_test_xxxxxxxxxxxxx
OPENAI_API_KEY=sk-xxxxxxxxxxxxx
PORT=5173
BASE_URL=http://localhost:5173
```

> Le `.env` n'est jamais envoyé au navigateur ni commité (voir `.gitignore`).

## 3. Lancer

```
npm start
```

Puis ouvre http://localhost:5173

## 4. Tester un paiement (carte de test Stripe)

Dans la page de paiement Stripe, utilise :
- Numéro : **4242 4242 4242 4242**
- Date : n'importe quelle date future · CVC : n'importe quel 3 chiffres · Code postal : n'importe lequel

Aucune somme réelle n'est débitée en mode test.

## Flux complet
1. L'utilisateur dessine / importe un visuel → clique « Paré au décollage ».
2. Le visuel est envoyé à `/api/moderate` (OpenAI). S'il est inapproprié → refusé.
3. Sinon → création d'une session Stripe Checkout → redirection vers la page de paiement.
4. Au retour (`?checkout=success`), le serveur vérifie le paiement (`/api/verify-session`)
   puis le visuel s'affiche sur le dirigeable.

## Offres (définies côté serveur, dans `server.js`)
| id     | nom                   | prix   | passages |
|--------|-----------------------|--------|----------|
| single | Vol express           | 0,99 € | 1        |
| pro    | Voyage long-courrier  | 4,99 € | 6        |

Le montant est **toujours** décidé par le serveur — le navigateur n'envoie qu'un identifiant d'offre.

## Webhook Stripe (fiabilité)

Le site fonctionne **sans** webhook : au retour de Stripe, le serveur interroge directement
l'API Stripe (`/api/verify-session`) pour confirmer le paiement. Le webhook ajoute une
confirmation **côté serveur, instantanée et indépendante du navigateur**.

### Tester le webhook en local (Stripe CLI)
1. Installe la CLI Stripe : https://stripe.com/docs/stripe-cli (sur Mac : `brew install stripe/stripe-cli/stripe`).
2. Connecte-la : `stripe login`
3. Lance l'écoute (laisse ce terminal ouvert) :
   ```
   stripe listen --forward-to localhost:5173/api/webhook
   ```
4. La CLI affiche un secret `whsec_...`. Colle-le dans `.env` :
   ```
   STRIPE_WEBHOOK_SECRET=whsec_xxxxxxxx
   ```
5. Relance le serveur (`npm start`). Désormais, chaque paiement de test déclenche
   l'événement `checkout.session.completed`, visible dans le terminal de la CLI **et**
   dans les logs du serveur (`[webhook] paiement confirmé : …`).

> Sans `STRIPE_WEBHOOK_SECRET`, le endpoint `/api/webhook` reste actif mais sans
> vérification de signature — à NE PAS laisser ainsi en production.

## Système de pubs partagé (file d'attente + diffusion)

Les pubs payées sont **partagées** : tous les visiteurs voient les mêmes dirigeables.

**Comment ça marche :**
1. À la création, le média (image/vidéo) est **uploadé sur le serveur** (`POST /api/upload` → dossier `uploads/`).
2. Au paiement validé (webhook ou `verify-session`), la pub rejoint la **file** (`ads.json`).
3. Le serveur met jusqu'à **3 pubs à l'antenne** simultanément ; chacune vole pendant
   `passes × 35 s`, puis laisse la place à la suivante dans la file.
4. Tous les globes interrogent `GET /api/onair` toutes les ~4 s et affichent les pubs en cours.

**Fichiers générés (ignorés par git) :** `uploads/` (médias) et `ads.json` (file). Les supprimer remet la file à zéro.

**Réglages** (dans `server.js`) : `MAX_ONAIR` (dirigeables simultanés) et `CROSS_SECONDS` (durée d'un passage, doit matcher le client dans `index.html`).

## Pour la production (plus tard)
- Passer les clés en mode **live** (`sk_live_...`) et héberger le serveur (Render, Railway, Fly.io…).
- Configurer le webhook dans **Stripe → Développeurs → Webhooks** (URL publique de ton serveur).
- Remplacer `ads.json` + `uploads/` par une **base de données** + un stockage objet (S3…) pour passer à l'échelle.
- Nettoyer les médias **orphelins** (uploads de paiements annulés) via une tâche périodique.
- Éventuellement passer le polling en **WebSocket** pour du vrai temps réel.
