import Brand from "../components/Brand";

const STEPS = [
  {
    n: "01",
    t: "Real postings",
    d: "We pull live job listings from Adzuna across seven engineering roles: frontend, backend, full-stack, DevOps, data, mobile, and general software.",
  },
  {
    n: "02",
    t: "Skill extraction",
    d: "Each posting is parsed for the concrete tools and technologies it asks for, then normalized so 'ReactJS' and 'React.js' count as the same skill.",
  },
  {
    n: "03",
    t: "Demand ranking",
    d: "We count how often each skill appears across active postings in your selected role and time window. That frequency is the demand signal.",
  },
  {
    n: "04",
    t: "Always fresh",
    d: "The dataset refreshes automatically every few hours and stale postings are pruned, so what you see reflects the current market, not last year's.",
  },
];

export default function AboutPage() {
  return (
    <main className="max-w-3xl mx-auto px-4 md:px-6 mt-16 md:mt-24 space-y-10 relative z-10">
      <section className="space-y-4">
        <div className="font-mono text-[#EB0029] text-xs uppercase tracking-[0.2em] font-bold">
          The Method
        </div>
        <h1 className="font-space font-bold text-4xl md:text-6xl leading-[1.05] tracking-tight text-white">
          How <Brand /> reads the market
        </h1>
        <p className="text-lg text-[#9A9AA6] font-medium">
          <Brand /> is descriptive, not predictive. We don't guess where the market
          is going. We show you what employers are hiring for right now.
        </p>
      </section>

      <section className="space-y-4">
        {STEPS.map((step) => (
          <div
            key={step.n}
            className="flex gap-5 border border-[#26262E] rounded-2xl p-6 bg-[#121216]/50"
          >
            <div className="font-mono text-[#EB0029] text-sm font-bold pt-1">
              {step.n}
            </div>
            <div className="space-y-1">
              <div className="font-space font-bold text-lg text-white">
                {step.t}
              </div>
              <div className="text-[#9A9AA6] text-sm leading-relaxed">
                {step.d}
              </div>
            </div>
          </div>
        ))}
      </section>

      <section className="border-t border-[#26262E] pt-6">
        <p className="font-mono text-xs text-[#5C5C66] uppercase tracking-wider leading-relaxed">
          A snapshot of current demand, not a prediction. Always verify against
          your own research before making career decisions.
        </p>
      </section>
    </main>
  );
}