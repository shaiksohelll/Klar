import { useEffect, useState } from "react"
import axios from "axios"
import {
	BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid,
} from "recharts"
import "./App.css"

const API = "http://localhost:5000"
const chartMargin = { top: 8, right: 16, bottom: 8, left: 0 }
const axisTick = { fontSize: 12, fill: "#6b7280" }
const tooltipCursor = { fill: "rgba(109, 40, 217, 0.06)" }

const ROLES = [
	{ value: "all", label: "All roles" },
	{ value: "backend", label: "Backend" },
	{ value: "frontend", label: "Frontend" },
	{ value: "fullstack", label: "Full-stack" },
	{ value: "devops", label: "DevOps" },
	{ value: "data", label: "Data" },
	{ value: "mobile", label: "Mobile" },
]

export default function App() {
	const [skills, setSkills] = useState([])
	const [totalJobs, setTotalJobs] = useState(0)
	const [role, setRole] = useState("all")
	const [loading, setLoading] = useState(true)
	const [error, setError] = useState("")

	useEffect(() => {
		setLoading(true)
		setError("")

		const params = {}
		if (role !== "all") params.role = role

		axios
			.get(`${API}/api/skills/trending`, { params })
			.then((res) => {
				setSkills(res.data.skills || [])
				setTotalJobs(res.data.totalJobs || 0)
			})
			.catch((err) => setError(err.message))
			.finally(() => setLoading(false))
	}, [role])

	const top = skills.slice(0, 12)
	const maxDemand = skills.length ? skills[0].demand : 1

	return (
		<div className="app">
			<header className="hero">
				<div className="hero-inner">
					<div className="brand">
						<span className="brand-dot" />
						<h1 className="brand-name">Klar</h1>
					</div>
					<p className="tagline">
						A clear read on which dev skills are actually in demand — not just hype.
					</p>
				</div>
			</header>

			<main className="container">
				<div className="toolbar">
					<div className="stat">
						<span className="stat-num">{totalJobs}</span>
						<span className="stat-label">jobs analyzed</span>
					</div>
					<div className="filter">
						<label htmlFor="role">Role</label>
						<select
							id="role"
							value={role}
							onChange={(e) => setRole(e.target.value)}
							className="role-select"
						>
							{ROLES.map((r) => (
								<option key={r.value} value={r.value}>
									{r.label}
								</option>
							))}
						</select>
					</div>
				</div>

				{loading && <div className="state">Loading…</div>}
				{error && <div className="state error">⚠️ {error}</div>}

				{!loading && !error && skills.length === 0 && (
					<div className="state">No jobs found for this role yet.</div>
				)}

				{!loading && !error && skills.length > 0 && (
					<>
						<section className="card">
							<h2 className="card-title">Top skills by demand</h2>
							<div className="chart">
								<ResponsiveContainer>
									<BarChart data={top} margin={chartMargin}>
										<CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#eeeeee" />
										<XAxis
											dataKey="skill"
											angle={-30}
											textAnchor="end"
											height={70}
											interval={0}
											tick={axisTick}
										/>
										<YAxis allowDecimals={false} tick={axisTick} />
										<Tooltip cursor={tooltipCursor} isAnimationActive={false} />
										<Bar dataKey="demand" fill="#7c3aed" radius={[6, 6, 0, 0]} />
									</BarChart>
								</ResponsiveContainer>
							</div>
						</section>

						<section className="card">
							<h2 className="card-title">Full ranking</h2>
							<table className="ranking">
								<thead>
									<tr>
										<th className="col-rank">#</th>
										<th>Skill</th>
										<th>Demand</th>
										<th className="col-remote">Remote</th>
									</tr>
								</thead>
								<tbody>
									{skills.map((s, i) => {
										const barWidth = { width: `${(s.demand / maxDemand) * 100}%` }
										return (
											<tr key={s.skill}>
												<td className="col-rank">{i + 1}</td>
												<td className="skill-name">{s.skill}</td>
												<td>
													<div className="demand">
														<span className="bar-track">
															<span className="bar-fill" style={barWidth} />
														</span>
														<span className="demand-num">{s.demand}</span>
													</div>
												</td>
												<td className="col-remote">{s.remoteCount}</td>
											</tr>
										)
									})}
								</tbody>
							</table>
						</section>
					</>
				)}
			</main>

			<footer className="footer">
				Data from Adzuna · Built with the MERN stack
			</footer>
		</div>
	)
}