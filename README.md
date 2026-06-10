<div align="center">

# ⚡ Klar

### What developers *actually* get hired for.

Klar reads the developer job market in real time and tells you which skills companies are genuinely hiring for — straight from live job postings. No influencer hot takes. No "you must learn X" threads. No predictions. **Just the data.**

![MongoDB](https://img.shields.io/badge/MongoDB-47A248?style=flat-square&logo=mongodb&logoColor=white)
![Express](https://img.shields.io/badge/Express-000000?style=flat-square&logo=express&logoColor=white)
![React](https://img.shields.io/badge/React-20232A?style=flat-square&logo=react&logoColor=61DAFB)
![Node.js](https://img.shields.io/badge/Node.js-339933?style=flat-square&logo=nodedotjs&logoColor=white)
![Tailwind CSS](https://img.shields.io/badge/Tailwind-06B6D4?style=flat-square&logo=tailwindcss&logoColor=white)
![Clerk](https://img.shields.io/badge/Auth-Clerk-6C47FF?style=flat-square&logo=clerk&logoColor=white)
![Vite](https://img.shields.io/badge/Vite-646CFF?style=flat-square&logo=vite&logoColor=white)
![PRs Welcome](https://img.shields.io/badge/PRs-welcome-EB0029?style=flat-square)

### 👉 [**Try Klar live — no setup**](https://klar-dev.onrender.com)

**[🐙 Repo](https://github.com/shaiksohelll/Klar)** · **[🐛 Report Bug](https://github.com/shaiksohelll/Klar/issues)** · **[✨ Request Feature](https://github.com/shaiksohelll/Klar/issues)**

</div>

---

> Everyone tells you what to learn. Almost nobody shows you the evidence.
> **Klar is the evidence.**

---

## Table of Contents

- [The Why](#the-why)
- [The Problem](#the-problem)
- [What Klar Does](#what-klar-does)
- [Built Different](#built-different)
- [Under the Hood](#under-the-hood)
- [Tech Stack](#tech-stack)
- [Run It Locally](#run-it-locally)
- [Roadmap](#roadmap)
- [Contributing](#contributing)
- [The Person Behind Klar](#the-person-behind-klar)
- [License](#license)

---

## The Why

I taught myself to code from a tier-3 college with a slow connection and a tight budget. The hardest part was never the syntax — it was the **noise**. Every day, a new thread told me to learn a different language, framework, or "must-have" skill. Roadmaps contradicted each other. Influencers sold urgency. None of them showed me a single shred of proof.

So I asked a simple question: *what are companies actually hiring for, right now?*

Not opinions. Not a 12-month-old survey. Not someone's personal roadmap. **Live, current, verifiable demand.**

That question became Klar.

## The Problem

Developers — especially students and early-career engineers without insider networks — make high-stakes learning decisions based on **vibes**:

- Job boards show you listings to *apply* to, not *patterns* across the market.
- "Roadmaps" and influencer content are opinion, often months or years behind reality.
- Annual developer surveys are self-reported and stale the day they ship.

The result: people spend months learning the wrong things while the market quietly moves on.

**Klar fixes the information asymmetry.** It turns thousands of live job postings into a clear, honest picture of demand — so your effort goes where the market actually is.

## What Klar Does

- 📊 **Skill Demand Rankings** — the most-requested skills right now, ranked by real posting counts, filterable by role (Frontend, Backend, Full-stack, DevOps, Data, Mobile).
- 🔎 **Skill Search** — type any skill and instantly see how the market values it.
- 🧠 **Rich Skill Drawer** — for any skill: live demand, remote share, the skills it most often appears *alongside* (co-occurrence), and **disclosed salary insights**.
- 💰 **Salary Insights (disclosed-only)** — real, employer-disclosed pay — never predicted or estimated — with full transparency on *how many* postings actually disclosed it.
- 🏢 **Who's Hiring** — top companies ranked by active openings, the skills each one asks for most, and their remote share.
- 🎯 **Skill-Gap Advisor** — compare your skill set against live market demand and see exactly where your gaps are.
- ⭐ **Watchlist** — save the skills you're tracking (secured with real authentication).
- 🔄 **Daily Auto-Refresh** — the dataset rebuilds itself on a schedule, so what you see is current.

Every number on Klar traces back to a real, active job posting. **Descriptive, never predictive.**

## Built Different

|                              | Job boards | Roadmaps / influencers | Annual surveys | **Klar** |
| ---------------------------- | :--------: | :--------------------: | :------------: | :------: |
| Source of truth              | Listings to apply | Opinion          | Self-reported  | **Live listings, analyzed** |
| Tells you *what's in demand* |     ❌     |     ⚠️ subjective      |   ⚠️ stale     |    ✅    |
| Real-time                    |  partial   |          ❌            |       ❌       | ✅ daily refresh |
| Hype / predictions           |     —      |     ❌ heavy           |       —        | ✅ none — facts only |
| Salary honesty               |   hidden   |          ❌            |   aggregated   | ✅ disclosed-only + transparency |

Klar isn't another job board. It's a **lens** on the market that no listing site gives you.

## Under the Hood

Klar ingests postings from two independent live sources, normalizes and de-duplicates them, extracts skills against a curated taxonomy, and serves fast aggregated insights through a cached API.

    Live Job Sources                  Klar Engine                      Client
    ┌──────────────┐    ingest   ┌──────────────────────────┐   API  ┌─────────────┐
    │   Adzuna     │ ──────────▶ │  Normalize roles          │ ─────▶ │   React     │
    │              │             │  Extract skills (taxonomy)│        │   Tailwind  │
    │  Google for  │             │  Cross-source dedupe      │        │   + Framer  │
    │  Jobs (JSearch)│ ────────▶ │  (company + title + city) │        │   Motion    │
    └──────────────┘             │  Aggregate → Cache (6h)   │        └─────────────┘
                                 └──────────────────────────┘

**Engineering highlights:**

- 🧩 **Cross-source de-duplication** — the same role often appears on multiple platforms. A normalized `company + title + city` key collapses true duplicates while preserving genuinely distinct openings, so counts stay honest.
- 🛰️ **Multi-source ingestion** — Adzuna + Google for Jobs (via JSearch), each behind its own quota-aware, sequential fetch loop with backoff so free-tier limits are never blown.
- 🧠 **Skill taxonomy extraction** — a single shared taxonomy parses messy job descriptions into clean, comparable skills (and normalizes role titles into six canonical lenses).
- ⚡ **Aggregation + caching layer** — MongoDB aggregation pipelines power every chart, fronted by a 6-hour in-memory cache and a warm-up routine for snappy first loads.
- 🔐 **Production posture** — Clerk authentication, Helmet, CORS allow-listing, and per-route rate limiting out of the box.
- 🎨 **A UI that respects the data** — an OnePlus-inspired black-and-torch-red system, spring-physics motion, and tactile 3D-tilt cards that make raw numbers feel alive.

## Tech Stack

| Layer        | Technology |
| ------------ | ---------- |
| Frontend     | React, Vite, Tailwind CSS v4, Framer Motion |
| Backend      | Node.js, Express |
| Database     | MongoDB (Atlas) + Mongoose |
| Auth         | Clerk |
| Data sources | Adzuna API, Google for Jobs (JSearch) |
| Infra        | Render (web + API), cron-based scheduled ingestion |

## Run It Locally

**You don't need to.** Klar is live and always current: **https://klar-dev.onrender.com**

But if you want to contribute or fork it:

<details>
<summary><b>Local setup for contributors</b></summary>

**Prerequisites:** Node.js 18+, a MongoDB URI, and free API keys from Adzuna + RapidAPI (JSearch).

    git clone https://github.com/shaiksohelll/Klar.git
    cd Klar

Create `Server/.env` and `Client/.env` (see `.env.example` for the full list of variables), then:

    cd Server && npm install && npm run dev
    cd ../Client && npm install && npm run dev

Trigger one ingest to seed data (use your own secret), then open `http://localhost:5173`:

    curl -X POST http://localhost:5000/api/ingest/adzuna -H "X-Ingest-Secret: your_secret"

> ⚠️ Never commit your `.env` files or real keys — keep `.env` in `.gitignore`.

</details>

## Roadmap

- [x] Live multi-source ingestion (Adzuna + Google for Jobs)
- [x] Cross-source de-duplication
- [x] Skill demand rankings + role lenses
- [x] Rich skill drawer (demand, remote, co-occurrence)
- [x] Who's Hiring leaderboard
- [x] Skill-Gap Advisor
- [x] Disclosed-only salary insights
- [ ] Skill velocity badges (🔥 rising / ▼ cooling)
- [ ] More legal sources (Jooble, Remotive, Himalayas)
- [ ] Salary by experience level & region
- [ ] CI pipeline + test coverage
- [ ] Public, documented API

## Contributing

Klar is built in the open. If this resonates with you:

- ⭐ **Star the repo** — it genuinely helps more people find honest market data.
- 🐛 **Open an issue** for bugs or ideas.
- 🔧 **Have an improvement?** New data sources, a better skill taxonomy, and UI polish are especially welcome — open an issue first so we can chat.

## The Person Behind Klar

Klar was designed, built, and shipped solo by **Sohel** — [@shaiksohelll](https://github.com/shaiksohelll).

I'm 21, and I graduated from a tier-3 engineering college. No elite network, no Silicon Valley internship, no mentor handing me a roadmap — just a laptop, a patchy internet connection, and a stubborn refusal to believe that where you start has to decide where you finish.

I built Klar because I needed it. As a self-taught developer, I was tired of guessing what to learn next while everyone shouted different answers. So instead of asking louder voices, I went to the source: the job market itself. Every aggregation pipeline, every dedupe edge case, every 2 a.m. "why is this returning an empty array" — I learned it by building it, one failure at a time.

If you're reading this from a small town, a tier-3 college, or a tight budget: **this repo is proof that the gate was never as locked as they told you.** Build the thing you wish existed. I did.

- 🐙 GitHub: [@shaiksohelll](https://github.com/shaiksohelll)

## License

Klar doesn't carry an open-source license yet — for now, **all rights reserved**. Want to use or build on it? Open an issue or reach out and let's talk.

---

<div align="center">

**If Klar helped you see the market clearly, drop a ⭐ — it means the world to a solo builder.**

*Built with sheer determination, one commit at a time.*

</div>
