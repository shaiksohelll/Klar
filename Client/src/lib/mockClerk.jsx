/* eslint-disable react-refresh/only-export-components, no-unused-vars */
import React, { createContext, useContext, useState, useEffect, useCallback } from "react";

// The mock context
export const MockClerkContext = createContext({
  isSignedIn: true,
  user: { id: "test-user-id" },
});

export function ClerkProvider({ children }) {
  const [isSignedIn, setIsSignedIn] = useState(true);

  // We can expose a global to let tests toggle signed in state if needed
  useEffect(() => {
    window.__mockClerkSignIn = () => setIsSignedIn(true);
    window.__mockClerkSignOut = () => setIsSignedIn(false);
  }, []);

  return (
    <MockClerkContext.Provider
      value={{
        isSignedIn,
        user: isSignedIn ? { id: "test-user-id" } : null,
      }}
    >
      {children}
    </MockClerkContext.Provider>
  );
}

export function useUser() {
  const { isSignedIn, user } = useContext(MockClerkContext);
  return { isSignedIn, user, isLoaded: true };
}

export function useAuth() {
  const { isSignedIn } = useContext(MockClerkContext);
  const getToken = useCallback(async () => (isSignedIn ? "test-token" : null), [isSignedIn]);
  return { isSignedIn, getToken };
}

export function useClerk() {
  return {
    openSignIn: () => {
      if (window.__mockClerkSignIn) window.__mockClerkSignIn();
    },
    signOut: () => {
      if (window.__mockClerkSignOut) window.__mockClerkSignOut();
    },
  };
}

export function UserButton() {
  const { isSignedIn } = useContext(MockClerkContext);
  if (!isSignedIn) return null;
  return (
    <button aria-label="Mock User Button" className="w-8 h-8 rounded-full bg-gray-500">
      U
    </button>
  );
}
