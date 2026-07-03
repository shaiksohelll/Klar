import "dotenv/config";
import * as Sentry from "@sentry/node";

// Parse the trace sample rate so an explicit 0 (fully disable tracing) is
// respected; fall back to 10% only when unset/invalid, and clamp to 0..1.
const rawSampleRate = process.env.SENTRY_TRACES_SAMPLE_RATE;
const tracesSampleRate =
  rawSampleRate === undefined || Number.isNaN(Number(rawSampleRate))
    ? 0.1
    : Math.min(1, Math.max(0, Number(rawSampleRate)));

// Headers we never want leaving the app, matched case-insensitively.
const SENSITIVE_HEADERS = new Set(["authorization", "cookie"]);

// Initialise Sentry ONLY when a DSN is provided so local dev without the
// env var never crashes or emits spurious warnings.
if (process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.NODE_ENV || "development",
    tracesSampleRate,
    // Do not attach cookies / IP / auth user by default.
    sendDefaultPii: false,
    // Belt-and-suspenders: strip request bodies (résumé text, skill-gap
    // payloads) and sensitive headers before anything leaves the app.
    beforeSend(event) {
      if (event.request) {
        delete event.request.data;
        delete event.request.cookies;
        if (event.request.headers) {
          for (const header of Object.keys(event.request.headers)) {
            if (SENSITIVE_HEADERS.has(header.toLowerCase())) {
              delete event.request.headers[header];
            }
          }
        }
      }
      return event;
    },
  });
}