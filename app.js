const STORAGE_KEY = "booking-email-records";
const DEFAULT_REFRESH_INTERVAL_MS = 15_000;

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
const copyWebhookUrlButton = document.querySelector("#copyWebhookUrlButton");
const copySecretButton = document.querySelector("#copySecretButton");
const refreshRecordsButton = document.querySelector("#refreshRecordsButton");
const webhookUrlValue = document.querySelector("#webhookUrlValue");
const webhookSecretValue = document.querySelector("#webhookSecretValue");
const automationMessage = document.querySelector("#automationMessage");
const exportButton = document.querySelector("#exportButton");
const clearRecordsButton = document.querySelector("#clearRecordsButton");
const recordsBody = document.querySelector("#recordsBody");
const emptyState = document.querySelector("#emptyState");
const parserMessage = document.querySelector("#parserMessage");

let records = loadRecords();
let activeRecordMenuId = null;
let apiAvailable = false;
let refreshTimer = null;
let refreshIntervalMs = DEFAULT_REFRESH_INTERVAL_MS;
let refreshInFlight = false;

resetPreview();
renderRecords();
bindEvents();
initializeAutomation();

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

  copyWebhookUrlButton.addEventListener("click", () => {
    copyAutomationValue(webhookUrlValue.textContent, "Webhook URL copied.");
  });

  copySecretButton.addEventListener("click", () => {
    copyAutomationValue(webhookSecretValue.textContent, "Shared secret copied.");
  });

  refreshRecordsButton.addEventListener("click", () => {
    refreshServerRecords({ silent: false });
  });

  copyDetailsButton.addEventListener("click", copyBookingDetails);
  exportButton.addEventListener("click", exportCsv);
  clearRecordsButton.addEventListener("click", clearRecords);
  document.addEventListener("click", handleDocumentClick);
  document.addEventListener("keydown", handleDocumentKeydown);
}

async function initializeAutomation() {
  try {
    const config = await apiRequest("/api/zapier/config");

    apiAvailable = true;
    refreshIntervalMs = Number(config.pollIntervalMs || DEFAULT_REFRESH_INTERVAL_MS);
    webhookUrlValue.textContent = config.webhookUrl || "Unavailable";
    webhookSecretValue.textContent = config.secret || "Unavailable";
    copyWebhookUrlButton.disabled = false;
    copySecretButton.disabled = false;
    refreshRecordsButton.disabled = false;
    setAutomationMessage(
      "Zapier webhook is ready. This page refreshes server records automatically while it stays open.",
      "success",
    );

    await refreshServerRecords({ silent: true });
    startAutoRefresh();
  } catch (error) {
    apiAvailable = false;
    webhookUrlValue.textContent = "Run npm start to expose the webhook URL.";
    webhookSecretValue.textContent = "Starts when the Node server is running.";
    copyWebhookUrlButton.disabled = true;
    copySecretButton.disabled = true;
    refreshRecordsButton.disabled = true;
    setAutomationMessage(
      error?.message ||
        "Start the local Node server to use Zapier automation and shared record storage.",
      "warning",
    );
  }
}

async function handleExtraction() {
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

  try {
    if (apiAvailable) {
      const result = await apiRequest("/api/records", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(record),
      });

      mergeServerRecords([result.record]);
    } else {
      records.unshift(record);
      persistLocalRecords();
    }

    renderRecords();

    const subjectNote = parsed.subjectMatched
      ? "Subject matched."
      : "Subject line was not found, but the booking fields were collected.";

    setMessage(`${subjectNote} Booking details added to the tracker.`, "success");
  } catch (error) {
    setMessage(error.message || "Could not save that booking record.", "warning");
  }
}

async function refreshServerRecords({ silent = true } = {}) {
  if (!apiAvailable || refreshInFlight) {
    return;
  }

  refreshInFlight = true;

  if (!silent) {
    setAutomationMessage("Refreshing booking records from the server...", "neutral");
  }

  try {
    const result = await apiRequest("/api/records");
    const mergeResult = mergeServerRecords(result.records || []);

    if (mergeResult.latestRecord) {
      renderLatestBooking(mergeResult.latestRecord, hasBookingDetails(mergeResult.latestRecord));
    }

    renderRecords();

    if (!silent) {
      if (mergeResult.added > 0) {
        setAutomationMessage(
          `Fetched ${mergeResult.added} new booking record${mergeResult.added === 1 ? "" : "s"}.`,
          "success",
        );
      } else {
        setAutomationMessage("Records are up to date.", "success");
      }
    }
  } catch (error) {
    if (!silent) {
      setAutomationMessage(error.message || "Could not refresh server records.", "warning");
    }
  } finally {
    refreshInFlight = false;
  }
}

function startAutoRefresh() {
  if (refreshTimer) {
    return;
  }

  refreshTimer = window.setInterval(() => {
    refreshServerRecords({ silent: true });
  }, refreshIntervalMs);
}

function stopAutoRefresh() {
  if (!refreshTimer) {
    return;
  }

  window.clearInterval(refreshTimer);
  refreshTimer = null;
}

