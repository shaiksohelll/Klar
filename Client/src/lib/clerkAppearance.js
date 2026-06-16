// clerkAppearance — Clerk cannot read CSS variables, so its theme is built
// from LITERAL hex/px that mirror the Clarity tokens for the active theme.
// Every value is chosen for AA+ contrast against its surface (this is the fix
// for the known low-contrast auth bug): body text and inputs clear 7:1 in
// dark and ~13:1 in light, secondary text clears 4.5:1, and the accent
// primary keeps white button text.
//
// Pass the result to <ClerkProvider appearance> and/or per-component
// `appearance` props. Recompute on theme change so the modal matches the app.
const DARK = {
  bg: "#08080A",
  panel: "#121216",
  surface2: "#1E1E24",
  text: "#F4F4F6",
  textSecondary: "#B6B6C0", // lifted from --muted for 4.5:1 on --panel
  border: "#232329",
  inputBg: "#1E1E24",
  primary: "#EB0029",
  primaryText: "#FFFFFF",
};

const LIGHT = {
  bg: "#F6F6F8",
  panel: "#FFFFFF",
  surface2: "#EDEDF1",
  text: "#16161A",
  textSecondary: "#5C5C66",
  border: "#E4E4EA",
  inputBg: "#FFFFFF",
  primary: "#EB0029",
  primaryText: "#FFFFFF",
};

export function clerkAppearance(theme) {
  const c = theme === "light" ? LIGHT : DARK;
  return {
    variables: {
      colorPrimary: c.primary,
      colorBackground: c.panel,
      colorText: c.text,
      colorTextSecondary: c.textSecondary,
      colorInputBackground: c.inputBg,
      colorInputText: c.text,
      colorDanger: "#EB0029",
      borderRadius: "10px",
      fontFamily: '"Space Grotesk", system-ui, sans-serif',
    },
    elements: {
      // Clarity surface, hairline border, soft elevation.
      card: {
        backgroundColor: c.panel,
        border: `1px solid ${c.border}`,
        boxShadow:
          theme === "light"
            ? "0 16px 40px rgba(16,16,26,0.12)"
            : "0 16px 40px rgba(0,0,0,0.55)",
      },
      headerTitle: { color: c.text },
      headerSubtitle: { color: c.textSecondary },
      socialButtonsBlockButton: {
        backgroundColor: c.surface2,
        border: `1px solid ${c.border}`,
        color: c.text,
      },
      dividerText: { color: c.textSecondary },
      formFieldLabel: { color: c.text },
      formFieldInput: {
        backgroundColor: c.inputBg,
        border: `1px solid ${c.border}`,
        color: c.text,
      },
      formButtonPrimary: {
        backgroundColor: c.primary,
        color: c.primaryText,
        textTransform: "none",
      },
      footerActionText: { color: c.textSecondary },
      footerActionLink: { color: c.primary },
      identityPreviewText: { color: c.text },
      formFieldInputShowPasswordButton: { color: c.textSecondary },
    },
  };
}
