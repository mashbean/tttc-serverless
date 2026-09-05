// 唯讀煙霧測試：不建立報告、不呼叫模型。用法：node scripts/smoke.mjs https://your-worker.example
const base = (process.argv[2] || "http://127.0.0.1:8787").replace(/\/$/, "");
const checks = [];
const check = (name, ok, detail = "") => checks.push({ name, ok, detail });

const health = await fetch(`${base}/api/health`);
const healthBody = await health.json().catch(() => null);
check("GET /api/health", health.status === 200 && healthBody?.ok === true, `status ${health.status}`);
check("health reports the row cap and remaining neurons", Number.isFinite(healthBody?.maxRows) && Number.isFinite(healthBody?.dailyNeuronsRemaining));

const home = await fetch(`${base}/`);
check("GET / serves the create page", home.status === 200 && (await home.text()).includes("口袋議題樹"));

const unknown = await fetch(`${base}/api/reports/zzzzzzzzzz`);
check("GET /api/reports/<unknown> is a JSON 404", unknown.status === 404);

const page = await fetch(`${base}/r/zzzzzzzzzz`);
check("GET /r/<unknown> renders the report shell", page.status === 200);

const rejected = await fetch(`${base}/api/reports`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "x", csv: "id,comment\n1,hello\n" }) });
check("POST /api/reports without confirmation is rejected", rejected.status === 400);

for (const item of checks) console.log(`${item.ok ? "✓" : "✗"} ${item.name}${item.ok || !item.detail ? "" : ` — ${item.detail}`}`);
const failed = checks.filter((item) => !item.ok).length;
console.log(`\n${checks.length - failed} passed, ${failed} failed against ${base}`);
process.exit(failed > 0 ? 1 : 0);
