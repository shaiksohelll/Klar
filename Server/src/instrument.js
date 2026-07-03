import "dotenv/config";
import * as Sentry from "@sentry/node";

// Initialise Sentry ONLY when a DSN is provided so local dev without the
// env var never crashes or emits spurious warnings.
if (process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.NODE_ENV || "development",
    // Tunable per environment without a redeploy; defaults to 10%.
    tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE) || 0.1,
    // Do not attach cookies / IP / auth user by default.
    sendDefaultPii: false,
    // Belt-and-suspenders: strip request bodies (résumé text, skill-gap
    // payloads) and auth headers before anything leaves the app.
    beforeSend(event) {
      if (event.request) {
        delete event.request.data;
        delete event.request.cookies;
        if (event.request.headers) {
          delete event.request.headers.authorization;
          delete event.request.headers.cookie;
        }
      }
      return event;
    },
  });
}