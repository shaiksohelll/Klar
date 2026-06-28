// Reusable "Klar." wordmark: the word "Klar" followed by an accent-colored
// period (var(--accent)). Rendered wherever the UI shows "Klar" so the
// punctuation mark is consistent across every context.
export default function Brand() {
  return (
    <>
      Klar<span className="text-[var(--accent)] -ml-[0.06em]">.</span>
    </>
  );
}
