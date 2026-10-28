# Wavemap: payments and moderation setup

The site is served by a small Node server (`server.js`) that also handles Stripe payments and automatic moderation of user visuals (OpenAI).

## 1. Get the keys (test mode, free)

### Stripe (secret test key)
1. Create an account on https://stripe.com.
2. Stay in **Test mode** (toggle at the top right of the dashboard).
3. Go to **Developers → API keys**.
4. Copy the **secret key**, which starts with `sk_test_...`.

### OpenAI (moderation)
1. Go to https://platform.openai.com/api-keys.
2. Create a key and copy it (it starts with `sk-...`).
3. Moderation uses the free `omni-moderation-latest` model.

## 2. Fill in the `.env` file

Copy `.env.example` to `.env` at the project root and paste your keys:

```
STRIPE_SECRET_KEY=sk_test_xxxxxxxxxxxxx
OPENAI_API_KEY=sk-xxxxxxxxxxxxx
PORT=5173
BASE_URL=http://localhost:5173
```

> `.env` is never sent to the browser nor committed (see `.gitignore`).

## 3. Run

```
npm start
```

Then open http://localhost:5173.

## 4. Test a payment (Stripe test card)

On the Stripe payment page, use:
- Number: **4242 4242 4242 4242**
- Any future date, any 3-digit CVC, any postal code

No real money is charged in test mode.

## Full flow

1. The user draws or uploads a visual and clicks the take-off button.
2. The visual is sent to `/api/moderate` (OpenAI). If it is inappropriate, it is rejected.
3. Otherwise a Stripe Checkout session is created and the user is redirected to the payment page.
4. On return (`?checkout=success`), the server verifies the payment (`/api/verify-session`) and the visual appears on the blimp.

## Offers (defined server-side, in `server.js`)

| id     | name                  | price  | passes |
|--------|-----------------------|--------|--------|
| single | Express flight        | €0.99  | 1      |
| pro    | Long-haul journey     | €4.99  | 6      |

The amount is **always** decided by the server: the browser only sends an offer id.

## Stripe webhook (reliability)

The site works **without** a webhook: on return from Stripe, the server queries the Stripe API directly (`/api/verify-session`) to confirm the payment. The webhook adds a confirmation that is **server-side, instant and independent of the browser**.

### Test the webhook locally (Stripe CLI)
1. Install the Stripe CLI: https://stripe.com/docs/stripe-cli (on macOS: `brew install stripe/stripe-cli/stripe`).
2. Log in: `stripe login`
3. Start listening (keep this terminal open):
   ```
   stripe listen --forward-to localhost:5173/api/webhook
   ```
4. The CLI prints a `whsec_...` secret. Paste it into `.env`:
   ```
   STRIPE_WEBHOOK_SECRET=whsec_xxxxxxxx
   ```
5. Restart the server (`npm start`). Each test payment now triggers the `checkout.session.completed` event, visible in the CLI terminal **and** in the server logs.

> Without `STRIPE_WEBHOOK_SECRET`, the `/api/webhook` endpoint stays active but without signature verification. Do NOT leave it like that in production.

## Shared ads (queue and broadcast)

Paid ads are **shared**: every visitor sees the same blimps.

1. On creation, the media (image or video) is **uploaded to the server** (`POST /api/upload` → `uploads/` folder).
2. Once the payment is confirmed (webhook or `verify-session`), the ad joins the **queue** (`ads.json`).
3. The server keeps up to **3 ads on air** at the same time; each flies for `passes × 35 s`, then makes room for the next one.
4. Every globe polls `GET /api/onair` about every 4 s and displays the ads currently on air.

**Generated files (ignored by git):** `uploads/` (media) and `ads.json` (queue). Deleting them resets the queue.

**Settings** (in `server.js`): `MAX_ONAIR` (simultaneous blimps) and `CROSS_SECONDS` (duration of one pass, must match the client in `index.html`).

## Production

- Switch to **live** keys (`sk_live_...`) and host the server (Railway, Render, Fly.io…).
- Configure the webhook in **Stripe → Developers → Webhooks** with your server's public URL.
- To scale: replace `ads.json` + `uploads/` with a **database** and object storage (S3…), clean up **orphan** media from cancelled payments with a periodic job, and consider **WebSockets** instead of polling.
