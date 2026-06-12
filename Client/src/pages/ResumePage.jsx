import { useState, useRef, useCallback } from "react";
import axios from "axios";
import { motion, AnimatePresence } from "framer-motion";
import { useOutletContext } from "react-router-dom";
import { extractTextFromFile } from "../lib/parseResume";
import { displayName } from "../lib/displayName";

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
      className="rotate-[-90deg]"
      aria-hidden="true"
    >
      <circle
        cx="50"
        cy="50"
        r={DIAL_R}
        fill="none"
        stroke="#26262E"
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

  const fileInputRef = useRef(null);
  const reqIdRef = useRef(0);
  const parseIdRef = useRef(0);

  // ── File handling ──────────────────────────────────────────────────────────

  const processFile = useCallback(async (file) => {
    const myParseId = ++parseIdRef.current;
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
    const trimmed = text.trim();
    if (!trimmed) {
      setResult(null);
      setApiError("Paste your résumé text or upload a file first.");
      return;
    }
    const payload = trimmed.slice(0, MAX_CHARS);
    setLoading(true);
    setApiError(null);
    setResult(null);
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
  };

  // ── Chip click → SkillDrawer ───────────────────────────────────────────────
  const openSkill = (skill, count) => {
    setSelectedSkill({ id: skill, name: skill, count, role: "General" });
  };

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <main className="max-w-3xl mx-auto px-4 md:px-6 mt-16 md:mt-24 pb-32 space-y-12 relative z-10">

      {/* ── Hero ─────────────────────────────────────────────────────────── */}
      <section className="text-center max-w-2xl mx-auto space-y-5">
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          className="font-mono text-[#EB0029] text-xs uppercase tracking-[0.2em] font-bold"
        >
          Résumé Gap Analysis
        </motion.div>
        <motion.h1
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.1, duration: 0.6, ease: EASE }}
          className="font-space font-bold text-5xl md:text-6xl leading-[1.05] tracking-tight text-white"
        >
          See exactly what{" "}
          <span className="text-[#EB0029] italic">you&apos;re missing.</span>
        </motion.h1>
        <motion.p
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.2, duration: 0.6, ease: EASE }}
          className="text-lg text-[#9A9AA6] font-medium"
        >
          Paste your résumé or upload a file. We compare it against the current top-40
          in-demand skills from live job postings — no AI, no estimates.
        </motion.p>
      </section>

      {/* ── Input card ───────────────────────────────────────────────────── */}
      <motion.div
        initial={{ opacity: 0, y: 24 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.3, duration: 0.6, ease: EASE }}
        className="rounded-2xl border border-[#26262E] bg-[#0A0A0E] p-6 md:p-8 space-y-5"
      >
        {/* Drag-and-drop zone */}
        <div
          role="button"
          tabIndex={0}
          aria-label="Upload résumé file"
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
          className={`relative flex flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed py-8 px-4 cursor-pointer transition-colors focus:outline-none focus-visible:border-[#EB0029] focus-visible:ring-2 focus-visible:ring-[#EB0029] ${
            isDragging
              ? "border-[#EB0029] bg-[#EB0029]/5"
              : "border-[#26262E] hover:border-[#5C5C66]"
          }`}
        >
          <input
            ref={fileInputRef}
            type="file"
            accept=".pdf,.docx,.txt"
            className="sr-only"
            onChange={handleFileChange}
            id="resume-file-input"
            aria-label="Upload résumé file"
          />
          <div className="text-3xl select-none">📄</div>
          <div className="text-center">
            <p className="text-sm text-[#F4F4F6] font-medium">
              {fileName ? (
                <span className="text-[#EB0029]">{fileName}</span>
              ) : (
                <>
                  <span className="text-[#EB0029]">Click to upload</span> or drag &amp; drop
                </>
              )}
            </p>
            <p className="font-mono text-xs text-[#5C5C66] mt-1">
              PDF, DOCX, or TXT
            </p>
          </div>
        </div>

        {parseError && (
          <p className="font-mono text-xs text-[#EB0029]" role="alert">
            {parseError}
          </p>
        )}

        {/* Divider */}
        <div className="flex items-center gap-3">
          <div className="flex-1 h-px bg-[#26262E]" />
          <span className="font-mono text-xs text-[#5C5C66] uppercase tracking-widest">or paste text</span>
          <div className="flex-1 h-px bg-[#26262E]" />
        </div>

        {/* Textarea */}
        <div className="relative">
          <textarea
            id="resume-textarea"
            value={text}
            onChange={(e) => {
              parseIdRef.current++;
              setText(e.target.value);
              setFileName(null);
              setParseError(null);
              setResult(null);
              setApiError(null);
            }}
            rows={10}
            maxLength={MAX_CHARS}
            placeholder="Paste your résumé here…"
            className="w-full rounded-xl bg-[#08080A] border border-[#26262E] focus:border-[#EB0029] focus:outline-none text-[#F4F4F6] placeholder-[#5C5C66] text-sm p-4 resize-y transition-colors font-mono leading-relaxed"
            aria-label="Résumé text"
          />
          <div className="absolute bottom-3 right-3 font-mono text-[10px] text-[#5C5C66]">
            {text.length.toLocaleString()} / {MAX_CHARS.toLocaleString()}
          </div>
        </div>

        {text.trim().length > MAX_CHARS && (
          <p className="font-mono text-[10px] text-[#5C5C66]">
            Only the first 50,000 characters were analyzed.
          </p>
        )}

        {/* Action buttons */}
        <div className="flex items-center gap-3">
          <button
            onClick={handleAnalyze}
            disabled={loading}
            className="flex-1 py-4 rounded-xl bg-[#EB0029] hover:bg-[#FF2740] disabled:opacity-50 disabled:cursor-not-allowed text-white font-mono text-sm uppercase tracking-widest font-medium transition-all shadow-[0_0_20px_rgba(235,0,41,0.2)] hover:shadow-[0_0_30px_rgba(255,39,64,0.4)] hover:-translate-y-0.5"
            aria-busy={loading}
          >
            {loading ? (
              <span className="flex items-center justify-center gap-2">
                <motion.span
                  animate={{ rotate: 360 }}
                  transition={{ duration: 1, repeat: Infinity, ease: "linear" }}
                  className="inline-block w-4 h-4 border-2 border-white border-t-transparent rounded-full"
                />
                Analyzing…
              </span>
            ) : (
              "Analyze Résumé"
            )}
          </button>
          {(text || result) && (
            <button
              onClick={handleClear}
              className="px-5 py-4 rounded-xl border border-[#26262E] text-[#9A9AA6] hover:text-white hover:border-[#5C5C66] font-mono text-sm uppercase tracking-widest transition-colors"
            >
              Clear
            </button>
          )}
        </div>

        {apiError && (
          <p className="font-mono text-xs text-[#EB0029]" role="alert">
            {apiError}
          </p>
        )}
      </motion.div>

      {/* ── Results ──────────────────────────────────────────────────────── */}
      <AnimatePresence>
        {result && (
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
              className="rounded-2xl border border-[#26262E] bg-[#0A0A0E] p-6 md:p-8"
            >
              <div className="flex flex-col sm:flex-row items-center gap-8">
                {/* Score dial */}
                <div className="relative shrink-0 flex items-center justify-center">
                  <ScoreDial score={result?.matchScore ?? 0} />
                  <div className="absolute inset-0 flex flex-col items-center justify-center">
                    <span className="font-space font-bold text-3xl text-white leading-none">
                      {result?.matchScore ?? 0}
                    </span>
                    <span className="font-mono text-[10px] text-[#5C5C66] uppercase tracking-widest mt-0.5">
                      %
                    </span>
                  </div>
                </div>

                {/* Copy */}
                <div className="text-center sm:text-left space-y-2">
                  <div className="font-mono text-xs uppercase tracking-widest text-[#EB0029]">
                    Match Score
                  </div>
                  <p className="text-xl md:text-2xl font-space font-bold text-white leading-snug">
                    You cover{" "}
                    <span className="text-[#EB0029]">{(result?.matched ?? []).length}</span>{" "}
                    of the top{" "}
                    <span className="text-[#EB0029]">{result?.totalConsidered ?? 0}</span>{" "}
                    in-demand skills.
                  </p>
                  <p className="text-sm text-[#9A9AA6]">
                    {(result?.missing ?? []).length === 0
                      ? "You've got every skill in the top 40 — impressive."
                      : `${(result?.missing ?? []).length} skill${(result?.missing ?? []).length > 1 ? "s" : ""} from the market's top ${result?.totalConsidered ?? 0} are missing from your résumé.`}
                  </p>
                </div>
              </div>
            </motion.div>

            {/* Matched skills */}
            {(result?.matched ?? []).length > 0 && (
              <motion.div variants={itemVariants} className="space-y-4">
                <div className="flex items-center gap-3">
                  <span className="text-lg" aria-hidden="true">✅</span>
                  <div>
                    <div className="font-mono text-xs uppercase tracking-widest text-[#5C5C66]">
                      Skills you have that the market wants
                    </div>
                    <div className="font-mono text-[10px] text-[#5C5C66] mt-0.5">
                      {(result?.matched ?? []).length} skill{(result?.matched ?? []).length !== 1 ? "s" : ""} matched
                    </div>
                  </div>
                </div>
                <div className="flex flex-wrap gap-2">
                  {(result?.matched ?? []).map(({ skill, count }) => (
                    <motion.span
                      key={skill}
                      layout
                      transition={UI_SPRING}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full border border-[#26262E] bg-[#0E1A12] text-[#22c55e] font-mono text-xs"
                    >
                      {displayName(skill)}
                      <span className="text-[#166534] text-[10px]">{count}</span>
                    </motion.span>
                  ))}
                </div>
              </motion.div>
            )}

            {/* Missing skills */}
            {(result?.missing ?? []).length > 0 && (
              <motion.div variants={itemVariants} className="space-y-4">
                <div className="flex items-center gap-3">
                  <span className="text-lg" aria-hidden="true">🔴</span>
                  <div>
                    <div className="font-mono text-xs uppercase tracking-widest text-[#5C5C66]">
                      In-demand skills you&apos;re missing
                    </div>
                    <div className="font-mono text-[10px] text-[#5C5C66] mt-0.5">
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
                      onClick={() => openSkill(skill, count)}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full border border-[#26262E] bg-[#0A0A0E] text-[#9A9AA6] hover:text-white hover:border-[#EB0029] hover:bg-[#1A0508] font-mono text-xs transition-colors cursor-pointer"
                    >
                      {displayName(skill)}
                      <span className="text-[#5C5C66] text-[10px]">{count}</span>
                    </motion.button>
                  ))}
                </div>
              </motion.div>
            )}

            {/* Résumé skills detected (secondary context) */}
            {(result?.resumeSkills ?? []).length > 0 && (
              <motion.div
                variants={itemVariants}
                className="rounded-xl border border-[#26262E] bg-[#0A0A0E] p-5 space-y-3"
              >
                <div className="font-mono text-xs uppercase tracking-widest text-[#5C5C66]">
                  All skills detected in your résumé
                </div>
                <div className="flex flex-wrap gap-2">
                  {(result?.resumeSkills ?? []).map((skill) => (
                    <span
                      key={skill}
                      className="inline-flex items-center px-2.5 py-1 rounded-full border border-[#26262E] bg-[#121216] text-[#9A9AA6] font-mono text-[11px]"
                    >
                      {displayName(skill)}
                    </span>
                  ))}
                </div>
                <p className="font-mono text-[10px] text-[#5C5C66] leading-relaxed">
                  Only skills from our market taxonomy are detected. The comparison is
                  against the top {result?.totalConsidered ?? 0} by current job-posting demand.
                </p>
              </motion.div>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </main>
  );
}
