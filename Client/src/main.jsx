/* eslint-disable react-refresh/only-export-components */
import React, { lazy } from "react";
import ReactDOM from "react-dom/client";
import { ClerkProvider } from "@clerk/clerk-react";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import App from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { useTheme } from "./lib/useTheme";
import { clerkAppearance } from "./lib/clerkAppearance";
import "./index.css";

const DemandPage = lazy(() => import("./pages/DemandPage"));
const HiringPage = lazy(() => import("./pages/HiringPage"));
const WatchlistPage = lazy(() => import("./pages/WatchlistPage"));
const ResumePage = lazy(() => import("./pages/ResumePage"));
const AboutPage = lazy(() => import("./pages/AboutPage"));
const ComparePage = lazy(() => import("./pages/ComparePage"));
const AtlasPage = lazy(() => import("./pages/AtlasPage"));
const RelocatePage = lazy(() => import("./pages/RelocatePage"));

const PUBLISHABLE_KEY = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY;

if (!PUBLISHABLE_KEY) {
  throw new Error("Missing VITE_CLERK_PUBLISHABLE_KEY in Client/.env");
}

// Subscribe to the live theme so Clerk's literal-hex appearance tracks the
// app's light/dark state (Clerk cannot read CSS variables).
function ThemedClerkProvider({ children }) {
  const theme = useTheme();
  return (
    <ClerkProvider
      publishableKey={PUBLISHABLE_KEY}
      appearance={clerkAppearance(theme)}
      afterSignOutUrl="/"
    >
      {children}
    </ClerkProvider>
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <ErrorBoundary>
      <ThemedClerkProvider>
        <BrowserRouter>
          <Routes>
            <Route element={<App />}>
              <Route index element={<DemandPage />} />
              <Route path="atlas" element={<AtlasPage />} />
              <Route path="relocate" element={<RelocatePage />} />
              <Route path="compare" element={<ComparePage />} />
              <Route path="hiring" element={<HiringPage />} />
              <Route path="watchlist" element={<WatchlistPage />} />
              <Route path="resume" element={<ResumePage />} />
              <Route path="about" element={<AboutPage />} />
            </Route>
          </Routes>
        </BrowserRouter>
      </ThemedClerkProvider>
    </ErrorBoundary>
  </React.StrictMode>,
);
