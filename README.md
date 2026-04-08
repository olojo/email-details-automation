# Booking Email Collector

This app extracts booking details from emails with the subject `New Public booking link`.

It has two modes:

- Paste an email into the page and extract it manually.
- Connect one or more Gmail accounts and sync matching booking emails automatically while the app is open.

## Run Locally

```bash
npm start
```

Open:

```text
http://localhost:4173/
```

## Connect Gmail

1. Create a Google Cloud project.
2. Enable the Gmail API.
3. Create an OAuth client for a web application.
4. Add this authorized redirect URI:

```text
http://localhost:4173/auth/google/callback
```

5. Create a `.env` file from `.env.example`:

```bash
cp .env.example .env
```

6. Add your Google OAuth client values:

```text
GOOGLE_CLIENT_ID=your-google-oauth-client-id
GOOGLE_CLIENT_SECRET=your-google-oauth-client-secret
GOOGLE_REDIRECT_URI=http://localhost:4173/auth/google/callback
```

7. Restart the server and click `Connect Gmail`.

Connected account tokens are stored locally in `data/accounts.json`. That file is ignored by git.

If you preview through a public tunnel, use that tunnel URL for
`GOOGLE_REDIRECT_URI` and add the matching callback URL in Google Cloud. For
example:

```text
https://your-tunnel-url/auth/google/callback
```
