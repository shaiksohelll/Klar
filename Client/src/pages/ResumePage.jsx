import { useState, useRef, useCallback } from "react";
import axios from "axios";
import { motion, AnimatePresence } from "framer-motion";
import { useOutletContext } from "react-router-dom";
import { extractTextFromFile } from "../lib/parseResume";
import { displayName } from "../lib/displayName";
import Brand from "../components/Brand";
import Num from "../components/ui/Num";

const API = import.meta.env.VITE_API_URL || "http://localhost:5000";
const MAX_CHARS = 50_000;

// Spring constants matching the rest of the app
const UI_SPRING = { type: "spring", stiffness: 180, damping: 22 };
const EASE = [0.16, 1, 0.3, 1];

// Section entrance: stagger children upward
const containerVariants = {
  hidden: {},
  show: { transition: { staggerChildren: 0.08 } },
};
const itemVariants = {
  hidden: { opacity: 0, y: 18 },
  show: { opacity: 1, y: 0, transition: { duration: 0.5, ease: EASE } },
};

// Dial arc helpers
const DIAL_R = 44;
const DIAL_CIRC = 2 * Math.PI * DIAL_R;

function ScoreDial({ score }) {
  const filled = (score / 100) * DIAL_CIRC;
  const color = score >= 70 ? "#22c55e" : score >= 40 ? "#f59e0b" : "#EB0029";
  return (
    <svg
      width="120"
      height="120"
      viewBox="0 0 100 100"
      className="-rotate-90"
      aria-hidden="true"
    >
      <circle
        cx="50"
        cy="50"
        r={DIAL_R}
        fill="none"
        stroke="var(--border)"
        strokeWidth="8"
      />
      <motion.circle
        cx="50"
        cy="50"
        r={DIAL_R}
        fill="none"
        stroke={color}
        strokeWidth="8"
        strokeLinecap="round"
        strokeDasharray={DIAL_CIRC}
        initial={{ strokeDashoffset: DIAL_CIRC }}
        animate={{ strokeDashoffset: DIAL_CIRC - filled }}
        transition={{ duration: 0.9, ease: EASE }}
      />
    </svg>
  );
}

// ── Inline SVG icons (token-colored, no emoji) ──────────────────────────────

/** Upload / document icon — neutral muted colour */
function IconDocument() {
  return (
    <svg
      width="32"
      height="32"
      viewBox="0 0 24 24"
      fill="none"
      stroke="var(--muted-2)"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
      <line x1="16" y1="13" x2="8" y2="13" />
      <line x1="16" y1="17" x2="8" y2="17" />
      <polyline points="10 9 9 9 8 9" />
    </svg>
  );
}

/** Check-circle icon — var(--pos) green */
function IconCheck() {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="var(--pos)"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="10" />
      <polyline points="9 12 11 14 15 10" />
    </svg>
  );
}

/** Dot / circle icon — var(--accent) red for missing skills */
function IconMissing() {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="var(--accent)"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="10" />
    </svg>
  );
}

// ── Loading skeleton ─────────────────────────────────────────────────────────

