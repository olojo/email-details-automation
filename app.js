const STORAGE_KEY = "booking-email-records";
const AUTO_SYNC_INTERVAL_MS = 60_000;

const {
  SAMPLE_EMAIL,
  parseBookingEmail,
  formatBookingDetails,
  normalizePaymentStatus,
} = window.BookingParser;

const form = document.querySelector("#emailForm");
const emailInput = document.querySelector("#emailInput");
const bookingDetailsOutput = document.querySelector("#bookingDetailsOutput");
const copyDetailsButton = document.querySelector("#copyDetailsButton");
const sampleButton = document.querySelector("#sampleButton");
const clearInputButton = document.querySelector("#clearInputButton");
const connectGmailButton = document.querySelector("#connectGmailButton");
const syncNowButton = document.querySelector("#syncNowButton");
const accountsList = document.querySelector("#accountsList");
const accountsEmpty = document.querySelector("#accountsEmpty");
const liveMessage = document.querySelector("#liveMessage");
const exportButton = document.querySelector("#exportButton");
const clearRecordsButton = document.querySelector("#clearRecordsButton");
const recordsBody = document.querySelector("#recordsBody");
const emptyState = document.querySelector("#emptyState");
const parserMessage = document.querySelector("#parserMessage");

let records = loadRecords();
let accounts = [];
let apiAvailable = false;
let autoSyncTimer = null;
let activeRecordMenuId = null;

resetPreview();
renderRecords();
bindEvents();
handleRedirectMessage();
refreshAccounts();

function bindEvents() {
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    handleExtraction();
  });

  sampleButton.addEventListener("click", () => {
    emailInput.value = SAMPLE_EMAIL;
    emailInput.focus();
  });

  clearInputButton.addEventListener("click", () => {
    emailInput.value = "";
    resetPreview();
    setMessage("Paste a booking email to collect its details.", "neutral");
    emailInput.focus();
  });

  connectGmailButton.addEventListener("click", connectGmail);
  syncNowButton.addEventListener("click", () => syncAccounts({ manual: true }));
  copyDetailsButton.addEventListener("click", copyBookingDetails);
  exportButton.addEventListener("click", exportCsv);
  clearRecordsButton.addEventListener("click", clearRecords);
  document.addEventListener("click", handleDocumentClick);
  document.addEventListener("keydown", handleDocumentKeydown);
}

function handleExtraction() {
  const rawEmail = emailInput.value.trim();

  if (!rawEmail) {
    setMessage("Paste the booking email content first.", "warning");
    return;
  }

  const parsed = parseBookingEmail(rawEmail);
  renderLatestBooking(parsed.values, parsed.hasBookingDetails);

  if (!parsed.hasAnyField) {
    setMessage(
      "No booking fields were found. Check that the email includes guest, property, dates, reference, and financial details.",
      "warning",
    );
    return;
  }

  const recordId = createRecordId();
  const record = {
    id: recordId,
    sourceId: `manual:${recordId}`,
    source: "manual",
    provider: "manual",
    accountEmail: "",
    ...parsed.values,
    subjectMatched: parsed.subjectMatched,
    collectedAt: new Date().toISOString(),
  };

  records = [record, ...records];
  saveRecords();
  renderRecords();

  const subjectNote = parsed.subjectMatched
    ? "Subject matched."
    : "Subject line was not found, but the booking fields were collected.";

  setMessage(`${subjectNote} Booking details added to the tracker.`, "success");
}

