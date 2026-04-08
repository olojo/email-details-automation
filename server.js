const crypto = require("node:crypto");
const fsSync = require("node:fs");
const fs = require("node:fs/promises");
const http = require("node:http");
const path = require("node:path");
const { URL } = require("node:url");

const {
  SUBJECT_FILTER,
  parseBookingEmail,
} = require("./parser.js");

loadEnvFile();

const PORT = Number(process.env.PORT || 4173);
const HOST = process.env.HOST || "127.0.0.1";
const BASE_URL =
  process.env.BASE_URL || process.env.GOOGLE_BASE_URL || `http://localhost:${PORT}`;
const GOOGLE_REDIRECT_URI =
  process.env.GOOGLE_REDIRECT_URI || `${BASE_URL}/auth/google/callback`;
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "";
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || "";
const GMAIL_SYNC_QUERY =
  process.env.GMAIL_SYNC_QUERY || `subject:"${SUBJECT_FILTER}" newer_than:30d`;
const GMAIL_MAX_RESULTS = Number(process.env.GMAIL_MAX_RESULTS || 25);
const DATA_DIR = path.join(__dirname, "data");
const ACCOUNTS_FILE = path.join(DATA_DIR, "accounts.json");
const OAUTH_STATES = new Map();
const GOOGLE_SCOPES = [
  "openid",
  "email",
  "https://www.googleapis.com/auth/gmail.readonly",
];

const server = http.createServer((request, response) => {
  handleRequest(request, response).catch((error) => {
    console.error(error);
    sendJson(response, 500, {
      error: "server_error",
      message: error.message || "Something went wrong.",
    });
  });
});

server.listen(PORT, HOST, () => {
  console.log(`Booking email app running at http://${HOST}:${PORT}/`);
  console.log(`Google OAuth redirect URI: ${GOOGLE_REDIRECT_URI}`);
});

async function handleRequest(request, response) {
  const requestUrl = new URL(request.url, `http://${request.headers.host}`);

  if (request.method === "GET" && requestUrl.pathname === "/api/accounts") {
    const store = await readAccountStore();
    sendJson(response, 200, {
      configured: isGoogleConfigured(),
      accounts: store.accounts.map(safeAccount),
    });
    return;
  }

  if (request.method === "GET" && requestUrl.pathname === "/auth/google/start") {
    handleGoogleStart(response);
    return;
  }

  if (
    request.method === "GET" &&
    requestUrl.pathname === "/auth/google/callback"
  ) {
    await handleGoogleCallback(requestUrl, response);
    return;
  }

  if (request.method === "POST" && requestUrl.pathname === "/api/sync") {
    await handleSync(response);
    return;
  }

  const disconnectMatch = requestUrl.pathname.match(
    /^\/api\/accounts\/([^/]+)\/disconnect$/,
  );

  if (request.method === "DELETE" && disconnectMatch) {
    await handleDisconnect(disconnectMatch[1], response);
    return;
  }

  await serveStatic(requestUrl, response);
}

function handleGoogleStart(response) {
  if (!isGoogleConfigured()) {
    redirect(response, "/?error=missing-google-config");
    return;
  }

  const state = crypto.randomBytes(24).toString("hex");
  OAUTH_STATES.set(state, Date.now());
  pruneOldStates();

  const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  authUrl.searchParams.set("client_id", GOOGLE_CLIENT_ID);
  authUrl.searchParams.set("redirect_uri", GOOGLE_REDIRECT_URI);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("scope", GOOGLE_SCOPES.join(" "));
  authUrl.searchParams.set("access_type", "offline");
  authUrl.searchParams.set("include_granted_scopes", "true");
  authUrl.searchParams.set("prompt", "consent select_account");
  authUrl.searchParams.set("state", state);

  redirect(response, authUrl.toString());
}

async function handleGoogleCallback(requestUrl, response) {
  const error = requestUrl.searchParams.get("error");
  const code = requestUrl.searchParams.get("code");
  const state = requestUrl.searchParams.get("state");

  if (error) {
    redirect(response, `/?error=${encodeURIComponent(error)}`);
    return;
  }

  if (!code || !state || !OAUTH_STATES.has(state)) {
    redirect(response, "/?error=invalid-oauth-state");
    return;
  }

  OAUTH_STATES.delete(state);

  const tokens = await exchangeCodeForTokens(code);
  const email = await fetchGoogleEmail(tokens.access_token);
  const accountId = createAccountId("gmail", email);
  const store = await readAccountStore();
  const existingAccount = store.accounts.find((account) => account.id === accountId);
  const account = {
    id: accountId,
    provider: "gmail",
    email,
    connectedAt: existingAccount?.connectedAt || new Date().toISOString(),
    lastSyncedAt: existingAccount?.lastSyncedAt || "",
    tokens: {
      ...existingAccount?.tokens,
      ...tokens,
      refresh_token: tokens.refresh_token || existingAccount?.tokens?.refresh_token,
    },
  };

  store.accounts = [
    account,
    ...store.accounts.filter((storedAccount) => storedAccount.id !== accountId),
  ];

  await writeAccountStore(store);
  redirect(response, `/?connected=${encodeURIComponent(email)}`);
}

