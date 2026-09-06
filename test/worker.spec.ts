import { SELF, env, runDurableObjectAlarm } from "cloudflare:test";
import { describe, expect, it } from "vitest";

const csv = [
  "id,interview,comment",
  "a1,阿德,我家離核二廠不到五公里，演習從來沒真的演過怎麼撤。",
  "a2,Vivian,去年廠區兩次跳電，基載電力不能只靠天然氣船準時到港。",
  "a3,淑芬,魚塭被光電板圍住之後，我們沒有比較乾淨，只有比較窮。",
  "a4,小魚,核廢料到現在連中期貯存場都選不出來。",
  "a5,老陳,工業電價三年漲了快五成，核電便宜又穩。",
  "a6,,1982 年他們跟我們的長輩說那是罐頭工廠。",
  "",
].join("\n");

async function create(body: Record<string, unknown>) {
  const response = await SELF.fetch("https://example.com/api/reports", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as Record<string, any> };
}

async function runUntilReady(reportId: string) {
  const stub = env.REPORT.get(env.REPORT.idFromName(reportId));
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const ran = await runDurableObjectAlarm(stub);
    const report = (await (await SELF.fetch(`https://example.com/api/reports/${reportId}`)).json()) as Record<string, any>;
    if (report.progress.status === "ready") return report;
    if (!ran && report.progress.status !== "ready") {
      // alarm 尚未到期：等它到期後再跑
      await new Promise((resolve) => setTimeout(resolve, 600));
    }
  }
  throw new Error("report did not become ready");
}

describe("Pocket TTTC worker", () => {
  it("serves health, the create page and the report shell", async () => {
    const health = (await (await SELF.fetch("https://example.com/api/health")).json()) as Record<string, any>;
    expect(health.ok).toBe(true);
    expect(health.aiMode).toBe("fake");
    expect(health.maxRows).toBe(50);
    expect((await SELF.fetch("https://example.com/api/reports/zzzzzzzzzz")).status).toBe(404);
    expect((await SELF.fetch("https://example.com/api/nope")).status).toBe(404);
  });

  it("rejects bad input before touching the rate limit", async () => {
    expect((await create({ title: "x", csv, confirmed: true })).status).toBe(201);
    expect((await create({ title: "", csv, confirmed: true })).status).toBe(400);
    expect((await create({ title: "x", csv: "statement_id,text\n1,a\n", confirmed: true })).status).toBe(400);
    expect((await create({ title: "x", csv, confirmed: false })).status).toBe(400);
    const tooMany = `id,comment\n${Array.from({ length: 51 }, (_, index) => `${index},c${index}`).join("\n")}\n`;
    expect((await create({ title: "x", csv: tooMany, confirmed: true })).body.error).toContain("最多 50 則");
  });

  it("runs the four-step pipeline on alarms and publishes a topic tree", async () => {
    const created = await create({ title: "核電審議發言", description: "測試", language: "zh-Hant", csv, confirmed: true });
    expect(created.status).toBe(201);
    expect(created.body.urls.report).toBe(`https://example.com/r/${created.body.reportId}`);
    expect(created.body.urls.manage).toContain(`#admin=${created.body.adminToken}`);
    const queued = (await (await SELF.fetch(created.body.urls.api)).json()) as Record<string, any>;
    expect(queued.progress.status).toBe("queued");
    expect(queued.tree).toBeNull();

    const report = await runUntilReady(created.body.reportId);
    expect(report.model).toBe("fake");
    expect(report.tree.stats.comments).toBe(6);
    expect(report.tree.stats.people).toBe(6);
    expect(report.tree.stats.claims).toBe(6);
    expect(report.tree.topics.map((topic: any) => topic.name)).toEqual(["供電與成本", "風險與核廢"]);
    const first = report.tree.topics[0];
    expect(first.summary).toContain("關切");
    expect(first.subtopics.length).toBeGreaterThan(0);
    const claim = first.subtopics[0].claims[0];
    expect(claim.quotes.length).toBeGreaterThan(0);
    expect(claim.people).toBeGreaterThan(0);
    expect(report.progress.neuronsReserved).toBeGreaterThan(0);

    const json = await SELF.fetch(`${created.body.urls.api}/report.json`);
    expect(json.status).toBe(200);
    expect(((await json.json()) as Record<string, any>).topics).toHaveLength(2);
    const claimsCsv = await SELF.fetch(`${created.body.urls.api}/claims.csv`);
    expect(claimsCsv.status).toBe(200);
    expect(claimsCsv.headers.get("content-type")).toContain("text/csv");
    const lines = (await claimsCsv.text()).trimEnd().split("\n");
    expect(lines[0]).toBe("topic,subtopic,claim,people,quote,interview,comment_id");
    expect(lines).toHaveLength(7);

    const page = await SELF.fetch(created.body.urls.report, { redirect: "manual" });
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("Pocket TTTC");
    const canvas = await SELF.fetch(`${created.body.urls.report}/canvas`, { redirect: "manual" });
    expect(canvas.status).toBe(200);
    expect(await canvas.text()).toContain("議題畫布");
  });

  it("only the admin token can retry or delete, and deleted reports answer 410", async () => {
    const created = await create({ title: "刪除測試", csv, confirmed: true });
    const api = created.body.urls.api as string;
    expect((await SELF.fetch(api, { method: "DELETE" })).status).toBe(401);
    expect((await SELF.fetch(api, { method: "DELETE", headers: { "X-Report-Admin": "0".repeat(32) } })).status).toBe(403);
    expect((await SELF.fetch(`${api}/retry`, { method: "POST", headers: { "X-Report-Admin": created.body.adminToken } })).status).toBe(200);
    const deleted = await SELF.fetch(api, { method: "DELETE", headers: { "X-Report-Admin": created.body.adminToken } });
    expect(deleted.status).toBe(200);
    expect((await SELF.fetch(api)).status).toBe(410);
  });

  it("enforces the deployment-wide creation limit", async () => {
    const coordinator = env.COORDINATOR.get(env.COORDINATOR.idFromName("app"));
    let allowed = 0;
    for (let attempt = 0; attempt < 12; attempt += 1) if (await coordinator.reserveCreation()) allowed += 1;
    expect(allowed).toBeLessThanOrEqual(10);
    expect(await coordinator.dailyRemaining()).toBeLessThanOrEqual(9_000);
  });
});