async function refreshAccounts() {
  try {
    const result = await apiRequest("/api/accounts");
    apiAvailable = true;
    accounts = result.accounts || [];
    renderAccounts();

    if (!result.configured) {
      setLiveMessage(
        "Gmail OAuth is not configured yet. Add your Google client ID and secret to .env, then restart the server.",
        "warning",
      );
      connectGmailButton.disabled = true;
      syncNowButton.disabled = true;
      return;
    }

    connectGmailButton.disabled = false;
    syncNowButton.disabled = accounts.length === 0;

    if (accounts.length) {
      setLiveMessage("Auto-sync checks connected Gmail inboxes every minute.", "success");
      startAutoSync();
    } else {
      setLiveMessage("Connect Gmail to start extracting live booking emails.", "neutral");
      stopAutoSync();
    }
  } catch {
    apiAvailable = false;
    accounts = [];
    renderAccounts();
    connectGmailButton.disabled = true;
    syncNowButton.disabled = true;
    setLiveMessage(
      "Live inbox sync needs the local Node server. Run npm start, then open http://localhost:4173/.",
      "warning",
    );
  }
}

function connectGmail() {
  if (!apiAvailable) {
    setLiveMessage(
      "Start the local Node server before connecting Gmail.",
      "warning",
    );
    return;
  }

  window.location.href = "/auth/google/start";
}

async function syncAccounts({ manual = false } = {}) {
  if (!apiAvailable || accounts.length === 0) {
    setLiveMessage("Connect at least one Gmail account before syncing.", "warning");
    return;
  }

  syncNowButton.disabled = true;
  setLiveMessage("Checking connected inboxes for new booking emails...", "neutral");

  try {
    const result = await apiRequest("/api/sync", { method: "POST" });
    accounts = result.accounts || accounts;

    const mergeResult = mergeIncomingRecords(result.records || []);
    renderAccounts();
    renderRecords();

    if (mergeResult.latestRecord) {
      renderLatestBooking(mergeResult.latestRecord, true);
    }

    const errorMessage = formatSyncErrors(result.errors || []);

    if (mergeResult.added > 0) {
      setLiveMessage(
        `Synced ${mergeResult.added} new booking email${mergeResult.added === 1 ? "" : "s"}.${errorMessage}`,
        result.errors?.length ? "warning" : "success",
      );
    } else if (mergeResult.updated > 0) {
      setLiveMessage(
        `No new bookings. Refreshed ${mergeResult.updated} existing booking record${mergeResult.updated === 1 ? "" : "s"}.${errorMessage}`,
        result.errors?.length ? "warning" : "success",
      );
    } else {
      setLiveMessage(
        `No matching booking emails found${manual ? " right now" : ""}.${errorMessage}`,
        result.errors?.length ? "warning" : "neutral",
      );
    }
  } catch (error) {
    setLiveMessage(error.message || "Inbox sync failed.", "warning");
  } finally {
    syncNowButton.disabled = accounts.length === 0;
  }
}

async function disconnectAccount(accountId) {
  const account = accounts.find((storedAccount) => storedAccount.id === accountId);
  const confirmed = window.confirm(
    `Disconnect ${account?.email || "this email account"}?`,
  );

  if (!confirmed) {
    return;
  }

  try {
    const result = await apiRequest(`/api/accounts/${accountId}/disconnect`, {
      method: "DELETE",
    });

    accounts = result.accounts || [];
    renderAccounts();
    syncNowButton.disabled = accounts.length === 0;
    setLiveMessage("Email account disconnected.", "success");

    if (!accounts.length) {
      stopAutoSync();
    }
  } catch (error) {
    setLiveMessage(error.message || "Could not disconnect that account.", "warning");
  }
}

function mergeIncomingRecords(incomingRecords) {
  let added = 0;
  let updated = 0;
  let latestRecord = null;

  incomingRecords.forEach((incomingRecord) => {
    const sourceId = incomingRecord.sourceId || incomingRecord.id;
    const existingRecord = records.find(
      (record) => (record.sourceId || record.id) === sourceId,
    );

    if (!existingRecord) {
      const record = {
        ...incomingRecord,
        status: normalizePaymentStatus(incomingRecord.status),
      };

      records.unshift(record);
      added += 1;

      if (!latestRecord) {
        latestRecord = record;
      }

      return;
    }

    Object.assign(existingRecord, {
      ...existingRecord,
      ...incomingRecord,
      status: normalizePaymentStatus(existingRecord.status || incomingRecord.status),
    });
    updated += 1;
  });

  saveRecords();

  return {
    added,
    updated,
    latestRecord,
  };
}

