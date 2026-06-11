import "dotenv/config";
import mongoose from "mongoose";
import app from "./app.js";

// ── Startup validation ─────────────────────────────────────────────────────
const IS_PROD = process.env.NODE_ENV === "production";

// MONGODB_URI is required in every environment — the server has no purpose
// without a database.
if (!process.env.MONGODB_URI) {
  console.error("❌ Missing required environment variable: MONGODB_URI");
  process.exit(1);
}

// These vars are only hard-required in production. In development they emit
// a warning so you can boot with a partial .env (e.g. to test DB queries
// without real Adzuna or Clerk credentials set up yet).
const PROD_ONLY_VARS = ["ADZUNA_APP_ID", "ADZUNA_APP_KEY", "CLERK_SECRET_KEY"];
for (const v of PROD_ONLY_VARS) {
  if (!process.env[v]) {
    if (IS_PROD) {
      console.error(`❌ Missing required environment variable: ${v}`);
      process.exit(1);
    } else {
      console.warn(`⚠️  ${v} is not set — some features will not work`);
    }
  }
}

if (!process.env.INGEST_SECRET) {
  if (IS_PROD) {
    // Fail-closed: refuse to start without the secret in production so the
    // ingest endpoint can never be publicly triggered and burn Adzuna quota.
    console.error("❌ INGEST_SECRET must be set in production");
    process.exit(1);
  } else {
    // The route guard returns 401 when INGEST_SECRET is unset, so the
    // endpoint is locked — not merely unprotected. The message says so.
    console.warn(
      "⚠️  INGEST_SECRET is not set — /api/ingest/adzuna is DISABLED until it is configured",
    );
  }
}

// ── DB connect + listen ────────────────────────────────────────────────────
const PORT = process.env.PORT || 5000;
mongoose
  .connect(process.env.MONGODB_URI)
  .then(() => {
    console.log("✅ Mongo connected");
    app.listen(PORT, () => {
      console.log(`✅ API running on http://localhost:${PORT}`);
    });
  })
  .catch((err) => {
    console.error("❌ Mongo connection failed:", err.message);
    process.exit(1);
  });