function mergeServerRecords(serverRecords) {
  let added = 0;
  let updated = 0;
  let latestRecord = null;

  serverRecords.forEach((incomingRecord) => {
    const sourceId = incomingRecord.sourceId || incomingRecord.id;
    const existingRecord = records.find(
      (record) => (record.sourceId || record.id) === sourceId,
    );

    if (!existingRecord) {
      const record = normalizeLocalRecord({
        ...incomingRecord,
        serverStored: true,
      });
      records.unshift(record);
      added += 1;

      if (!latestRecord) {
        latestRecord = record;
      }

      return;
    }

    Object.assign(existingRecord, normalizeLocalRecord({
      ...existingRecord,
      ...incomingRecord,
      serverStored: true,
      status: existingRecord.status || incomingRecord.status,
    }));
    updated += 1;
  });

  sortRecords();
  persistLocalRecords();

  return {
    added,
    updated,
    latestRecord,
  };
}

function renderLatestBooking(values, hasBooking) {
  bookingDetailsOutput.value = formatBookingDetails(values);
  copyDetailsButton.disabled = !hasBooking;
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
    setMessage("Booking details copied.", "success");
  }
}

async function copyAutomationValue(value, successMessage) {
  if (!value || /Loading|Run npm start|Unavailable|Starts when/.test(value)) {
    setAutomationMessage("That value is not ready to copy yet.", "warning");
    return;
  }

  try {
    await copyTextToClipboard(value);
    setAutomationMessage(successMessage, "success");
  } catch {
    setAutomationMessage(successMessage, "success");
  }
}

async function copyTextToClipboard(text) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const previousText = bookingDetailsOutput.value;
  bookingDetailsOutput.value = text;
  bookingDetailsOutput.focus();
  bookingDetailsOutput.select();
  document.execCommand("copy");
  bookingDetailsOutput.value = previousText;
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

  select.addEventListener("change", async () => {
    const previousStatus = normalizePaymentStatus(record.status);
    const nextStatus = select.value;
    record.status = nextStatus;
    setStatusSelectClass(select);
    persistLocalRecords();

    try {
      if (apiAvailable && record.serverStored) {
        const result = await apiRequest(`/api/records/${record.id}`, {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ status: nextStatus }),
        });

        Object.assign(record, normalizeLocalRecord(result.record));
      }

      setMessage(`Status updated to ${nextStatus}.`, "success");
    } catch (error) {
      record.status = previousStatus;
      select.value = previousStatus;
      setStatusSelectClass(select);
      persistLocalRecords();
      setMessage(error.message || "Could not update the payment status.", "warning");
    }
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

async function clearRecords() {
  if (!records.length) {
    return;
  }

  const confirmed = window.confirm("Clear all collected booking records?");

  if (!confirmed) {
    return;
  }

  try {
    if (apiAvailable) {
      await Promise.all(
        records
          .filter((record) => record.serverStored)
          .map((record) =>
            apiRequest(`/api/records/${record.id}`, {
              method: "DELETE",
            }),
          ),
      );
    }

    records = [];
    activeRecordMenuId = null;
    persistLocalRecords();
    renderRecords();
    resetPreview();
    setMessage("Collected records cleared.", "neutral");
  } catch (error) {
    setMessage(error.message || "Could not clear the records.", "warning");
  }
}

async function deleteRecord(recordId) {
  const record = records.find((storedRecord) => storedRecord.id === recordId);

  if (!record) {
    return;
  }

  const confirmed = window.confirm("Delete this booking record?");

  if (!confirmed) {
    return;
  }

  try {
    if (apiAvailable && record.serverStored) {
      await apiRequest(`/api/records/${recordId}`, {
        method: "DELETE",
      });
    }

    records = records.filter((storedRecord) => storedRecord.id !== recordId);
    activeRecordMenuId = null;
    persistLocalRecords();
    renderRecords();

    const nextRecord = records.find(hasBookingDetails);

    if (nextRecord) {
      renderLatestBooking(nextRecord, true);
    } else {
      resetPreview();
    }

    setMessage("Booking record deleted.", "success");
  } catch (error) {
    setMessage(error.message || "Could not delete that record.", "warning");
  }
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

  if (!response.ok) {
    throw new Error(body.message || body.error || response.statusText);
  }

  return body;
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

function createRecordId() {
  if (typeof crypto !== "undefined" && crypto.randomUUID) {
    return crypto.randomUUID();
  }

  return String(Date.now());
}

function normalizeLocalRecord(record = {}) {
  return {
    ...record,
    id: record.id || createRecordId(),
    sourceId: record.sourceId || record.id,
    serverStored: Boolean(record.serverStored),
    status: normalizePaymentStatus(record.status),
  };
}

function sortRecords() {
  records.sort((leftRecord, rightRecord) => {
    const leftDate = Date.parse(
      leftRecord.receivedAt || leftRecord.collectedAt || leftRecord.bookingDate || 0,
    );
    const rightDate = Date.parse(
      rightRecord.receivedAt || rightRecord.collectedAt || rightRecord.bookingDate || 0,
    );

    return rightDate - leftDate;
  });
}

function loadRecords() {
  try {
    const storedRecords = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");

    if (!Array.isArray(storedRecords)) {
      return [];
    }

    return storedRecords.map(normalizeLocalRecord);
  } catch {
    return [];
  }
}

function persistLocalRecords() {
  sortRecords();
  localStorage.setItem(STORAGE_KEY, JSON.stringify(records));
}

function setMessage(message, type) {
  parserMessage.textContent = message;
  parserMessage.classList.toggle("success", type === "success");
  parserMessage.classList.toggle("warning", type === "warning");
}

function setAutomationMessage(message, type) {
  automationMessage.textContent = message;
  automationMessage.classList.toggle("success", type === "success");
  automationMessage.classList.toggle("warning", type === "warning");
}