function renderLatestBooking(values, hasBookingDetails) {
  bookingDetailsOutput.value = formatBookingDetails(values);
  copyDetailsButton.disabled = !hasBookingDetails;
}

function resetPreview() {
  bookingDetailsOutput.value = formatBookingDetails({}, "Not added");
  copyDetailsButton.disabled = true;
}

async function copyBookingDetails() {
  const text = bookingDetailsOutput.value.trim();

  if (!text || copyDetailsButton.disabled) {
    setMessage("Extract booking details before copying.", "warning");
    return;
  }

  try {
    await copyTextToClipboard(text);
    setMessage("Booking details copied.", "success");
  } catch {
    copyBookingDetailsWithFallback();
    setMessage("Booking details copied.", "success");
  }
}

function copyBookingDetailsWithFallback() {
  bookingDetailsOutput.focus();
  bookingDetailsOutput.select();
  document.execCommand("copy");
}

function renderAccounts() {
  accountsList.innerHTML = "";
  accountsEmpty.classList.toggle("visible", accounts.length === 0);

  accounts.forEach((account) => {
    const row = document.createElement("div");
    const meta = document.createElement("div");
    const title = document.createElement("p");
    const subtitle = document.createElement("p");
    const disconnectButton = document.createElement("button");

    row.className = "account-row";
    meta.className = "account-meta";
    title.className = "account-title";
    subtitle.className = "account-subtitle";
    disconnectButton.className = "danger-button account-action";
    disconnectButton.type = "button";

    title.textContent = account.email;
    subtitle.textContent = `${formatProvider(account.provider)} · Last sync: ${formatOptionalDate(account.lastSyncedAt)}`;
    disconnectButton.textContent = "Disconnect";
    disconnectButton.addEventListener("click", () => disconnectAccount(account.id));

    meta.append(title, subtitle);
    row.append(meta, disconnectButton);
    accountsList.appendChild(row);
  });
}

function renderRecords() {
  recordsBody.innerHTML = "";
  emptyState.classList.toggle("visible", records.length === 0);
  exportButton.disabled = records.length === 0;
  clearRecordsButton.disabled = records.length === 0;

  records.forEach((record) => {
    const row = document.createElement("tr");

    row.append(
      createCell(record.bookingDate || record.checkInDate || "Not found", "number-cell"),
      createCell(record.totalBookingValue || "Not found", "number-cell"),
      createCell(record.cautionFee || "Not found", "number-cell"),
      createCell(record.reekaFee || "Not found", "number-cell"),
      createStatusCell(record),
      createCell(formatOptionalDate(record.collectedAt), "number-cell"),
      createActionsCell(record),
    );

    recordsBody.appendChild(row);
  });
}

function createCell(value, className = "") {
  const cell = document.createElement("td");
  cell.textContent = value;

  if (className) {
    cell.classList.add(className);
  }

  return cell;
}

function createStatusCell(record) {
  const cell = document.createElement("td");
  const select = document.createElement("select");

  select.className = "status-select";
  select.setAttribute("aria-label", "Payment status");

  ["Paid", "Unpaid"].forEach((status) => {
    const option = document.createElement("option");
    option.value = status;
    option.textContent = status;
    select.appendChild(option);
  });

  select.value = normalizePaymentStatus(record.status);
  setStatusSelectClass(select);

  select.addEventListener("change", () => {
    record.status = select.value;
    setStatusSelectClass(select);
    saveRecords();
    setMessage(`Status updated to ${select.value}.`, "success");
  });

  cell.appendChild(select);
  return cell;
}

