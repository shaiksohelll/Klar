/* eslint-disable react-refresh/only-export-components */
import React, { lazy } from "react";
import ReactDOM from "react-dom/client";
import { ClerkProvider } from "@clerk/clerk-react";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import App from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";
import "./index.css";

const DemandPage = lazy(() => import("./pages/DemandPage"));
const HiringPage = lazy(() => import("./pages/HiringPage"));
const WatchlistPage = lazy(() => import("./pages/WatchlistPage"));
const ResumePage = lazy(() => import("./pages/ResumePage"));
const AboutPage = lazy(() => import("./pages/AboutPage"));
const ComparePage = lazy(() => import("./pages/ComparePage"));

const PUBLISHABLE_KEY = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY;

if (!PUBLISHABLE_KEY) {
  throw new Error("Missing VITE_CLERK_PUBLISHABLE_KEY in Client/.env");
}

const clerkAppearance = {
  variables: {
    colorPrimary: "#EB0029",
    colorBackground: "#121216",
    colorText: "#F4F4F6",
    colorTextSecondary: "#9A9AA6",
    colorInputBackground: "#08080A",
    colorInputText: "#F4F4F6",
    borderRadius: "0.75rem",
  },
  elements: {
    card: "bg-[#121216] border border-[#26262E]",
    headerTitle: "text-white",
    socialButtonsBlockButton: "border border-[#26262E] text-[#F4F4F6]",
  },
};

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <ErrorBoundary>
      <ClerkProvider
        publishableKey={PUBLISHABLE_KEY}
        appearance={clerkAppearance}
        afterSignOutUrl="/"
      >
        <BrowserRouter>
          <Routes>
            <Route element={<App />}>
              <Route index element={<DemandPage />} />
              <Route path="compare" element={<ComparePage />} />
              <Route path="hiring" element={<HiringPage />} />
              <Route path="watchlist" element={<WatchlistPage />} />
              <Route path="resume" element={<ResumePage />} />
              <Route path="about" element={<AboutPage />} />
            </Route>
          </Routes>
        </BrowserRouter>
      </ClerkProvider>
    </ErrorBoundary>
  </React.StrictMode>,
);
