import React from "react";
import ReactDOM from "react-dom/client";
import { ClerkProvider } from "@clerk/clerk-react";
import App from "./App";
import "./index.css";

const PUBLISHABLE_KEY = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY;

if (!PUBLISHABLE_KEY) {
  throw new Error("Missing VITE_CLERK_PUBLISHABLE_KEY in Client/.env");
}

// Dark black + red Clerk modal to match the Klar theme
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
    <ClerkProvider
      publishableKey={PUBLISHABLE_KEY}
      appearance={clerkAppearance}
      afterSignOutUrl="/"
    >
      <App />
    </ClerkProvider>
  </React.StrictMode>,
);
