# Booking Email Collector

This app extracts booking details from emails with the subject `New Public booking link`.

It has two modes:

- Paste an email into the page and extract it manually.
- Let Zapier forward matching emails into the app automatically through a webhook.

## Run Locally

```bash
npm start
```

Open:

```text
http://localhost:4173/
```

## Automate With Zapier On Netlify

1. Deploy this repo to Netlify.

2. In Netlify project settings, add these environment variables:

```text
BASE_URL=https://reeka-internal-tool.netlify.app
ZAPIER_WEBHOOK_SECRET=replace-with-your-shared-secret
AUTO_REFRESH_INTERVAL_MS=15000
```

3. Redeploy the site.

4. Open the app and copy the webhook URL and shared secret from the Zapier automation panel.

5. In Zapier, create a Zap:

- Trigger: Gmail -> New Email Matching Search
- Search query:

```text
subject:"New Public booking link"
```

- Action: Webhooks by Zapier -> POST
- URL: the webhook URL shown by the app
- Add a header:

```text
X-Zapier-Secret: your shared secret
```

- Send these fields in the body:

```json
{
  "subject": "{{Gmail Subject}}",
  "body": "{{Gmail Body Plain}}",
  "account_email": "{{Gmail To Email}}",
  "message_id": "{{Gmail Message ID}}",
  "received_at": "{{Gmail Date}}"
}
```

On Netlify, the `/api/*` routes are served by Netlify Functions, and booking
records plus the generated webhook secret are stored in Netlify Blobs.

## Local Development

You can still run the local Node version with:

```bash
npm start
```

For local-only testing, create a `.env` file from `.env.example`:

```bash
cp .env.example .env
```
