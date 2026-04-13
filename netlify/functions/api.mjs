import crypto from "node:crypto";
import { createRequire } from "node:module";
import { getStore } from "@netlify/blobs";

const require = createRequire(import.meta.url);
const {
  SUBJECT_FILTER,
  parseBookingEmail,
  normalizePaymentStatus,
} = require("../../parser.js");

const DEFAULT_REFRESH_INTERVAL_MS = 15_000;
const STORE_NAME = "booking-email-collector";
const SETTINGS_KEY = "settings";
const RECORDS_KEY = "records";

export const config = {
  path: "/api/*",
  preferStatic: true,
};

export default async function handler(request) {
  const url = new URL(request.url);
  const pathname = url.pathname;

  if (request.method === "GET" && pathname === "/api/zapier/config") {
    return jsonResponse(200, {
      webhookUrl: `${getBaseUrl(request)}/api/zapier/bookings`,
      secret: await getZapierWebhookSecret(),
      pollIntervalMs: getRefreshInterval(),
      subjectFilter: SUBJECT_FILTER,
    });
  }

  if (request.method === "POST" && pathname === "/api/zapier/bookings") {
    return handleZapierBooking(request, url);
  }

  if (request.method === "GET" && pathname === "/api/records") {
    const records = await readRecords();
    return jsonResponse(200, { records });
  }

  if (request.method === "POST" && pathname === "/api/records") {
    return handleRecordCreate(request);
  }

  const recordIdMatch = pathname.match(/^\/api\/records\/([^/]+)$/);

  if (request.method === "PATCH" && recordIdMatch) {
    return handleRecordUpdate(recordIdMatch[1], request);
  }

  if (request.method === "DELETE" && recordIdMatch) {
    return handleRecordDelete(recordIdMatch[1]);
  }

  return jsonResponse(404, {
    error: "not_found",
    message: "That API route does not exist.",
  });
}

