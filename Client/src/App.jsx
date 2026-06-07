import { useEffect, useState } from "react"
import axios from "axios"
import {
	BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid,
} from "recharts"
import "./App.css"

const API = "http://localhost:5000"
const chartMargin = { top: 8, right: 16, bottom: 8, left: 0 }

export default function App() {
	const [skills, setSkills] = useState([])
	const [totalJobs, setTotalJobs] = useState(0)
	const [loading, setLoading] = useState(true)
	const [error, setError] = useState("")

	useEffect(() => {
		axios
			.get(`${API}/api/skills/trending`)
			.then((res) => {
				setSkills(res.data.skills || [])
				setTotalJobs(res.data.totalJobs || 0)
			})
			.catch((err) => setError(err.message))
			.finally(() => setLoading(false))
	}, [])

	if (loading) return <p className="state">Loading…</p>
	if (error) return <p className="state error">Error: {error}</p>

	const top = skills.slice(0, 12)

	return (
		<div className="page">
			<h1 className="title">Klar</h1>
			<p className="subtitle">
				A clear read on which dev skills are actually in demand. Analyzed{" "}
				<strong>{totalJobs}</strong> job postings.
			</p>

			<h2>Top skills by demand</h2>
			<div className="chart">
				<ResponsiveContainer>
					<BarChart data={top} margin={chartMargin}>
						<CartesianGrid strokeDasharray="3 3" />
						<XAxis dataKey="skill" angle={-30} textAnchor="end" height={70} interval={0} />
						<YAxis allowDecimals={false} />
						<Tooltip />
						<Bar dataKey="demand" fill="#6d28d9" radius={[4, 4, 0, 0]} />
					</BarChart>
				</ResponsiveContainer>
			</div>

			<h2>Full ranking</h2>
			<table className="ranking">
				<thead>
					<tr>
						<th>#</th>
						<th>Skill</th>
						<th>Demand</th>
						<th>Remote roles</th>
					</tr>
				</thead>
				<tbody>
					{skills.map((s, i) => (
						<tr key={s.skill}>
							<td>{i + 1}</td>
							<td>{s.skill}</td>
							<td>{s.demand}</td>
							<td>{s.remoteCount}</td>
						</tr>
					))}
				</tbody>
			</table>
		</div>
	)
}