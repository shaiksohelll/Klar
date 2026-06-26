// Reusable "Klar." wordmark with the brand-accent red dot (#EB0029),
// matching the logo in App.jsx. Rendered wherever the visible UI text
// "Klar" appears so the red dot is consistent everywhere.
export default function Brand() {
  return (
    <>
      Klar<span className="text-[var(--accent)]">.</span>
    </>
  );
}
