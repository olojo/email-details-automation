const crypto = require("node:crypto");
const fsSync = require("node:fs");
const fs = require("node:fs/promises");
const http = require("node:http");
const path = require("node:path");
const { URL } = require("node:url");

const {
  SUBJECT_FILTER,
  parseBookingEmail,
  normalizePaymentStatus,
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
const AUTO_REFRESH_INTERVAL_MS = Number(
  process.env.AUTO_REFRESH_INTERVAL_MS || 15_000,
);
const DATA_DIR = path.join(__dirname, "data");
const APP_SETTINGS_FILE = path.join(DATA_DIR, "app-settings.json");
const ACCOUNTS_FILE = path.join(DATA_DIR, "accounts.json");
const RECORDS_FILE = path.join(DATA_DIR, "records.json");
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
  console.log(`Zapier webhook URL: ${BASE_URL}/api/zapier/bookings`);
});

async function handleRequest(request, response) {
  const requestUrl = new URL(request.url, `http://${request.headers.host}`);
  const recordMatch = requestUrl.pathname.match(/^\/api\/records\/([^/]+)$/);

  if (request.method === "GET" && requestUrl.pathname === "/api/zapier/config") {
    await handleZapierConfig(response);
    return;
  }

  if (request.method === "POST" && requestUrl.pathname === "/api/zapier/bookings") {
    await handleZapierBooking(request, requestUrl, response);
    return;
  }

  if (request.method === "GET" && requestUrl.pathname === "/api/records") {
    await handleRecordList(response);
    return;
  }

  if (request.method === "POST" && requestUrl.pathname === "/api/records") {
    await handleRecordCreate(request, response);
    return;
  }

  if (request.method === "PATCH" && recordMatch) {
    await handleRecordUpdate(recordMatch[1], request, response);
    return;
  }

  if (request.method === "DELETE" && recordMatch) {
    await handleRecordDelete(recordMatch[1], response);
    return;
  }

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

async function handleZapierConfig(response) {
  sendJson(response, 200, {
    webhookUrl: `${BASE_URL}/api/zapier/bookings`,
    secret: await getZapierWebhookSecret(),
    pollIntervalMs: AUTO_REFRESH_INTERVAL_MS,
    subjectFilter: SUBJECT_FILTER,
  });
}

async function handleZapierBooking(request, requestUrl, response) {
  const payload = await readRequestBody(request);
  const providedSecret =
    request.headers["x-zapier-secret"] ||
    payload.secret ||
    requestUrl.searchParams.get("secret") ||
    "";
  const expectedSecret = await getZapierWebhookSecret();

  if (!providedSecret || providedSecret !== expectedSecret) {
    sendJson(response, 401, {
      error: "invalid_secret",
      message: "The Zapier webhook secret is missing or invalid.",
    });
    return;
  }

  const subject = firstNonEmpty([
    payload.subject,
    payload.email_subject,
    payload.title,
  ]);
  const body = firstNonEmpty([
    payload.body,
    payload.plain_body,
    payload.body_plain,
    payload.text,
    payload.html_body,
    payload.description,
    payload.raw_email,
  ]);
  const accountEmail = firstNonEmpty([
    payload.account_email,
    payload.inbox_email,
    payload.to_email,
    payload.to,
  ]);
  const messageId = firstNonEmpty([
    payload.message_id,
    payload.gmail_message_id,
    payload.email_id,
    payload.id,
  ]);
  const sourceId =
    firstNonEmpty([payload.source_id, payload.sourceId]) ||
    createWebhookSourceId({
      accountEmail,
      body,
      messageId,
      subject,
    });
  const receivedAt = normalizeOptionalDate(
    firstNonEmpty([
      payload.received_at,
      payload.receivedAt,
      payload.date,
      payload.sent_at,
      payload.internal_date,
    ]),
  );
  const parsed = parseBookingEmail(`Subject: ${subject}\n\n${body}`);

  if (!parsed.hasAnyField) {
    sendJson(response, 422, {
      error: "no_booking_fields",
      message:
        "The incoming payload did not include any booking fields the parser could extract.",
    });
    return;
  }

  const store = await readRecordStore();
  const existingRecord = store.records.find(
    (record) => record.sourceId === sourceId,
  );
  const nextRecord = normalizeRecord({
    ...existingRecord,
    ...parsed.values,
    id: existingRecord?.id || createRecordId(),
    sourceId,
    source: "zapier",
    provider: "zapier",
    accountEmail,
    messageId,
    subjectMatched: parsed.subjectMatched,
    collectedAt: existingRecord?.collectedAt || new Date().toISOString(),
    receivedAt:
      receivedAt || existingRecord?.receivedAt || new Date().toISOString(),
    status: existingRecord?.status || parsed.values.status,
  });

  upsertRecord(store.records, nextRecord);
  await writeRecordStore(store);

  sendJson(response, existingRecord ? 200 : 201, {
    ok: true,
    record: nextRecord,
  });
}

async function handleRecordList(response) {
  const store = await readRecordStore();
  sendJson(response, 200, {
    records: store.records,
  });
}

async function handleRecordCreate(request, response) {
  const payload = await readRequestBody(request);

  if (!payload || typeof payload !== "object") {
    sendJson(response, 400, {
      error: "invalid_payload",
      message: "The record payload must be a JSON object.",
    });
    return;
  }

  const store = await readRecordStore();
  const recordId = payload.id || createRecordId();
  const nextRecord = normalizeRecord({
    ...payload,
    id: recordId,
    source: payload.source || "manual",
    provider: payload.provider || payload.source || "manual",
    sourceId:
      payload.sourceId ||
      payload.source_id ||
      `${payload.source || "manual"}:${recordId}`,
    collectedAt: payload.collectedAt || new Date().toISOString(),
  });

  upsertRecord(store.records, nextRecord);
  await writeRecordStore(store);

  sendJson(response, 201, {
    record: nextRecord,
  });
}

async function handleRecordUpdate(recordId, request, response) {
  const payload = await readRequestBody(request);
  const store = await readRecordStore();
  const record = store.records.find((storedRecord) => storedRecord.id === recordId);

  if (!record) {
    sendJson(response, 404, {
      error: "not_found",
      message: "That booking record could not be found.",
    });
    return;
  }

  if (typeof payload.status === "string") {
    record.status = normalizePaymentStatus(payload.status);
  }

  record.updatedAt = new Date().toISOString();
  await writeRecordStore(store);

  sendJson(response, 200, {
    record: normalizeRecord(record),
  });
}

async function handleRecordDelete(recordId, response) {
  const store = await readRecordStore();
  const nextRecords = store.records.filter(
    (storedRecord) => storedRecord.id !== recordId,
  );

  if (nextRecords.length === store.records.length) {
    sendJson(response, 404, {
      error: "not_found",
      message: "That booking record could not be found.",
    });
    return;
  }

  store.records = nextRecords;
  await writeRecordStore(store);

  sendJson(response, 200, {
    ok: true,
  });
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

async function readAppSettings() {
  try {
    const contents = await fs.readFile(APP_SETTINGS_FILE, "utf8");
    const settings = JSON.parse(contents);

    return typeof settings === "object" && settings ? settings : {};
  } catch (error) {
    if (error.code === "ENOENT") {
      return {};
    }

    throw error;
  }
}

async function writeAppSettings(settings) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(APP_SETTINGS_FILE, JSON.stringify(settings, null, 2));
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

async function readRecordStore() {
  try {
    const contents = await fs.readFile(RECORDS_FILE, "utf8");
    const store = JSON.parse(contents);

    return {
      records: Array.isArray(store.records)
        ? store.records.map(normalizeRecord).sort(sortRecordsNewest)
        : [],
    };
  } catch (error) {
    if (error.code === "ENOENT") {
      return { records: [] };
    }

    throw error;
  }
}

async function writeRecordStore(store) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(
    RECORDS_FILE,
    JSON.stringify(
      {
        records: store.records.map(normalizeRecord).sort(sortRecordsNewest),
      },
      null,
      2,
    ),
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

async function getZapierWebhookSecret() {
  if (process.env.ZAPIER_WEBHOOK_SECRET) {
    return process.env.ZAPIER_WEBHOOK_SECRET;
  }

  const settings = await readAppSettings();

  if (settings.zapierWebhookSecret) {
    return settings.zapierWebhookSecret;
  }

  settings.zapierWebhookSecret = crypto.randomBytes(24).toString("hex");
  await writeAppSettings(settings);
  return settings.zapierWebhookSecret;
}

async function readRequestBody(request) {
  const chunks = [];

  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  const rawBody = Buffer.concat(chunks).toString("utf8");

  if (!rawBody) {
    return {};
  }

  const contentType = String(request.headers["content-type"] || "");

  if (contentType.includes("application/json")) {
    return JSON.parse(rawBody);
  }

  if (contentType.includes("application/x-www-form-urlencoded")) {
    return Object.fromEntries(new URLSearchParams(rawBody));
  }

  try {
    return JSON.parse(rawBody);
  } catch {
    return Object.fromEntries(new URLSearchParams(rawBody));
  }
}

function upsertRecord(records, nextRecord) {
  const existingIndex = records.findIndex(
    (record) => record.sourceId === nextRecord.sourceId || record.id === nextRecord.id,
  );

  if (existingIndex === -1) {
    records.unshift(normalizeRecord(nextRecord));
    records.sort(sortRecordsNewest);
    return;
  }

  records[existingIndex] = normalizeRecord({
    ...records[existingIndex],
    ...nextRecord,
  });
  records.sort(sortRecordsNewest);
}

function normalizeRecord(record = {}) {
  return {
    ...record,
    status: normalizePaymentStatus(record.status),
    source: record.source || "manual",
    provider: record.provider || record.source || "manual",
    sourceId: record.sourceId || record.source_id || record.id,
    collectedAt: normalizeOptionalDate(record.collectedAt) || new Date().toISOString(),
    receivedAt: normalizeOptionalDate(record.receivedAt || record.received_at),
    updatedAt: normalizeOptionalDate(record.updatedAt || record.updated_at),
  };
}

function sortRecordsNewest(leftRecord, rightRecord) {
  const leftDate = Date.parse(leftRecord.receivedAt || leftRecord.collectedAt || 0);
  const rightDate = Date.parse(
    rightRecord.receivedAt || rightRecord.collectedAt || 0,
  );

  return rightDate - leftDate;
}

function firstNonEmpty(values) {
  return (
    values.find(
      (value) => typeof value === "string" && value.trim().length > 0,
    )?.trim() || ""
  );
}

function normalizeOptionalDate(value) {
  if (!value) {
    return "";
  }

  if (/^\d+$/.test(String(value).trim())) {
    const numericValue = Number(value);
    const asTimestamp = numericValue > 10_000_000_000 ? numericValue : numericValue * 1000;
    return new Date(asTimestamp).toISOString();
  }

  const parsedValue = Date.parse(String(value));
  return Number.isNaN(parsedValue) ? "" : new Date(parsedValue).toISOString();
}

function createWebhookSourceId({ accountEmail, body, messageId, subject }) {
  if (messageId) {
    return `zapier:${accountEmail || "unknown"}:${messageId}`;
  }

  return `zapier:${crypto
    .createHash("sha256")
    .update([accountEmail, subject, body].join("\n"))
    .digest("hex")
    .slice(0, 24)}`;
}

function createRecordId() {
  return crypto.randomUUID();
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
