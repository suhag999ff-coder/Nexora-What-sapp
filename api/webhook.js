
// ==========================================
// NEXORA AI - WHATSAPP AUTO REPLY SYSTEM
// Node.js + Vercel + WhatsApp Cloud API
// ==========================================

const crypto = require("crypto");

const VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN;
const ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;
const PHONE_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
const APP_SECRET = process.env.META_APP_SECRET;

const GRAPH_VERSION =
  process.env.GRAPH_API_VERSION || "v23.0";

// AUTO REPLY KEYWORDS
const DEFAULT_RULES = [
  {
    keywords: ["hi", "hello", "hey"],
    reply: "Hello! 👋 Welcome to NEXORA AI."
  },
  {
    keywords: ["salam", "assalamu alaikum"],
    reply: "Wa Alaikum Assalam! ❤️"
  },
  {
    keywords: ["price", "দাম"],
    reply: "কোন পণ্যের দাম জানতে চান?"
  },
  {
    keywords: ["help", "সাহায্য"],
    reply: "কীভাবে আপনাকে সাহায্য করতে পারি?"
  },
  {
    keywords: ["location", "ঠিকানা"],
    reply: "আমাদের লোকেশন জানতে মেসেজ করুন।"
  }
];

// LOAD CUSTOM RULES FROM VERCEL
function getRules() {
  try {
    if (process.env.AUTO_REPLY_RULES) {
      return JSON.parse(process.env.AUTO_REPLY_RULES);
    }
  } catch (error) {
    console.error("Invalid AUTO_REPLY_RULES");
  }

  return DEFAULT_RULES;
}

// FIND MATCHING KEYWORD
function getReply(message) {
  const text = String(message || "").toLowerCase().trim();

  for (const rule of getRules()) {
    if (!rule.keywords || !rule.reply) continue;

    const matched = rule.keywords.some(keyword =>
      text.includes(String(keyword).toLowerCase())
    );

    if (matched) return String(rule.reply);
  }

  return process.env.DEFAULT_AUTO_REPLY ||
    "Thanks for your message! আমরা শীঘ্রই উত্তর দেব। ❤️";
}

// VERIFY META WEBHOOK SIGNATURE
function verifySignature(body, signature) {
  if (!APP_SECRET) return false;

  if (!signature || !signature.startsWith("sha256=")) {
    return false;
  }

  const expected =
    "sha256=" +
    crypto.createHmac("sha256", APP_SECRET)
      .update(body)
      .digest("hex");

  const a = Buffer.from(expected);
  const b = Buffer.from(signature);

  return a.length === b.length &&
    crypto.timingSafeEqual(a, b);
}

// READ RAW REQUEST BODY
async function readBody(req) {
  const chunks = [];

  for await (const chunk of req) {
    chunks.push(Buffer.from(chunk));
  }

  return Buffer.concat(chunks);
}

// SEND WHATSAPP MESSAGE
async function sendMessage(to, message) {
  const url =
    `https://graph.facebook.com/${GRAPH_VERSION}/${PHONE_ID}/messages`;

  const response = await fetch(url, {
    method: "POST",

    headers: {
      "Authorization": `Bearer ${ACCESS_TOKEN}`,
      "Content-Type": "application/json"
    },

    body: JSON.stringify({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: to,
      type: "text",
      text: {
        preview_url: false,
        body: message
      }
    })
  });

  const result = await response.json();

  if (!response.ok) {
    console.error("WhatsApp API Error:", result);
    throw new Error("Message sending failed");
  }

  return result;
}

// MAIN VERCEL WEBHOOK
module.exports = async function handler(req, res) {

  // WEBHOOK VERIFICATION
  if (req.method === "GET") {
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];

    if (
      mode === "subscribe" &&
      VERIFY_TOKEN &&
      token === VERIFY_TOKEN
    ) {
      res.statusCode = 200;
      return res.end(challenge || "");
    }

    res.statusCode = 403;
    return res.end("Verification failed");
  }

  // ONLY POST REQUEST
  if (req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    res.statusCode = 405;
    return res.end("Method not allowed");
  }

  // CHECK CONFIGURATION
  if (!VERIFY_TOKEN || !ACCESS_TOKEN || !PHONE_ID || !APP_SECRET) {
    res.statusCode = 500;
    return res.end("Missing environment variables");
  }

  let body;
  let data;

  try {
    body = await readBody(req);

    if (!verifySignature(
      body,
      req.headers["x-hub-signature-256"]
    )) {
      res.statusCode = 401;
      return res.end("Invalid signature");
    }

    data = JSON.parse(body.toString("utf8"));

  } catch (error) {
    console.error(error);
    res.statusCode = 400;
    return res.end("Invalid request");
  }

  // CHECK WHATSAPP EVENT
  if (data.object !== "whatsapp_business_account") {
    res.statusCode = 200;
    return res.end("Event ignored");
  }

  const messages = [];

  for (const entry of data.entry || []) {
    for (const change of entry.changes || []) {

      if (change.field !== "messages") continue;

      const incoming = change.value.messages || [];

      for (const message of incoming) {
        if (
          message.type === "text" &&
          message.from &&
          message.id
        ) {
          messages.push(message);
        }
      }
    }
  }

  // PROCESS INCOMING MESSAGES
  try {
    for (const message of messages) {

      const incomingText = message.text.body;

      const reply = getReply(incomingText);

      await sendMessage(message.from, reply);

      console.log(
        "NEXORA AUTO REPLY SENT:",
        message.id
      );
    }

  } catch (error) {
    console.error("AUTO REPLY ERROR:", error);
    res.statusCode = 500;
    return res.end("Reply processing failed");
  }

  res.statusCode = 200;

  return res.json({
    success: true,
    app: "NEXORA AI",
    received: messages.length,
    message: "Webhook processed"
  });
};

// REQUIRED FOR META SIGNATURE VALIDATION
module.exports.config = {
  api: {
    bodyParser: false
  }
};
