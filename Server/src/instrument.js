import "dotenv/config";
import * as Sentry from "@sentry/node";

// Initialise Sentry ONLY when a DSN is provided so local dev without the
// env var never crashes or emits spurious warnings.
if (process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.NODE_ENV || "development",
    tracesSampleRate: 0.1,
  });
}