function createActionsCell(record) {
  const cell = document.createElement("td");
  const wrap = document.createElement("div");
  const button = document.createElement("button");
  const icon = document.createElement("span");

  cell.className = "actions-cell";
  wrap.className = "record-menu-wrap";
  button.className = "more-button";
  button.type = "button";
  button.setAttribute("aria-haspopup", "menu");
  button.setAttribute("aria-expanded", String(activeRecordMenuId === record.id));
  button.setAttribute("aria-label", "More actions");
  icon.className = "more-icon";

  for (let index = 0; index < 3; index += 1) {
    const dot = document.createElement("span");
    dot.className = "more-dot";
    icon.appendChild(dot);
  }

  button.appendChild(icon);
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    activeRecordMenuId = activeRecordMenuId === record.id ? null : record.id;
    renderRecords();
  });

  wrap.appendChild(button);

  if (activeRecordMenuId === record.id) {
    wrap.appendChild(createRecordMenu(record));
  }

  cell.appendChild(wrap);
  return cell;
}

function createRecordMenu(record) {
  const menu = document.createElement("div");
  const copyButton = document.createElement("button");
  const deleteButton = document.createElement("button");

  menu.className = "record-menu";
  menu.setAttribute("role", "menu");

  copyButton.className = "record-menu-item";
  copyButton.type = "button";
  copyButton.textContent = "Copy";
  copyButton.addEventListener("click", async (event) => {
    event.stopPropagation();
    activeRecordMenuId = null;
    renderLatestBooking(record, hasBookingDetails(record));

    try {
      await copyTextToClipboard(formatBookingDetails(record));
      setMessage("Booking record copied.", "success");
    } catch {
      copyBookingDetailsWithFallback();
      setMessage("Booking record copied.", "success");
    }

    renderRecords();
  });

  deleteButton.className = "record-menu-item record-menu-delete";
  deleteButton.type = "button";
  deleteButton.textContent = "Delete";
  deleteButton.addEventListener("click", (event) => {
    event.stopPropagation();
    deleteRecord(record.id);
  });

  menu.append(copyButton, deleteButton);
  return menu;
}

function setStatusSelectClass(select) {
  select.classList.toggle("is-paid", select.value === "Paid");
  select.classList.toggle("is-unpaid", select.value === "Unpaid");
}

function exportCsv() {
  if (!records.length) {
    setMessage("No collected records to export yet.", "warning");
    return;
  }

  const headers = [
    "Guest Name",
    "Property Name",
    "Property ID",
    "Check-In Date",
    "Check-Out Date",
    "Nights",
    "Booking Reference",
    "Date",
    "Total Booking Value",
    "Caution Fee",
    "Reeka Fee",
    "Status",
    "Source",
    "Email Account",
    "Message ID",
    "Subject Matched",
    "Collected At",
  ];

  const rows = records.map((record) => [
    record.guestName,
    record.propertyName,
    record.propertyId,
    record.checkInDate,
    record.checkOutDate,
    record.nights,
    record.bookingReference,
    record.bookingDate || record.checkInDate,
    record.totalBookingValue,
    record.cautionFee,
    record.reekaFee,
    normalizePaymentStatus(record.status),
    record.source || "manual",
    record.accountEmail,
    record.messageId,
    record.subjectMatched ? "Yes" : "No",
    record.collectedAt,
  ]);

  const csv = [headers, ...rows]
    .map((row) => row.map(escapeCsvValue).join(","))
    .join("\n");

  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");

  link.href = url;
  link.download = "booking-email-records.csv";
  link.click();
  URL.revokeObjectURL(url);

  setMessage("CSV export ready.", "success");
}

function clearRecords() {
  if (!records.length) {
    return;
  }

  const confirmed = window.confirm("Clear all collected booking records?");

  if (!confirmed) {
    return;
  }

  records = [];
  activeRecordMenuId = null;
  saveRecords();
  renderRecords();
  resetPreview();
  setMessage("Collected records cleared.", "neutral");
}

async function apiRequest(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      Accept: "application/json",
      ...(options.headers || {}),
    },
  });
  const body = await response.json().catch(() => ({}));

  if (!response.ok && response.status !== 207) {
    throw new Error(body.message || body.error || response.statusText);
  }

  return body;
}

