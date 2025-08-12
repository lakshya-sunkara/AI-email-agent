import fs from "fs";
import path from "path";
import readline from "readline";
import { google } from "googleapis";
import dotenv from "dotenv";
import { GoogleGenerativeAI } from "@google/generative-ai";
import twilio from "twilio";
import cron from "node-cron";

dotenv.config();
const client = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

// File paths
const CREDENTIALS_PATH = path.join(process.cwd(), "credentials.json");
const TOKEN_PATH = path.join(process.cwd(), "token.json");

const SCOPES = ["https://www.googleapis.com/auth/gmail.readonly"];

// Gemini setup
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

/**
 * Authorize Gmail API with token saving
 */
async function authorize() {
  const { client_secret, client_id, redirect_uris } = JSON.parse(
    fs.readFileSync(CREDENTIALS_PATH, "utf8")
  ).installed;

  const oAuth2Client = new google.auth.OAuth2(
    client_id,
    client_secret,
    redirect_uris[0]
  );

  if (fs.existsSync(TOKEN_PATH)) {
    oAuth2Client.setCredentials(JSON.parse(fs.readFileSync(TOKEN_PATH, "utf8")));
    return oAuth2Client;
  }

  return getNewToken(oAuth2Client);
}

function getNewToken(oAuth2Client) {
  const authUrl = oAuth2Client.generateAuthUrl({
    access_type: "offline",
    scope: SCOPES,
  });
  console.log("\nAuthorize this app by visiting this URL:\n", authUrl);

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve, reject) => {
    rl.question("\nEnter the code from that page here: ", (code) => {
      rl.close();
      oAuth2Client.getToken(code, (err, token) => {
        if (err) return reject("Error retrieving access token: " + err);
        oAuth2Client.setCredentials(token);
        fs.writeFileSync(TOKEN_PATH, JSON.stringify(token));
        console.log("✅ Token stored to", TOKEN_PATH);
        resolve(oAuth2Client);
      });
    });
  });
}

/**
 * Fetch today's emails
 */
async function getTodaysEmails(auth) {
  const gmail = google.gmail({ version: "v1", auth });

  const today = new Date();
  const tomorrow = new Date(today);
  tomorrow.setDate(today.getDate() + 1);

  const after = today.toISOString().split("T")[0];
  const before = tomorrow.toISOString().split("T")[0];

  const res = await gmail.users.messages.list({
    userId: "me",
    q: `after:${after} before:${before}`,
    maxResults: 10,
  });

  if (!res.data.messages) return [];

  const emails = [];
  for (let msg of res.data.messages) {
    const fullEmail = await gmail.users.messages.get({
      userId: "me",
      id: msg.id,
    });

    let bodyData = "";
    if (fullEmail.data.payload.parts) {
      const part = fullEmail.data.payload.parts.find(
        (p) => p.mimeType === "text/plain" && p.body.data
      );
      if (part) bodyData = part.body.data;
    } else if (fullEmail.data.payload.body?.data) {
      bodyData = fullEmail.data.payload.body.data;
    }

    const body = Buffer.from(bodyData, "base64").toString("utf-8");
    emails.push(body);
  }

  return emails;
}

/**
 * Ask Gemini to extract events from emails
 */
async function extractEvents(emails) {
  const prompt = `
You are an AI personal assistant.
From the following emails, extract ONLY today's events, exams, or appointments.
For each event, return JSON in this format:
[{"type":"Exam|Appointment|Meeting","title":"","time":"","location":"","notes":""}]
Emails:
${emails.join("\n---\n")}
`;

  const result = await model.generateContent(prompt);
  const text = result.response.text();

  try {
    const cleanText = text
      .replace(/```json/gi, "")
      .replace(/```/g, "")
      .trim();
    return JSON.parse(cleanText);
  } catch (e) {
    console.error("❌ Failed to parse AI response. Raw text:\n", text);
    return [];
  }
}

/**
 * Convert events JSON to a nice summary string
 */
function formatSummary(events) {
  if (!events || events.length === 0) {
    return "📭 You have no exams or appointments scheduled for today.";
  }

  let summary = `📅 Here's your schedule for today:\n`;
  events.forEach((ev, idx) => {
    summary += `\n${idx + 1}. ${ev.type} — ${ev.title || "No title"}\n   🕒 Time: ${ev.time || "Not specified"}\n   📍 Location: ${ev.location || "Not specified"}\n   📝 Notes: ${ev.notes || "None"}\n`;
  });
  return summary;
}

/**
 * Main
 */

async function runDailyCheck() {
  const auth = await authorize();
  const emails = await getTodaysEmails(auth);
  if (emails.length === 0) {
    console.log("📭 No emails found for today.");
    return;
  }

  const events = await extractEvents(emails);
  const summary = formatSummary(events);

  console.log(summary);
  console.log("\nRaw JSON output:", events);

  if (events.length > 0) {
    await client.messages.create({
      from: process.env.WHATSAPP_FROM,
      to: process.env.WHATSAPP_TO,
      body: summary,
    });
    console.log("✅ Sent schedule to WhatsApp!");
  } else {
    console.log("ℹ️ No events found — WhatsApp message not sent.");
  }
}

// Schedule to run every day at 7:00 AM
cron.schedule("0 7 * * *", () => {
  console.log("⏰ Running daily exam/interview check...");
  runDailyCheck();
});

// Run immediately on start too (optional)
runDailyCheck();


