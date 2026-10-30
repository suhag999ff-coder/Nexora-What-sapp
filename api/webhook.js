/**
 * NEXORA WhatsApp Cloud API Webhook
 * File: api/webhook.js
 * Node.js 18+ | Vercel
 *
 * REQUIRED ENV:
 * WHATSAPP_VERIFY_TOKEN
 * WHATSAPP_ACCESS_TOKEN
 * WHATSAPP_PHONE_NUMBER_ID
 * META_APP_SECRET
 * UPSTASH_REDIS_REST_URL
 * UPSTASH_REDIS_REST_TOKEN
 *
 * OPTIONAL ENV:
 * GRAPH_API_VERSION=v26.0
 * AUTO_REPLY_RULES
 * DEFAULT_AUTO_REPLY
 */

const crypto = require("node:crypto");

const GRAPH_VERSION = process.env.GRAPH_API_VERSION || "v26.0";
const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_VERSION}`;
const MAX_BODY_BYTES = Number(process.env.WEBHOOK_MAX_BODY_BYTES || 1048576);
const DEDUPE_TTL_SECONDS = 604800;
const TIMEOUT_MS = 12000;

function respond(res, status, body, type = "application/json") {
  res.statusCode = status;
  res.setHeader("Content-Type", type);
  res.setHeader("Cache-Control", "no-store");
  res.end(type === "application/json" ? JSON.stringify(body) : String(body));
}

function timingSafeEqual(a, b) {
  const x = Buffer.from(String(a || ""));
  const y = Buffer.from(String(b || ""));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;

    req.on("data", (chunk) => {
      total += chunk.length;

      if (total > MAX_BODY_BYTES) {
        reject(Object.assign(new Error("Payload too large"), { statusCode: 413 }));
        req.destroy();
        return;
      }

      chunks.push(chunk);
    });

    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
    req.on("aborted", () => reject(new Error("Request aborted")));
  });
}

function validMetaSignature(rawBody, header) {
  const secret = process.env.META_APP_SECRET;

  if (!secret || typeof header !== "string" || !header.startsWith("sha256=")) {
    return false;
  }

  const received = header.slice(7);

  if (!/^[a-f0-9]{64}$/i.test(received)) {
    return false;
  }

  const expected = crypto
    .createHmac("sha256", secret)
    .update(rawBody)
    .digest("hex");

  return timingSafeEqual(
    received.toLowerCase(),
    expected.toLowerCase()
  );
}

function getRules() {
  let rules;

  try {
    rules = JSON.parse(process.env.AUTO_REPLY_RULES || "[]");
  } catch {
    throw new Error("AUTO_REPLY_RULES is not valid JSON");
  }

  if (!Array.isArray(rules)) {
    throw new Error("AUTO_REPLY_RULES must be a JSON array");
  }

  return rules
    .filter(
      (r) =>
        r &&
        Array.isArray(r.keywords) &&
        typeof r.reply === "string" &&
        r.reply.trim()
    )
    .map((r) => ({
      keywords: r.keywords
        .filter((k) => typeof k === "string" && k.trim())
        .map((k) => k.trim().toLocaleLowerCase()),
      reply: r.reply.trim(),
    }))
    .filter((r) => r.keywords.length);
}

function messageText(message) {
  if (!message) return "";

  if (message.type === "text") {
    return message.text?.body || "";
  }

  if (message.type === "button") {
    return message.button?.text || message.button?.payload || "";
  }

  if (message.type === "interactive") {
    const item = message.interactive || {};

    return (
      item.button_reply?.title ||
      item.button_reply?.id ||
      item.list_reply?.title ||
      item.list_reply?.id ||
      ""
    );
  }

  if (["image", "document", "video"].includes(message.type)) {
    return message[message.type]?.caption || "";
  }

  return "";
}

function makeReply(text, rules) {
  const input = String(text || "").trim().toLocaleLowerCase();

  if (!input) return "";

  for (const rule of rules) {
    if (rule.keywords.some((keyword) => input.includes(keyword))) {
      return rule.reply;
    }
  }

  return (process.env.DEFAULT_AUTO_REPLY || "").trim();
}

async function redis(command) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;

  if (!url || !token) {
    throw new Error("Upstash Redis is not configured");
  }

  const response = await fetch(url, {
    method: "POST",

    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },

    body: JSON.stringify(command),

    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  const result = await response.json().catch(() => ({}));

  if (!response.ok || result.error) {
    throw new Error(`Redis error (${response.status})`);
  }

  return result.result;
}

async function claim(messageId) {
  const key = `nexora:whatsapp:message:${messageId}`;

  const result = await redis([
    "SET",
    key,
    "processing",
    "NX",
    "EX",
    DEDUPE_TTL_SECONDS,
  ]);

  return {
    key,
    claimed: result === "OK",
  };
}

async function release(key) {
  try {
    await redis(["DEL", key]);
  } catch (error) {
    console.error("Dedupe cleanup error:", error.message);
  }
}

async function sendText(to, body) {
  const phoneId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const token = process.env.WHATSAPP_ACCESS_TOKEN;

  const response = await fetch(
    `${GRAPH_BASE}/${encodeURIComponent(phoneId)}/messages`,
    {
      method: "POST",

      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },

      body: JSON.stringify({
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to,
        type: "text",

        text: {
          preview_url: false,
          body,
        },
      }),

      signal: AbortSignal.timeout(TIMEOUT_MS),
    }
  );

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(
      `WhatsApp API ${data?.error?.code || response.status}: ${
        data?.error?.message || "Send failed"
      }`
    );
  }

  return data;
}

function verifyQuery(req) {
  const url = new URL(req.url, "https://vercel.invalid");

  return {
    mode: url.searchParams.get("hub.mode"),
    token: url.searchParams.get("hub.verify_token"),
    challenge: url.searchParams.get("hub.challenge"),
  };
}

function checkEnv() {
  const required = [
    "WHATSAPP_VERIFY_TOKEN",
    "WHATSAPP_ACCESS_TOKEN",
    "WHATSAPP_PHONE_NUMBER_ID",
    "META_APP_SECRET",
    "UPSTASH_REDIS_REST_URL",
    "UPSTASH_REDIS_REST_TOKEN",
  ];

  const missing = required.filter((key) => !process.env[key]);

  if (missing.length) {
    throw new Error(
      `Missing environment variables: ${missing.join(", ")}`
    );
  }

  if (!/^v\d+\.\d+$/.test(GRAPH_VERSION)) {
    throw new Error("Invalid GRAPH_API_VERSION");
  }
}

module.exports = async function handler(req, res) {

  // META WEBHOOK VERIFICATION
  if (req.method === "GET") {
    const { mode, token, challenge } = verifyQuery(req);

    if (
      mode === "subscribe" &&
      process.env.WHATSAPP_VERIFY_TOKEN &&
      timingSafeEqual(token, process.env.WHATSAPP_VERIFY_TOKEN) &&
      challenge
    ) {
      return respond(res, 200, challenge, "text/plain");
    }

    return respond(res, 403, {
      error: "Webhook verification failed",
    });
  }

  // ONLY GET AND POST ALLOWED
  if (req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");

    return respond(res, 405, {
      error: "Method not allowed",
    });
  }

  try {
    checkEnv();

    // READ ORIGINAL REQUEST BODY
    const rawBody = await readRawBody(req);

    // VERIFY META SIGNATURE
    if (
      !validMetaSignature(
        rawBody,
        req.headers["x-hub-signature-256"]
      )
    ) {
      return respond(res, 401, {
        error: "Invalid webhook signature",
      });
    }

    // PARSE JSON
    let payload;

    try {
      payload = JSON.parse(rawBody.toString("utf8"));
    } catch {
      return respond(res, 400, {
        error: "Invalid JSON",
      });
    }

    if (payload.object !== "whatsapp_business_account") {
      return respond(res, 200, {
        received: true,
        ignored: true,
      });
    }

    const configuredPhoneId =
      process.env.WHATSAPP_PHONE_NUMBER_ID;

    const rules = getRules();

    // PROCESS INCOMING EVENTS
    for (const entry of payload.entry || []) {
      for (const change of entry.changes || []) {

        if (change.field !== "messages") continue;

        const value = change.value || {};

        const eventPhoneId =
          value.metadata?.phone_number_id;

        if (
          eventPhoneId &&
          eventPhoneId !== configuredPhoneId
        ) {
          console.warn(
            "Ignored event for a different phone number."
          );

          continue;
        }

        for (const msg of value.messages || []) {

          if (!msg?.id || !msg?.from) continue;

          const text = messageText(msg);
          const reply = makeReply(text, rules);

          if (!reply) continue;

          // DUPLICATE MESSAGE PROTECTION
          const reservation = await claim(msg.id);

          if (!reservation.claimed) {
            console.log(
              "Duplicate message delivery ignored."
            );

            continue;
          }

          try {
            // SEND AUTO REPLY
            await sendText(msg.from, reply);

            await redis([
              "SET",
              reservation.key,
              "done",
              "EX",
              DEDUPE_TTL_SECONDS,
            ]);

            console.log("Auto-reply sent.");

          } catch (error) {
            await release(reservation.key);
            throw error;
          }
        }
      }
    }

    return respond(res, 200, {
      received: true,
    });

  } catch (error) {
    console.error("Webhook error:", error.message);

    const status = Number.isInteger(error.statusCode)
      ? error.statusCode
      : 500;

    return respond(res, status, {
      error:
        status === 413
          ? "Payload too large"
          : "Webhook processing failed",
    });
  }
};

// PRESERVE RAW BODY FOR META SIGNATURE VALIDATION
module.exports.config = {
  api: {
    bodyParser: false,
  },
};
