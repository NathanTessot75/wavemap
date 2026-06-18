// Wavemap — serveur backend (statique + Stripe Checkout + modération OpenAI)
require('dotenv').config();

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const multer = require('multer');
const Stripe = require('stripe');
const OpenAI = require('openai');

const PORT = process.env.PORT || 5173;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

// Clés côté serveur uniquement — jamais exposées au navigateur.
const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;
const openai = process.env.OPENAI_API_KEY ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null;

// Source de vérité des offres : le client n'envoie qu'un identifiant,
// jamais un montant (sinon n'importe qui pourrait payer 0 €).
const OFFERS = {
  single: { name: 'Vol express',          amount: 99,  passes: 1 }, // 0,99 €
  pro:    { name: 'Voyage long-courrier', amount: 499, passes: 6 }, // 4,99 €
};

const app = express();

// Mémoire des sessions confirmées payées par le webhook (id -> { offer, passes, mediaId, type }).
const paidSessions = new Map();

/* ====================== FILE D'ATTENTE DES PUBS PARTAGÉES ======================
   Les pubs payées vivent côté serveur et sont diffusées à TOUS les visiteurs.
   Jusqu'à MAX_ONAIR dirigeables volent en même temps ; chacune vole pendant
   passes × CROSS_SECONDS, puis laisse la place à la suivante dans la file. */
const CROSS_SECONDS = 35;        // doit correspondre au client
const MAX_ONAIR = 3;             // dirigeables simultanés
const UPLOAD_DIR = path.join(__dirname, 'uploads');
const ADS_FILE = path.join(__dirname, 'ads.json');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// ad : { id, sessionId, type:'image'|'video', mediaUrl, file, passes, createdAt, airStartedAt }
let ads = [];
try { ads = JSON.parse(fs.readFileSync(ADS_FILE, 'utf8')); } catch (e) { ads = []; }
function saveAds() { try { fs.writeFileSync(ADS_FILE, JSON.stringify(ads)); } catch (e) {} }

// Expire les pubs terminées et promeut les suivantes (jusqu'à MAX_ONAIR à l'antenne).
function schedule() {
  const now = Date.now();
  let changed = false;
  const expired = ads.filter(a => a.airStartedAt && now - a.airStartedAt >= a.passes * CROSS_SECONDS * 1000);
  if (expired.length) {
    expired.forEach(a => { try { fs.unlinkSync(path.join(UPLOAD_DIR, a.file)); } catch (e) {} });
    ads = ads.filter(a => !expired.includes(a));
    changed = true;
  }
  let slots = MAX_ONAIR - ads.filter(a => a.airStartedAt).length;
  for (const ad of ads) {
    if (slots <= 0) break;
    if (!ad.airStartedAt) { ad.airStartedAt = now; slots--; changed = true; }
  }
  if (changed) saveAds();
}

function enqueueAd(sessionId, type, file, passes) {
  if (!file || ads.some(a => a.sessionId === sessionId)) return;   // idempotent par session
  ads.push({
    id: crypto.randomUUID(), sessionId, type,
    mediaUrl: '/uploads/' + file, file, passes,
    createdAt: Date.now(), airStartedAt: null,
  });
  saveAds();
}

// Position dans la file d'attente (parmi les pubs PAS encore à l'antenne). 0 = déjà en vol.
function queuePositionOf(sessionId) {
  schedule();
  const waiting = ads.filter(a => !a.airStartedAt);
  const idx = waiting.findIndex(a => a.sessionId === sessionId);
  return idx >= 0 ? idx + 1 : 0;
}

// Upload du média (image/vidéo) sur le serveur
const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname) || (file.mimetype.startsWith('video/') ? '.mp4' : '.png');
      cb(null, crypto.randomUUID() + ext);
    },
  }),
  limits: { fileSize: 26 * 1024 * 1024 },   // 26 Mo
});

/* ---------- Webhook Stripe ----------
   DOIT être déclaré AVANT express.json() : la vérification de signature
   exige le corps brut (non parsé). */