function startAutoSync() {
  if (autoSyncTimer) {
    return;
  }

  autoSyncTimer = window.setInterval(() => {
    syncAccounts();
  }, AUTO_SYNC_INTERVAL_MS);
}

function stopAutoSync() {
  if (!autoSyncTimer) {
    return;
  }

  window.clearInterval(autoSyncTimer);
  autoSyncTimer = null;
}

function handleDocumentClick(event) {
  if (!activeRecordMenuId) {
    return;
  }

  if (event.target.closest(".record-menu-wrap")) {
    return;
  }

  activeRecordMenuId = null;
  renderRecords();
}

function handleDocumentKeydown(event) {
  if (event.key !== "Escape" || !activeRecordMenuId) {
    return;
  }

  activeRecordMenuId = null;
  renderRecords();
}

function handleRedirectMessage() {
  const url = new URL(window.location.href);
  const connectedEmail = url.searchParams.get("connected");
  const error = url.searchParams.get("error");

  if (connectedEmail) {
    setLiveMessage(`${connectedEmail} connected. Syncing booking emails now.`, "success");
    window.history.replaceState({}, "", url.pathname);
    window.setTimeout(() => syncAccounts({ manual: true }), 600);
    return;
  }

  if (error) {
    setLiveMessage(`Gmail connection failed: ${error}`, "warning");
    window.history.replaceState({}, "", url.pathname);
  }
}

function formatSyncErrors(errors) {
  if (!errors.length) {
    return "";
  }

  return ` ${errors.length} account${errors.length === 1 ? "" : "s"} need attention.`;
}

function formatProvider(provider) {
  if (provider === "gmail") {
    return "Gmail";
  }

  return provider || "Email";
}

function formatOptionalDate(value) {
  if (!value) {
    return "Never";
  }

  return new Intl.DateTimeFormat("en-NG", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function escapeCsvValue(value = "") {
  const safeValue = String(value ?? "");
  return `"${safeValue.replaceAll('"', '""')}"`;
}

async function copyTextToClipboard(text) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  bookingDetailsOutput.value = text;
  copyBookingDetailsWithFallback();
}

function hasBookingDetails(record) {
  return Boolean(
    record.guestName ||
      record.propertyName ||
      record.propertyId ||
      record.checkInDate ||
      record.checkOutDate ||
      record.nights ||
      record.bookingReference,
  );
}

function deleteRecord(recordId) {
  const record = records.find((storedRecord) => storedRecord.id === recordId);

  if (!record) {
    return;
  }

  const confirmed = window.confirm("Delete this booking record?");

  if (!confirmed) {
    return;
  }

  records = records.filter((storedRecord) => storedRecord.id !== recordId);
  activeRecordMenuId = null;
  saveRecords();
  renderRecords();

  const nextRecord = records.find(hasBookingDetails);

  if (nextRecord) {
    renderLatestBooking(nextRecord, true);
  } else {
    resetPreview();
  }

  setMessage("Booking record deleted.", "success");
}

function loadRecords() {
  try {
    const storedRecords = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");

    if (!Array.isArray(storedRecords)) {
      return [];
    }

    return storedRecords.map((record, index) => ({
      ...record,
      id: record.id || `stored-${Date.now()}-${index}`,
      sourceId: record.sourceId || record.id || `stored-${Date.now()}-${index}`,
      status: normalizePaymentStatus(record.status),
    }));
  } catch {
    return [];
  }
}

function saveRecords() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(records));
}

function createRecordId() {
  if (typeof crypto !== "undefined" && crypto.randomUUID) {
    return crypto.randomUUID();
  }

  return String(Date.now());
}

function setMessage(message, type) {
  parserMessage.textContent = message;
  parserMessage.classList.toggle("success", type === "success");
  parserMessage.classList.toggle("warning", type === "warning");
}

function setLiveMessage(message, type) {
  liveMessage.textContent = message;
  liveMessage.classList.toggle("success", type === "success");
  liveMessage.classList.toggle("warning", type === "warning");
}