async function handleSync(response) {
  const store = await readAccountStore();
  const records = [];
  const errors = [];

  for (const account of store.accounts) {
    try {
      const accountRecords = await syncGmailAccount(account);
      account.lastSyncedAt = new Date().toISOString();
      records.push(...accountRecords);
    } catch (error) {
      errors.push({
        accountId: account.id,
        email: account.email,
        message: error.message,
      });
    }
  }

  await writeAccountStore(store);

  sendJson(response, errors.length ? 207 : 200, {
    records,
    accounts: store.accounts.map(safeAccount),
    errors,
  });
}

async function handleDisconnect(accountId, response) {
  const store = await readAccountStore();
  const account = store.accounts.find((storedAccount) => storedAccount.id === accountId);

  if (!account) {
    sendJson(response, 404, {
      error: "not_found",
      message: "That email account is not connected.",
    });
    return;
  }

  await revokeGoogleToken(account.tokens.refresh_token || account.tokens.access_token);
  store.accounts = store.accounts.filter(
    (storedAccount) => storedAccount.id !== accountId,
  );
  await writeAccountStore(store);

  sendJson(response, 200, {
    accounts: store.accounts.map(safeAccount),
  });
}

async function syncGmailAccount(account) {
  const accessToken = await getValidAccessToken(account);
  const listUrl = new URL("https://gmail.googleapis.com/gmail/v1/users/me/messages");
  listUrl.searchParams.set("q", GMAIL_SYNC_QUERY);
  listUrl.searchParams.set("maxResults", String(GMAIL_MAX_RESULTS));

  const listResult = await googleJson(listUrl, accessToken);
  const messages = listResult.messages || [];
  const records = [];

  for (const message of messages) {
    const detailUrl = new URL(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages/${message.id}`,
    );
    detailUrl.searchParams.set("format", "full");

    const messageDetail = await googleJson(detailUrl, accessToken);
    const subject = findHeader(messageDetail.payload?.headers, "Subject");

    if (!subject.toLowerCase().includes(SUBJECT_FILTER.toLowerCase())) {
      continue;
    }

    const emailText =
      extractMessageText(messageDetail.payload) || messageDetail.snippet || "";
    const parsed = parseBookingEmail(`Subject: ${subject}\n\n${emailText}`);

    if (!parsed.hasAnyField) {
      continue;
    }

    records.push({
      id: `gmail:${account.id}:${messageDetail.id}`,
      sourceId: `gmail:${account.id}:${messageDetail.id}`,
      source: "gmail",
      provider: "gmail",
      accountEmail: account.email,
      messageId: messageDetail.id,
      threadId: messageDetail.threadId,
      receivedAt: messageDetail.internalDate
        ? new Date(Number(messageDetail.internalDate)).toISOString()
        : "",
      collectedAt: new Date().toISOString(),
      subjectMatched: parsed.subjectMatched,
      ...parsed.values,
    });
  }

  return records;
}

async function getValidAccessToken(account) {
  const expiryDate = Number(account.tokens.expiry_date || 0);

  if (account.tokens.access_token && Date.now() < expiryDate - 60_000) {
    return account.tokens.access_token;
  }

  if (!account.tokens.refresh_token) {
    throw new Error(`Reconnect ${account.email}; no refresh token was saved.`);
  }

  const refreshedTokens = await refreshAccessToken(account.tokens.refresh_token);
  account.tokens = {
    ...account.tokens,
    ...refreshedTokens,
    refresh_token: account.tokens.refresh_token,
  };

  return account.tokens.access_token;
}

async function exchangeCodeForTokens(code) {
  const tokenResult = await postGoogleForm("https://oauth2.googleapis.com/token", {
    code,
    client_id: GOOGLE_CLIENT_ID,
    client_secret: GOOGLE_CLIENT_SECRET,
    redirect_uri: GOOGLE_REDIRECT_URI,
    grant_type: "authorization_code",
  });

  return normalizeGoogleTokens(tokenResult);
}

async function refreshAccessToken(refreshToken) {
  const tokenResult = await postGoogleForm("https://oauth2.googleapis.com/token", {
    refresh_token: refreshToken,
    client_id: GOOGLE_CLIENT_ID,
    client_secret: GOOGLE_CLIENT_SECRET,
    grant_type: "refresh_token",
  });

  return normalizeGoogleTokens(tokenResult);
}

function normalizeGoogleTokens(tokens) {
  return {
    ...tokens,
    expiry_date: tokens.expires_in
      ? Date.now() + Number(tokens.expires_in) * 1000
      : Date.now() + 3600 * 1000,
  };
}

async function fetchGoogleEmail(accessToken) {
  const userInfo = await googleJson(
    "https://openidconnect.googleapis.com/v1/userinfo",
    accessToken,
  );

  if (userInfo.email) {
    return userInfo.email;
  }

  const profile = await googleJson(
    "https://gmail.googleapis.com/gmail/v1/users/me/profile",
    accessToken,
  );

  return profile.emailAddress;
}

async function postGoogleForm(url, fields) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(fields),
  });

  const body = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(body.error_description || body.error || response.statusText);
  }

  return body;
}

async function googleJson(url, accessToken) {
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });
  const body = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(body.error?.message || body.error || response.statusText);
  }

  return body;
}

async function revokeGoogleToken(token) {
  if (!token) {
    return;
  }

  await fetch("https://oauth2.googleapis.com/revoke", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ token }),
  }).catch(() => undefined);
}

function extractMessageText(payload) {
  if (!payload) {
    return "";
  }

  const plainParts = [];
  const htmlParts = [];

  collectMessageParts(payload, plainParts, htmlParts);

  return plainParts.join("\n\n") || htmlParts.join("\n\n");
}

function collectMessageParts(part, plainParts, htmlParts) {
  const bodyData = part.body?.data;

  if (bodyData && part.mimeType === "text/plain") {
    plainParts.push(decodeBase64Url(bodyData));
  }

  if (bodyData && part.mimeType === "text/html") {
    htmlParts.push(decodeBase64Url(bodyData));
  }

  (part.parts || []).forEach((childPart) =>
    collectMessageParts(childPart, plainParts, htmlParts),
  );
}

function decodeBase64Url(value) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(
    normalized.length + ((4 - (normalized.length % 4)) % 4),
    "=",
  );

  return Buffer.from(padded, "base64").toString("utf8");
}

function findHeader(headers = [], name) {
  return (
    headers.find((header) => header.name.toLowerCase() === name.toLowerCase())
      ?.value || ""
  );
}

async function serveStatic(requestUrl, response) {
  const safePath = requestUrl.pathname === "/" ? "/index.html" : requestUrl.pathname;
  const decodedPath = decodeURIComponent(safePath);
  const allowedFiles = new Set([
    "/app.js",
    "/index.html",
    "/parser.js",
    "/styles.css",
  ]);

  if (!allowedFiles.has(decodedPath)) {
    sendText(response, 404, "Not found");
    return;
  }

  const filePath = path.normalize(path.join(__dirname, decodedPath));

  if (!filePath.startsWith(__dirname)) {
    sendText(response, 403, "Forbidden");
    return;
  }

  try {
    const file = await fs.readFile(filePath);
    response.writeHead(200, {
      "Content-Type": contentTypeFor(filePath),
    });
    response.end(file);
  } catch (error) {
    if (error.code === "ENOENT") {
      sendText(response, 404, "Not found");
      return;
    }

    throw error;
  }
}

function contentTypeFor(filePath) {
  const extension = path.extname(filePath);
  const contentTypes = {
    ".css": "text/css; charset=utf-8",
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
  };

  return contentTypes[extension] || "application/octet-stream";
}

async function readAccountStore() {
  try {
    const contents = await fs.readFile(ACCOUNTS_FILE, "utf8");
    const store = JSON.parse(contents);

    return {
      accounts: Array.isArray(store.accounts) ? store.accounts : [],
    };
  } catch (error) {
    if (error.code === "ENOENT") {
      return { accounts: [] };
    }

    throw error;
  }
}

async function writeAccountStore(store) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(
    ACCOUNTS_FILE,
    JSON.stringify({ accounts: store.accounts }, null, 2),
  );
}

function safeAccount(account) {
  return {
    id: account.id,
    provider: account.provider,
    email: account.email,
    connectedAt: account.connectedAt,
    lastSyncedAt: account.lastSyncedAt,
  };
}

function isGoogleConfigured() {
  return Boolean(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET);
}

function createAccountId(provider, email) {
  return crypto
    .createHash("sha256")
    .update(`${provider}:${email.toLowerCase()}`)
    .digest("hex")
    .slice(0, 24);
}

function pruneOldStates() {
  const tenMinutesAgo = Date.now() - 10 * 60 * 1000;

  for (const [state, createdAt] of OAUTH_STATES.entries()) {
    if (createdAt < tenMinutesAgo) {
      OAUTH_STATES.delete(state);
    }
  }
}

function redirect(response, location) {
  response.writeHead(302, { Location: location });
  response.end();
}

function sendJson(response, statusCode, body) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(body));
}

function sendText(response, statusCode, body) {
  response.writeHead(statusCode, {
    "Content-Type": "text/plain; charset=utf-8",
  });
  response.end(body);
}

function loadEnvFile() {
  const envPath = path.join(__dirname, ".env");

  try {
    const contents = fsSync.readFileSync(envPath, "utf8");

    contents.split(/\r?\n/).forEach((line) => {
      const trimmedLine = line.trim();

      if (!trimmedLine || trimmedLine.startsWith("#")) {
        return;
      }

      const separatorIndex = trimmedLine.indexOf("=");

      if (separatorIndex === -1) {
        return;
      }

      const key = trimmedLine.slice(0, separatorIndex).trim();
      const value = trimmedLine
        .slice(separatorIndex + 1)
        .trim()
        .replace(/^['"]|['"]$/g, "");

      if (!process.env[key]) {
        process.env[key] = value;
      }
    });
  } catch (error) {
    if (error.code !== "ENOENT") {
      console.warn(`Could not load .env: ${error.message}`);
    }
  }
}
