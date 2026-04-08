(function registerBookingParser(root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.BookingParser = factory();
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function createParser() {
  const SUBJECT_FILTER = "New Public booking link";

  const SAMPLE_EMAIL = `Subject: New Public booking link

Hello,

A new booking came in through the public booking link.

Guest Name: Ada Okafor
Property Name: Lekki Waterside Apartment
Property ID: LW-204
Check-In Date: 12 April 2026
Check-Out Date: 15 April 2026
Nights: 3
Booking Reference: PB-91820

Total Booking Value: ₦250,000
Caution Fee: ₦50,000
Reeka Fee: ₦20,000
Date: 8 April 2026
Status: Unpaid`;

  const bookingDetailFields = [
    {
      key: "guestName",
      labels: ["guest name", "guest", "customer name"],
      clean: cleanPlainText,
    },
    {
      key: "propertyName",
      labels: ["property name", "listing name", "apartment name", "home name"],
      clean: cleanPlainText,
    },
    {
      key: "propertyId",
      labels: ["property id", "property number", "listing id", "id number"],
      clean: cleanPlainText,
    },
    {
      key: "checkInDate",
      labels: [
        "check-in date",
        "check in date",
        "check-in",
        "check in",
        "arrival date",
      ],
      clean: cleanDate,
    },
    {
      key: "checkOutDate",
      labels: [
        "check-out date",
        "check out date",
        "check-out",
        "check out",
        "departure date",
      ],
      clean: cleanDate,
    },
    {
      key: "nights",
      labels: ["nights", "night num", "number of nights"],
      clean: cleanNights,
    },
    {
      key: "bookingReference",
      labels: [
        "booking reference",
        "booking ref",
        "reference number",
        "reference",
        "reservation code",
        "reservation id",
      ],
      clean: cleanPlainText,
    },
  ];

  const financialFields = [
    {
      key: "totalBookingValue",
      labels: ["total booking value", "booking value", "total booking"],
      clean: cleanMoney,
    },
    {
      key: "cautionFee",
      labels: ["caution fee", "security deposit", "caution"],
      clean: cleanMoney,
    },
    {
      key: "reekaFee",
      labels: ["reeka fee", "reeka's fee", "reeka"],
      clean: cleanMoney,
    },
    {
      key: "bookingDate",
      labels: ["booking date", "payment date", "date"],
      clean: cleanDate,
    },
    {
      key: "status",
      labels: ["payment status", "booking status", "status"],
      clean: cleanStatus,
    },
  ];

  const allFields = [...bookingDetailFields, ...financialFields];

  function parseBookingEmail(rawEmail) {
    const plainText = normalizeEmailText(rawEmail);
    const lines = plainText
      .split(/\r?\n/)
      .map((line) => line.replace(/\s+/g, " ").trim())
      .filter(Boolean);

    const subjectMatched = new RegExp(escapeRegex(SUBJECT_FILTER), "i").test(
      plainText,
    );

    const values = {};

    allFields.forEach((field) => {
      const match = findFieldValue(lines, field.labels);
      values[field.key] = match ? field.clean(match) : "";
    });

    const statusFromEmail = values.status || inferStatus(plainText);
    values.status = statusFromEmail
      ? normalizePaymentStatus(statusFromEmail)
      : "Unpaid";

    const hasBookingDetails = bookingDetailFields.some((field) =>
      Boolean(values[field.key]),
    );
    const hasFinancialDetails =
      financialFields.some(
        (field) => field.key !== "status" && values[field.key],
      ) || Boolean(statusFromEmail);

    return {
      values,
      subjectMatched,
      hasBookingDetails,
      hasFinancialDetails,
      hasAnyField: hasBookingDetails || hasFinancialDetails,
    };
  }

  function normalizeEmailText(rawEmail) {
    return decodeHtmlEntities(
      String(rawEmail)
        .replace(/<br\s*\/?>/gi, "\n")
        .replace(/<\/(p|div|tr|li|h[1-6])>/gi, "\n")
        .replace(/<[^>]+>/g, " "),
    )
      .replace(/\u00a0/g, " ")
      .replace(/[–—]/g, "-")
      .replace(/\r/g, "\n");
  }

  function decodeHtmlEntities(value) {
    const namedEntities = {
      amp: "&",
      apos: "'",
      gt: ">",
      lt: "<",
      nbsp: " ",
      quot: '"',
    };

    return value.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (entity, code) => {
      const normalizedCode = code.toLowerCase();

      if (normalizedCode in namedEntities) {
        return namedEntities[normalizedCode];
      }

      if (normalizedCode.startsWith("#x")) {
        return String.fromCodePoint(Number.parseInt(normalizedCode.slice(2), 16));
      }

      if (normalizedCode.startsWith("#")) {
        return String.fromCodePoint(Number.parseInt(normalizedCode.slice(1), 10));
      }

      return entity;
    });
  }

  function findFieldValue(lines, labels) {
    for (const label of labels) {
      const labelPattern = createLabelPattern(label);
      const pattern = new RegExp(
        `^\\s*${labelPattern}\\s*(?:#|no\\.?|number)?\\s*(?:[:\\-=]|is)?\\s*(.+)$`,
        "i",
      );

      const line = lines.find((candidate) => pattern.test(candidate));

      if (line) {
        const value = line.match(pattern)?.[1]?.trim();
        if (value) {
          return value;
        }
      }
    }

    return "";
  }

  function createLabelPattern(label) {
    return label
      .trim()
      .split(/[\s-]+/)
      .map(escapeRegex)
      .join("[\\s-]+")
      .replace("reeka\\'s", "reeka'?s");
  }

  function cleanPlainText(value) {
    return value.replace(/\s+/g, " ").trim();
  }

  function cleanMoney(value) {
    const money = value.match(
      /\b(?:NGN|USD|GBP|EUR|N)\s*[-+]?\d[\d,]*(?:\.\d{1,2})?|\p{Sc}\s*[-+]?\d[\d,]*(?:\.\d{1,2})?|[-+]?\d[\d,]*(?:\.\d{1,2})?/iu,
    );

    return money ? money[0].replace(/\s+/g, " ").trim() : cleanPlainText(value);
  }

  function cleanDate(value) {
    const date = value.match(
      /\b(?:\d{4}-\d{1,2}-\d{1,2}|\d{1,2}[/-]\d{1,2}[/-]\d{2,4}|\d{1,2}\s+[A-Za-z]+\s+\d{4}|[A-Za-z]+\s+\d{1,2},?\s+\d{4})\b/,
    );

    return date ? date[0].trim() : cleanPlainText(value);
  }

  function cleanNights(value) {
    const nights = value.match(/\d+/);
    return nights ? nights[0] : cleanPlainText(value);
  }

  function cleanStatus(value) {
    return normalizePaymentStatus(value);
  }

  function inferStatus(text) {
    if (/\bunpaid\b/i.test(text)) {
      return "Unpaid";
    }

    if (/\bpaid\b/i.test(text)) {
      return "Paid";
    }

    return "";
  }

  function normalizePaymentStatus(status = "") {
    if (/\bunpaid\b/i.test(status)) {
      return "Unpaid";
    }

    if (/\bpaid\b/i.test(status)) {
      return "Paid";
    }

    return "Unpaid";
  }

  function formatBookingDetails(values, missingValue = "Not found") {
    return [
      "Booking Details",
      "",
      `Guest : ${displayValue(values.guestName, missingValue)}`,
      `Property Name: ${displayValue(values.propertyName, missingValue)}`,
      `Property ID: ${displayValue(values.propertyId, missingValue)}`,
      `Check-In Date: ${displayValue(values.checkInDate, missingValue)}`,
      `Check-Out Date: ${displayValue(values.checkOutDate, missingValue)}`,
      `Nights: ${displayValue(values.nights, missingValue)}`,
      `Booking Reference: ${displayValue(values.bookingReference, missingValue)}`,
    ].join("\n");
  }

  function displayValue(value, missingValue) {
    return value ? value : missingValue;
  }

  function escapeRegex(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  return {
    SUBJECT_FILTER,
    SAMPLE_EMAIL,
    parseBookingEmail,
    formatBookingDetails,
    normalizePaymentStatus,
  };
});