app.post('/api/webhook', express.raw({ type: 'application/json' }), (req, res) => {
  if (!stripe) return res.status(503).end();

  const sig = req.headers['stripe-signature'];
  const whSecret = process.env.STRIPE_WEBHOOK_SECRET;
  let event;
  try {
    // Si un secret est configuré, on vérifie la signature (recommandé).
    // Sinon on parse directement (utile tant que le webhook n'est pas branché).
    event = whSecret
      ? stripe.webhooks.constructEvent(req.body, sig, whSecret)
      : JSON.parse(req.body);
  } catch (e) {
    console.error('[webhook] signature invalide :', e.message);
    return res.status(400).send(`Webhook Error: ${e.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const m = session.metadata || {};
    const passes = (OFFERS[m.offer] || {}).passes || 1;
    paidSessions.set(session.id, { offer: m.offer, passes, mediaId: m.mediaId, type: m.type });
    enqueueAd(session.id, m.type || 'image', m.mediaId, passes);
    console.log(`[webhook] paiement confirmé : ${session.id} — ${(session.amount_total || 0) / 100} ${session.currency}`);
  }

  res.json({ received: true });
});

app.use(express.json({ limit: '12mb' })); // les images en dataURL peuvent être volumineuses

/* ---------- Modération du contenu (OpenAI) ---------- */
app.post('/api/moderate', async (req, res) => {
  if (!openai) {
    return res.status(503).json({ error: 'config', message: "OPENAI_API_KEY absente du fichier .env" });
  }
  const { image } = req.body || {};
  if (!image) return res.status(400).json({ error: 'no_image', message: 'Aucune image fournie' });

  try {
    const result = await openai.moderations.create({
      model: 'omni-moderation-latest',
      input: [{ type: 'image_url', image_url: { url: image } }],
    });
    const r = result.results[0];
    const flaggedCategories = Object.entries(r.categories)
      .filter(([, v]) => v)
      .map(([k]) => k);
    return res.json({ flagged: r.flagged, categories: flaggedCategories });
  } catch (e) {
    console.error('[moderate]', e.message);
    return res.status(502).json({ error: 'moderation_failed', message: e.message });
  }
});

/* ---------- Upload du média (image/vidéo) sur le serveur ---------- */
app.post('/api/upload', upload.single('media'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'no_file', message: 'Aucun fichier' });
  const type = req.file.mimetype.startsWith('video/') ? 'video' : 'image';
  return res.json({ mediaId: req.file.filename, url: '/uploads/' + req.file.filename, type });
});

/* ---------- Création de la session Stripe Checkout ---------- */
app.post('/api/create-checkout-session', async (req, res) => {
  if (!stripe) {
    return res.status(503).json({ error: 'config', message: "STRIPE_SECRET_KEY absente du fichier .env" });
  }
  const body = req.body || {};
  const offer = OFFERS[body.offer];
  if (!offer) return res.status(400).json({ error: 'bad_offer', message: 'Offre inconnue' });
  // le média doit avoir été uploadé au préalable
  if (!body.mediaId || !fs.existsSync(path.join(UPLOAD_DIR, body.mediaId))) {
    return res.status(400).json({ error: 'no_media', message: 'Média manquant — réessayez.' });
  }

  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: [{
        quantity: 1,
        price_data: {
          currency: 'eur',
          unit_amount: offer.amount,
          product_data: { name: `Wavemap — ${offer.name}` },
        },
      }],
      success_url: `${BASE_URL}/?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${BASE_URL}/?checkout=cancel`,
      metadata: { offer: body.offer, mediaId: body.mediaId, type: body.type || 'image' },
    });
    return res.json({ url: session.url });
  } catch (e) {
    console.error('[checkout]', e.message);
    return res.status(502).json({ error: 'stripe_failed', message: e.message });
  }
});

/* ---------- Vérification de la session après retour de Stripe ---------- */
app.get('/api/verify-session', async (req, res) => {
  if (!stripe) return res.status(503).json({ error: 'config' });
  const { session_id } = req.query;
  if (!session_id) return res.status(400).json({ error: 'no_session' });

  // 1) Confirmation immédiate si le webhook a déjà validé ce paiement.
  if (paidSessions.has(session_id)) {
    const rec = paidSessions.get(session_id);
    enqueueAd(session_id, rec.type || 'image', rec.mediaId, rec.passes);
    return res.json({ paid: true, passes: rec.passes, queuePosition: queuePositionOf(session_id), source: 'webhook' });
  }

  // 2) Repli : interrogation directe de Stripe (fiable même sans webhook branché).
  try {
    const session = await stripe.checkout.sessions.retrieve(session_id);
    const m = session.metadata || {};
    const paid = session.payment_status === 'paid';
    const passes = (OFFERS[m.offer] || {}).passes || 1;
    if (paid) enqueueAd(session_id, m.type || 'image', m.mediaId, passes);
    return res.json({ paid, passes, queuePosition: paid ? queuePositionOf(session_id) : 0, source: 'api' });
  } catch (e) {
    console.error('[verify]', e.message);
    return res.status(502).json({ error: 'verify_failed', message: e.message });
  }
});

/* ---------- Pubs actuellement à l'antenne (interrogé par tous les globes) ---------- */
app.get('/api/onair', (req, res) => {
  schedule();
  const onAir = ads.filter(a => a.airStartedAt).slice(0, MAX_ONAIR)
    .map(a => ({ id: a.id, type: a.type, url: a.mediaUrl, airStartedAt: a.airStartedAt }));
  res.json({ ads: onAir, total: ads.length });
});

/* ---------- Médias des pubs (servis publiquement à tous les visiteurs) ---------- */
app.use('/uploads', express.static(UPLOAD_DIR));

/* ---------- Fichiers statiques (index.html, fonts, blimps…) ----------
   dotfiles:'ignore' (défaut) => le .env n'est jamais servi. */
app.use(express.static(__dirname));

app.listen(PORT, () => {
  console.log(`\n  Wavemap  →  ${BASE_URL}`);
  console.log(`  Stripe   : ${stripe ? 'OK' : 'NON configuré (.env)'}`);
  console.log(`  OpenAI   : ${openai ? 'OK' : 'NON configuré (.env)'}\n`);
});
