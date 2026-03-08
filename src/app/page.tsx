export default function Home() {
  return (
    <main style={{ fontFamily: "sans-serif", padding: "2rem" }}>
      <h1>Recover API</h1>
      <p>Backend is running. Available endpoints:</p>
      <ul>
        <li><code>POST /api/analyze-injury</code> — Upload injury photo for AI analysis</li>
        <li><code>POST /api/analyze-video</code> — Upload exercise video for form feedback</li>
        <li><code>POST /api/send-reminder</code> — Send recovery reminder email</li>
        <li><code>GET /api/get-profile?userId=&lt;id&gt;</code> — Get user injury profiles</li>
      </ul>
    </main>
  );
}
