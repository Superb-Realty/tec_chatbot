import fs from "node:fs";
import path from "node:path";

/**
 * Lightweight zero-dependency .env parser that loads environment variables
 * from TEC-chatbot-backend/.env, .env.local, and falls back to sibling frontend .env.local
 */
const BACKEND_ROOT = path.resolve(import.meta.dirname, "../..");

function loadDotEnvFiles() {
  const candidates = [
    path.join(BACKEND_ROOT, ".env.local"),
    path.join(BACKEND_ROOT, ".env"),
    path.resolve(BACKEND_ROOT, "../TEC-scrollable_website/.env.local"),
    path.resolve(BACKEND_ROOT, "../TEC-scrollable_website/.env"),
  ];

  for (const filePath of candidates) {
    if (!fs.existsSync(filePath)) continue;
    try {
      const content = fs.readFileSync(filePath, "utf-8");
      for (const rawLine of content.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || line.startsWith("#")) continue;
        const eqIdx = line.indexOf("=");
        if (eqIdx === -1) continue;
        const key = line.slice(0, eqIdx).trim();
        let value = line.slice(eqIdx + 1).trim();
        if (
          (value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))
        ) {
          value = value.slice(1, -1);
        }
        if (process.env[key] === undefined) {
          process.env[key] = value;
        }
      }
    } catch {
      // Ignore unreadable env files
    }
  }
}

loadDotEnvFiles();

const rawApiKey = (process.env.OPENAI_API_KEY || "").trim();
const hasValidOpenAiKey =
  rawApiKey.length > 20 &&
  !rawApiKey.includes("your-openai-api-key") &&
  rawApiKey.startsWith("sk-");

const rawSupabaseUrl = (process.env.SUPABASE_URL || "").trim().replace(/\/+$/, "");
const rawSupabaseKey = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();
const hasValidSupabase =
  rawSupabaseUrl.startsWith("https://") &&
  !rawSupabaseUrl.includes("your-project-id") &&
  rawSupabaseKey.length > 20 &&
  !rawSupabaseKey.includes("your-service-role-key");

export const ENV = {
  PORT: Number(process.env.PORT || 4000),
  HOST: process.env.HOST || "127.0.0.1",
  NODE_ENV: process.env.NODE_ENV || "development",

  ALLOWED_ORIGINS: (
    process.env.ALLOWED_ORIGINS ||
    "http://localhost:3000,http://127.0.0.1:3000,http://localhost:3001,http://127.0.0.1:3001"
  )
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean),

  SUPABASE_URL: hasValidSupabase ? rawSupabaseUrl : "",
  SUPABASE_SERVICE_ROLE_KEY: hasValidSupabase ? rawSupabaseKey : "",
  SUPABASE_ENABLED: hasValidSupabase,

  OPENAI_API_KEY: hasValidOpenAiKey ? rawApiKey : "",
  OPENAI_CHAT_MODEL: process.env.OPENAI_CHAT_MODEL || "gpt-4o-mini",
  OPENAI_EMBEDDING_MODEL:
    process.env.OPENAI_EMBEDDING_MODEL || "text-embedding-3-small",

  MAX_CONCURRENT_STREAMS: Number(process.env.MAX_CONCURRENT_STREAMS || 600),
  RATE_LIMIT_WINDOW_MS: Number(process.env.RATE_LIMIT_WINDOW_MS || 60_000),
  RATE_LIMIT_MAX_MESSAGES_PER_IP: Number(
    process.env.RATE_LIMIT_MAX_MESSAGES_PER_IP || 35
  ),

  GOOGLE_SHEET_WEBHOOK_URL:
    process.env.GOOGLE_SHEET_WEBHOOK_URL ||
    "https://script.google.com/macros/s/AKfycbxTW9Aeh46lHvDCKNlOcvUXEuMaGv064CyqgcG85LKkujGR_lFGQgPY413VZwj1PqA/exec",
  ENQUIRY_SECRET_TOKEN:
    process.env.ENQUIRY_SECRET_TOKEN || "tec_leasing_key_2026",
};