function ResultsSkeleton() {
  return (
    <div
      aria-label="Analyzing your resume…"
      aria-busy="true"
      className="space-y-8"
    >
      {/* Overview card skeleton */}
      <div className="rounded-2xl border border-(--border) bg-(--panel) p-6 md:p-8">
        <div className="flex flex-col sm:flex-row items-center gap-8">
          {/* Dial placeholder */}
          <div className="skeleton shrink-0 w-[120px] h-[120px] rounded-full" />
          {/* Copy placeholders */}
          <div className="flex-1 space-y-3 w-full">
            <div className="skeleton h-3 w-24 rounded" />
            <div className="skeleton h-7 w-3/4 rounded" />
            <div className="skeleton h-4 w-1/2 rounded" />
          </div>
        </div>
      </div>

      {/* Chip section skeletons */}
      {[6, 8].map((count, si) => (
        <div key={si} className="space-y-4">
          <div className="flex items-center gap-3">
            <div className="skeleton w-5 h-5 rounded-full" />
            <div className="skeleton h-3 w-40 rounded" />
          </div>
          <div className="flex flex-wrap gap-2">
            {Array.from({ length: count }).map((_, i) => (
              <div
                key={i}
                className="skeleton h-7 rounded-full"
                style={{ width: `${60 + (i % 3) * 20}px` }}
              />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

// ── Onboarding empty state ───────────────────────────────────────────────────

function EmptyState({ onAnalyze }) {
  return (
    <motion.div
      key="empty"
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -8 }}
      transition={{ duration: 0.4, ease: EASE }}
      className="rounded-2xl border border-dashed border-(--border) bg-(--panel) p-10 flex flex-col items-center gap-5 text-center"
    >
      {/* Value prop */}
      <p className="text-base text-(--muted) font-medium max-w-sm leading-relaxed">
        Paste or upload your resume above, then hit{" "}
        <span className="text-(--text) font-semibold">Analyze</span> to
        see exactly which top-40 in-demand skills are missing, sourced from
        live job postings, not guesswork.
      </p>

      {/* Single CTA */}
      <button
        onClick={onAnalyze}
        className="px-8 py-3 rounded-xl bg-(--accent) hover:bg-(--accent-hover) text-white font-mono text-sm uppercase tracking-widest font-medium transition-all shadow-[0_0_20px_rgba(235,0,41,0.2)] hover:shadow-[0_0_30px_rgba(255,39,64,0.4)] hover:-translate-y-0.5"
      >
        Analyze Resume
      </button>
    </motion.div>
  );
}

// ── Main component ───────────────────────────────────────────────────────────

export default function ResumePage() {
  // Grab setSelectedSkill from the outlet context so missing chips can open
  // the existing SkillDrawer exactly like chips elsewhere in the app do.
  const { setSelectedSkill } = useOutletContext();

  const [text, setText] = useState("");
  const [fileName, setFileName] = useState(null);
  const [parseError, setParseError] = useState(null);
  const [isDragging, setIsDragging] = useState(false);

  const [loading, setLoading] = useState(false);
  const [apiError, setApiError] = useState(null);
  const [result, setResult] = useState(null);
  const [parsing, setParsing] = useState(false);

  // Track whether the user has ever triggered an analysis (to show empty state)
  const [hasRun, setHasRun] = useState(false);

  const fileInputRef = useRef(null);
  const reqIdRef = useRef(0);
  const parseIdRef = useRef(0);

  // ── File handling ──────────────────────────────────────────────────────────

  const processFile = useCallback(async (file) => {
    const myParseId = ++parseIdRef.current;
    reqIdRef.current++;            // invalidate any in-flight analysis
    setLoading(false);
    setParsing(true);
    setParseError(null);
    setFileName(file.name);
    setResult(null);
    setApiError(null);
    try {
      const extracted = await extractTextFromFile(file);
      if (myParseId !== parseIdRef.current) return; // superseded — drop it
      setText(extracted);
    } catch (err) {
      if (myParseId !== parseIdRef.current) return;
      setParseError(err.message);
      setFileName(null);
    } finally {
      if (myParseId === parseIdRef.current) setParsing(false);
    }
  }, []);

  const handleFileChange = (e) => {
    const file = e.target.files?.[0];
    if (file) processFile(file);
    // Reset input so the same file can be re-selected
    e.target.value = "";
  };

  const handleDrop = (e) => {
    e.preventDefault();
    setIsDragging(false);
    const file = e.dataTransfer.files?.[0];
    if (file) processFile(file);
  };

  // ── Analysis ───────────────────────────────────────────────────────────────

  const handleAnalyze = async () => {
    if (parsing) return;
    const trimmed = text.trim();
    if (!trimmed) {
      setResult(null);
      setApiError("Paste your resume text or upload a file first.");
      return;
    }
    const payload = trimmed.slice(0, MAX_CHARS);
    setLoading(true);
    setApiError(null);
    setResult(null);
    setHasRun(true);
    const myReqId = ++reqIdRef.current;
    try {
      const res = await axios.post(`${API}/api/resume-gap`, { text: payload });
      if (myReqId === reqIdRef.current) setResult(res.data);
    } catch (err) {
      const msg = err.response?.data?.error || "Analysis failed. Please try again.";
      if (myReqId === reqIdRef.current) setApiError(msg);
    } finally {
      if (myReqId === reqIdRef.current) setLoading(false);
    }
  };

  const handleClear = () => {
    reqIdRef.current++;
    parseIdRef.current++;
    setText("");
    setFileName(null);
    setParseError(null);
    setResult(null);
    setApiError(null);
    setLoading(false);
    setParsing(false);
    setHasRun(false);
  };

  // ── Chip click → SkillDrawer ───────────────────────────────────────────────
  const openSkill = (skill) => {
    setSelectedSkill({ id: skill, name: skill, role: "General" });
  };

  // Aria label for the accessible dial wrapper
  const matchedCount = (result?.matched ?? []).length;
  const totalConsidered = result?.totalConsidered ?? 0;
  const matchScore = result?.matchScore ?? 0;
  const dialAriaLabel = result
    ? `Match score ${matchScore} of 100. You cover ${matchedCount} of the top ${totalConsidered} in-demand skills.`
    : "Match score dial";

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <main className="max-w-3xl mx-auto px-4 md:px-6 mt-16 md:mt-24 pb-32 space-y-12 relative z-10">

      {/* ── Hero ─────────────────────────────────────────────────────────── */}
      <section className="text-center max-w-2xl mx-auto space-y-5">
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          className="font-mono text-(--accent) text-xs uppercase tracking-[0.2em] font-bold"
        >
          <Brand /> RESUME Gap Analysis
        </motion.div>
        <motion.h1
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.1, duration: 0.6, ease: EASE }}
          className="font-space font-bold text-5xl md:text-6xl leading-[1.05] tracking-tight text-(--text)"
        >
          See exactly what{" "}
          <span className="text-(--accent) italic">you&apos;re missing.</span>
        </motion.h1>
        <motion.p
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.2, duration: 0.6, ease: EASE }}
          className="text-lg text-(--muted) font-medium"
        >
          Paste your resume or upload a file. We compare it against the current top-40
          in-demand skills from live job postings. No AI, no estimates.
        </motion.p>
      </section>

      {/* ── Input card ───────────────────────────────────────────────────── */}
      <motion.div
        initial={{ opacity: 0, y: 24 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.3, duration: 0.6, ease: EASE }}
        className="rounded-2xl border border-(--border) bg-(--panel) p-6 md:p-8 space-y-5"
      >
        {/* Drag-and-drop zone */}
        <div
          role="button"
          tabIndex={0}
          aria-label="Upload resume file"
          onDragEnter={() => setIsDragging(true)}
          onDragLeave={() => setIsDragging(false)}
          onDragOver={(e) => e.preventDefault()}
          onDrop={handleDrop}
          onClick={() => fileInputRef.current?.click()}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              fileInputRef.current?.click();
            }
          }}
          className={`relative flex flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed py-8 px-4 cursor-pointer transition-colors focus:outline-none focus-visible:border-(--accent) focus-visible:ring-2 focus-visible:ring-(--accent) ${
            isDragging
              ? "border-(--accent) bg-[#EB0029]/5"
              : "border-(--border) hover:border-(--muted-2)"
          }`}
        >
          <input
            ref={fileInputRef}
            type="file"
            accept=".pdf,.docx,.txt"
            className="sr-only"
            onChange={handleFileChange}
            id="resume-file-input"
            aria-label="Upload resume file"
          />
          {/* Inline SVG replaces the 📄 emoji */}
          <IconDocument />
          <div className="text-center">
            <p className="text-sm text-(--text) font-medium">
              {fileName ? (
                <span className="text-(--accent)">{fileName}</span>
              ) : (
                <>
                  <span className="text-(--accent)">Click to upload</span> or drag &amp; drop
                </>
              )}
            </p>
            <p className="font-mono text-xs text-(--muted-2) mt-1">
              PDF, DOCX, or TXT
            </p>
          </div>
        </div>

        {parseError && (
          <p className="font-mono text-xs text-(--accent)" role="alert">
            {parseError}
          </p>
        )}

        {/* Divider */}
        <div className="flex items-center gap-3">
          <div className="flex-1 h-px bg-(--border)" />
          <span className="font-mono text-xs text-(--muted-2) uppercase tracking-widest">or paste text</span>
          <div className="flex-1 h-px bg-(--border)" />
        </div>

        {/* Textarea */}
        <div className="relative">
          <textarea
            id="resume-textarea"
            value={text}
            onChange={(e) => {
              parseIdRef.current++;
              reqIdRef.current++;
              setParsing(false);
              setLoading(false);
              setText(e.target.value);
              setFileName(null);
              setParseError(null);
              setResult(null);
              setApiError(null);
            }}
            rows={10}
            maxLength={MAX_CHARS}
            placeholder="Paste your resume here…"
            className="w-full rounded-xl bg-(--bg) border border-(--border) focus:border-(--accent) focus:outline-none text-(--text) placeholder-(--muted-2) text-sm p-4 resize-y transition-colors font-mono leading-relaxed"
            aria-label="Resume text"
          />
          {/* Char counter — Num wraps both numerals */}
          <div className="absolute bottom-3 right-3 font-mono text-[10px] text-(--muted-2)">
            <Num>{text.length}</Num> / <Num>{MAX_CHARS}</Num>
          </div>
        </div>

        {text.trim().length > MAX_CHARS && (
          <p className="font-mono text-[10px] text-(--muted-2)">
            Only the first 50,000 characters were analyzed.
          </p>
        )}

        {/* Action buttons */}
        <div className="flex items-center gap-3">
          <button
            onClick={handleAnalyze}
            disabled={loading || parsing}
            className="flex-1 py-4 rounded-xl bg-(--accent) hover:bg-(--accent-hover) disabled:opacity-50 disabled:cursor-not-allowed text-white font-mono text-sm uppercase tracking-widest font-medium transition-all shadow-[0_0_20px_rgba(235,0,41,0.2)] hover:shadow-[0_0_30px_rgba(255,39,64,0.4)] hover:-translate-y-0.5"
            aria-busy={loading || parsing}
          >
            {parsing ? (
              <span className="flex items-center justify-center gap-2">
                <motion.span
                  animate={{ rotate: 360 }}
                  transition={{ duration: 1, repeat: Infinity, ease: "linear" }}
                  className="inline-block w-4 h-4 border-2 border-white border-t-transparent rounded-full"
                />
                Parsing…
              </span>
            ) : loading ? (
              <span className="flex items-center justify-center gap-2">
                <motion.span
                  animate={{ rotate: 360 }}
                  transition={{ duration: 1, repeat: Infinity, ease: "linear" }}
                  className="inline-block w-4 h-4 border-2 border-white border-t-transparent rounded-full"
                />
                Analyzing…
              </span>
            ) : (
              "Analyze Resume"
            )}
          </button>
          {(text || result) && (
            <button
              onClick={handleClear}
              className="px-5 py-4 rounded-xl border border-(--border) text-(--muted) hover:text-(--text) hover:border-(--muted-2) font-mono text-sm uppercase tracking-widest transition-colors"
            >
              Clear
            </button>
          )}
        </div>

        {apiError && (
          <p className="font-mono text-xs text-(--accent)" role="alert">
            {apiError}
          </p>
        )}
      </motion.div>

      {/* ── Results / skeleton / empty state ─────────────────────────────── */}
      <AnimatePresence mode="wait">

        {/* Loading skeleton — shown during analysis */}
        {loading && (
          <motion.div
            key="skeleton"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
          >
            <ResultsSkeleton />
          </motion.div>
        )}

        {/* Onboarding empty state — before first run, no text, no error */}
        {!loading && !result && !apiError && !hasRun && (
          <EmptyState onAnalyze={handleAnalyze} />
        )}

        {/* Results — shown after a successful analysis */}
        {result && !loading && (
          <motion.div
            key="results"
            variants={containerVariants}
            initial="hidden"
            animate="show"
            exit="hidden"
            className="space-y-8"
          >
            {/* Overview card */}
            <motion.div
              variants={itemVariants}
              className="rounded-2xl border border-(--border) bg-(--panel) p-6 md:p-8"
            >
              <div className="flex flex-col sm:flex-row items-center gap-8">
                {/* Score dial — accessible wrapper */}
                <div
                  role="img"
                  aria-label={dialAriaLabel}
                  className="relative shrink-0 flex items-center justify-center"
                >
                  <ScoreDial score={matchScore} />
                  <div className="absolute inset-0 flex flex-col items-center justify-center">
                    <span className="font-space font-bold text-3xl text-(--text) leading-none">
                      {/* match score numeral */}
                      <Num>{matchScore}</Num>
                    </span>
                    <span className="font-mono text-[10px] text-(--muted-2) uppercase tracking-widest mt-0.5">
                      %
                    </span>
                  </div>
                </div>

                {/* Copy */}
                <div className="text-center sm:text-left space-y-2">
                  <div className="font-mono text-xs uppercase tracking-widest text-(--accent)">
                    Match Score
                  </div>
                  <p className="text-xl md:text-2xl font-space font-bold text-(--text) leading-snug">
                    You cover{" "}
                    {/* "cover X of top N" counts */}
                    <span className="text-(--accent)"><Num>{matchedCount}</Num></span>{" "}
                    of the top{" "}
                    <span className="text-(--accent)"><Num>{totalConsidered}</Num></span>{" "}
                    in-demand skills.
                  </p>
                  <p className="text-sm text-(--muted)">
                    {(() => {
                      const considered = result?.totalConsidered
                        ?? ((result?.matched?.length ?? 0) + (result?.missing?.length ?? 0));
                      if (considered === 0) {
                        return "Not enough market data yet. Try again once more jobs have been ingested.";
                      }
                      return (result?.missing ?? []).length === 0
                        ? "You've got every skill in the top 40. Impressive."
                        : `${(result?.missing ?? []).length} skill${(result?.missing ?? []).length > 1 ? "s" : ""} from the market's top ${result?.totalConsidered ?? 0} are missing from your resume.`;
                    })()}
                  </p>

                  {/* Methodology note — no fake confidence % */}
                  <p className="font-mono text-[10px] text-(--muted-2) leading-relaxed mt-1">
                    Exact count of matched vs the top-N in-demand skills from live postings. Not an AI estimate.
                  </p>
                </div>
              </div>
            </motion.div>

            {/* Matched skills */}
            {matchedCount > 0 && (
              <motion.div variants={itemVariants} className="space-y-4">
                <div className="flex items-center gap-3">
                  {/* Inline SVG replaces ✅ emoji */}
                  <IconCheck />
                  <div>
                    <div className="font-mono text-xs uppercase tracking-widest text-(--muted-2)">
                      Skills you have that the market wants
                    </div>
                    <div className="font-mono text-[10px] text-(--muted-2) mt-0.5">
                      {/* "N skills matched" count */}
                      <Num>{matchedCount}</Num> skill{matchedCount !== 1 ? "s" : ""} matched
                    </div>
                  </div>
                </div>
                <div className="flex flex-wrap gap-2">
                  {(result?.matched ?? []).map(({ skill, count }) => (
                    <motion.span
                      key={skill}
                      layout
                      transition={UI_SPRING}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full border border-(--border) bg-(--surface-2) text-[#22c55e] font-mono text-xs"
                    >
                      {displayName(skill)}
                      {/* matched chip count */}
                      <span className="text-[#22c55e] opacity-60 text-[10px]"><Num>{count}</Num></span>
                    </motion.span>
                  ))}
                </div>
              </motion.div>
            )}

            {/* Missing skills */}
            {(result?.missing ?? []).length > 0 && (
              <motion.div variants={itemVariants} className="space-y-4">
                <div className="flex items-center gap-3">
                  {/* Inline SVG dot replaces 🔴 emoji */}
                  <IconMissing />
                  <div>
                    <div className="font-mono text-xs uppercase tracking-widest text-(--muted-2)">
                      In-demand skills you&apos;re missing
                    </div>
                    <div className="font-mono text-[10px] text-(--muted-2) mt-0.5">
                      Click any chip to explore the skill
                    </div>
                  </div>
                </div>
                <div className="flex flex-wrap gap-2">
                  {(result?.missing ?? []).map(({ skill, count }) => (
                    <motion.button
                      key={skill}
                      layout
                      transition={UI_SPRING}
                      onClick={() => openSkill(skill)}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full border border-(--border) bg-(--panel) text-(--muted) hover:text-(--text) hover:border-(--accent) hover:bg-[#1A0508] font-mono text-xs transition-colors cursor-pointer"
                    >
                      {displayName(skill)}
                      {/* missing chip count */}
                      <span className="text-(--muted-2) text-[10px]"><Num>{count}</Num></span>
                    </motion.button>
                  ))}
                </div>
              </motion.div>
            )}

            {/* Resume skills detected (secondary context) */}
            {(result?.resumeSkills ?? []).length > 0 && (
              <motion.div
                variants={itemVariants}
                className="rounded-xl border border-(--border) bg-(--panel) p-5 space-y-3"
              >
                <div className="font-mono text-xs uppercase tracking-widest text-(--muted-2)">
                  All skills detected in your resume
                </div>
                <div className="flex flex-wrap gap-2">
                  {(result?.resumeSkills ?? []).map((skill) => (
                    <span
                      key={skill}
                      className="inline-flex items-center px-2.5 py-1 rounded-full border border-(--border) bg-(--surface-2) text-(--muted) font-mono text-[11px]"
                    >
                      {displayName(skill)}
                    </span>
                  ))}
                </div>
                <p className="font-mono text-[10px] text-(--muted-2) leading-relaxed">
                  Only skills from our market taxonomy are detected. The comparison is
                  against the top <Num>{totalConsidered}</Num> by current job-posting demand.
                </p>
              </motion.div>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </main>
  );
}