async function handleZapierBooking(request, url) {
  const payload = await readRequestBody(request);
  const expectedSecret = await getZapierWebhookSecret();
  const providedSecret =
    request.headers.get("x-zapier-secret") ||
    payload.secret ||
    url.searchParams.get("secret") ||
    "";

  if (!providedSecret || providedSecret !== expectedSecret) {
    return jsonResponse(401, {
      error: "invalid_secret",
      message: "The Zapier webhook secret is missing or invalid.",
    });
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

  if (!subject && !body) {
    return jsonResponse(400, {
      error: "invalid_payload",
      message: "The Zapier payload must include at least a subject or email body.",
    });
  }

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
  const parsed = parseBookingEmail(`Subject: ${subject}\n\n${body}`);

  if (!parsed.hasAnyField) {
    return jsonResponse(422, {
      error: "no_booking_fields",
      message:
        "The incoming Zapier payload did not contain booking fields the parser could extract.",
    });
  }

  const records = await readRecords();
  const recordKey = createRecordKey(sourceId);
  const existingRecord = records.find((record) => record.id === recordKey);
  const nextRecord = normalizeRecord({
    ...existingRecord,
    ...parsed.values,
    id: recordKey,
    sourceId,
    source: "zapier",
    provider: "zapier",
    serverStored: true,
    accountEmail,
    messageId,
    subjectMatched: parsed.subjectMatched,
    collectedAt: existingRecord?.collectedAt || new Date().toISOString(),
    receivedAt:
      normalizeOptionalDate(
        firstNonEmpty([
          payload.received_at,
          payload.receivedAt,
          payload.date,
          payload.sent_at,
          payload.internal_date,
        ]),
      ) ||
      existingRecord?.receivedAt ||
      new Date().toISOString(),
    status: existingRecord?.status || parsed.values.status,
    updatedAt: new Date().toISOString(),
  });

  upsertRecord(records, nextRecord);
  await writeRecords(records);

  return jsonResponse(existingRecord ? 200 : 201, {
    ok: true,
    record: nextRecord,
  });
}

async function handleRecordCreate(request) {
  const payload = await readRequestBody(request);

  if (!payload || typeof payload !== "object") {
    return jsonResponse(400, {
      error: "invalid_payload",
      message: "The record payload must be a JSON object.",
    });
  }

  const records = await readRecords();
  const sourceId =
    payload.sourceId ||
    payload.source_id ||
    `${payload.source || "manual"}:${payload.id || crypto.randomUUID()}`;
  const recordKey = payload.id || createRecordKey(sourceId);
  const nextRecord = normalizeRecord({
    ...payload,
    id: recordKey,
    sourceId,
    source: payload.source || "manual",
    provider: payload.provider || payload.source || "manual",
    serverStored: true,
    collectedAt: payload.collectedAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });

  upsertRecord(records, nextRecord);
  await writeRecords(records);

  return jsonResponse(201, { record: nextRecord });
}

async function handleRecordUpdate(recordId, request) {
  const payload = await readRequestBody(request);
  const records = await readRecords();
  const record = records.find((storedRecord) => storedRecord.id === recordId);

  if (!record) {
    return jsonResponse(404, {
      error: "not_found",
      message: "That booking record could not be found.",
    });
  }

  if (typeof payload.status === "string") {
    record.status = normalizePaymentStatus(payload.status);
  }

  record.updatedAt = new Date().toISOString();
  await writeRecords(records);

  return jsonResponse(200, { record: normalizeRecord(record) });
}

async function handleRecordDelete(recordId) {
  const records = await readRecords();
  const nextRecords = records.filter((record) => record.id !== recordId);

  if (nextRecords.length === records.length) {
    return jsonResponse(404, {
      error: "not_found",
      message: "That booking record could not be found.",
    });
  }

  await writeRecords(nextRecords);
  return jsonResponse(200, { ok: true });
}

async function readRecords() {
  const store = getStore(STORE_NAME);
  const data = await store.get(RECORDS_KEY, { type: "json" });

  if (!data || !Array.isArray(data.records)) {
    return [];
  }

  return data.records.map(normalizeRecord).sort(sortRecordsNewest);
}

async function writeRecords(records) {
  const store = getStore(STORE_NAME);
  await store.setJSON(RECORDS_KEY, {
    records: records.map(normalizeRecord).sort(sortRecordsNewest),
  });
}

async function getZapierWebhookSecret() {
  const configuredSecret = getEnv("ZAPIER_WEBHOOK_SECRET");

  if (configuredSecret) {
    return configuredSecret;
  }

  const settings = await readSettings();

  if (settings.zapierWebhookSecret) {
    return settings.zapierWebhookSecret;
  }

  settings.zapierWebhookSecret = crypto.randomBytes(24).toString("hex");
  await writeSettings(settings);
  return settings.zapierWebhookSecret;
}

async function readSettings() {
  const store = getStore(STORE_NAME);
  const data = await store.get(SETTINGS_KEY, { type: "json" });
  return data && typeof data === "object" ? data : {};
}

async function writeSettings(settings) {
  const store = getStore(STORE_NAME);
  await store.setJSON(SETTINGS_KEY, settings);
}

async function readRequestBody(request) {
  const rawBody = await request.text();

  if (!rawBody) {
    return {};
  }

  const contentType = request.headers.get("content-type") || "";

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

function getBaseUrl(request) {
  return getEnv("BASE_URL") || new URL(request.url).origin;
}

function getRefreshInterval() {
  return Number(getEnv("AUTO_REFRESH_INTERVAL_MS") || DEFAULT_REFRESH_INTERVAL_MS);
}

function getEnv(key) {
  return globalThis.Netlify?.env?.get?.(key) || process.env[key] || "";
}

function firstNonEmpty(values) {
  return (
    values.find(
      (value) => typeof value === "string" && value.trim().length > 0,
    )?.trim() || ""
  );
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

function createRecordKey(sourceId) {
  return crypto.createHash("sha256").update(sourceId).digest("hex").slice(0, 24);
}

function normalizeRecord(record = {}) {
  return {
    ...record,
    id: record.id || createRecordKey(record.sourceId || crypto.randomUUID()),
    sourceId: record.sourceId || record.source_id || record.id || "",
    source: record.source || "manual",
    provider: record.provider || record.source || "manual",
    serverStored: true,
    status: normalizePaymentStatus(record.status),
    collectedAt: normalizeOptionalDate(record.collectedAt) || new Date().toISOString(),
    receivedAt: normalizeOptionalDate(record.receivedAt || record.received_at),
    updatedAt: normalizeOptionalDate(record.updatedAt || record.updated_at),
  };
}

function upsertRecord(records, nextRecord) {
  const existingIndex = records.findIndex(
    (record) => record.id === nextRecord.id || record.sourceId === nextRecord.sourceId,
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

function sortRecordsNewest(leftRecord, rightRecord) {
  const leftDate = Date.parse(leftRecord.receivedAt || leftRecord.collectedAt || 0);
  const rightDate = Date.parse(
    rightRecord.receivedAt || rightRecord.collectedAt || 0,
  );

  return rightDate - leftDate;
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

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}
