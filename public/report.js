const reportId = (location.pathname.match(/^\/r\/([a-z0-9]{10})/) || [])[1];
const adminToken = (location.hash.match(/admin=([0-9a-f]{32})/) || [])[1] || "";
const el = (id) => document.getElementById(id);
const STATUS_TEXT = {
  queued: "排隊中",
  clustering: "第一步：提出主題與子主題",
  extracting: "第二步：從每則發言抽取主張",
  grouping: "第三步：合併相近的主張",
  summarizing: "第四步：撰寫主題摘要",
  "waiting-budget": "今日 Workers AI 額度已用完，等待隔天（UTC）自動續跑",
  failed: "處理失敗",
  deleted: "已刪除",
  ready: "完成",
};
let tree = null;
let timer = null;

if (!reportId) showError("網址不完整。");
else load();

async function load() {
  try {
    const response = await fetch(`/api/reports/${reportId}`, { cache: "no-store" });
    if (response.status === 404) return showError("找不到這份報告。");
    if (response.status === 410) return showError("這份報告已被刪除。");
    const report = await response.json();
    render(report);
  } catch (error) {
    showError(error instanceof Error ? error.message : "載入失敗。");
  }
}

function render(report) {
  document.title = `${report.title} · Pocket TTTC`;
  el("title").textContent = report.title;
  el("description").textContent = report.description;
  el("model").textContent = report.model === "fake" ? "測試模型" : report.model;
  el("kicker").textContent = `報告 · ${report.rows} 則發言 · ${new Date(report.createdAt).toLocaleDateString("zh-TW")}`;
  el("admin").classList.toggle("hidden", !adminToken);
  const progress = report.progress;
  if (progress.status === "ready" && report.tree) {
    clearInterval(timer);
    el("pending").classList.add("hidden");
    el("ready").classList.remove("hidden");
    tree = report.tree;
    renderTree(tree);
    el("download-json").href = `/api/reports/${reportId}/report.json`;
    el("download-csv").href = `/api/reports/${reportId}/claims.csv`;
    return;
  }
  el("pending").classList.remove("hidden");
  el("pending-title").textContent = STATUS_TEXT[progress.status] || progress.status;
  const ratio = progress.total > 0 ? Math.min(1, progress.done / progress.total) : 0;
  el("progress-bar").style.width = `${Math.round(ratio * 100)}%`;
  const steps = ["clustering", "extracting", "grouping", "summarizing"];
  const stepIndex = steps.indexOf(progress.step);
  el("pending-text").textContent = `${stepIndex >= 0 ? `第 ${stepIndex + 1} / 4 步` : ""}${progress.total ? ` · ${progress.done} / ${progress.total}` : ""} · 已預留 ${Math.round(progress.neuronsReserved)} 神經元${progress.nextAttemptAt ? ` · 下次嘗試 ${new Date(progress.nextAttemptAt).toLocaleString("zh-TW")}` : ""}`;
  el("pending-error").classList.toggle("hidden", !progress.lastError);
  el("pending-error").textContent = progress.lastError;
  el("admin-actions").classList.toggle("hidden", !(adminToken && (progress.status === "failed" || progress.status === "waiting-budget")));
  if (!timer && !["failed", "deleted"].includes(progress.status)) timer = setInterval(load, 4000);
  if (["failed", "deleted"].includes(progress.status)) clearInterval(timer);
}

function renderTree(data, filter = "") {
  const query = filter.trim().toLowerCase();
  const stats = [
    [data.stats.comments, "發言"],
    [data.stats.people, "發言者"],
    [data.stats.claims, "抽出的主張"],
    [data.stats.groupedClaims, "合併後的主張"],
    [data.topics.filter((topic) => topic.name !== "其他").length, "主題"],
  ];
  el("stats").replaceChildren(...stats.map(([value, label]) => {
    const node = document.createElement("div");
    node.className = "stat";
    const b = document.createElement("b");
    b.textContent = String(value);
    const span = document.createElement("span");
    span.textContent = label;
    node.append(b, span);
    return node;
  }));
  const matches = (claim) => !query || claim.text.toLowerCase().includes(query) || claim.quotes.some((quote) => quote.text.toLowerCase().includes(query) || quote.interview.toLowerCase().includes(query));
  el("toc").replaceChildren(...data.topics.map((topic, index) => {
    const link = document.createElement("a");
    link.href = `#topic-${index}`;
    link.textContent = `${topic.name}（${topic.people}）`;
    link.style.marginRight = ".8rem";
    return link;
  }));
  el("tree").replaceChildren(...data.topics.map((topic, index) => {
    const section = document.createElement("section");
    section.className = "topic";
    section.id = `topic-${index}`;
    const h2 = document.createElement("h2");
    h2.textContent = topic.name;
    const meta = document.createElement("p");
    meta.className = "meta";
    meta.textContent = `${topic.people} 位發言者 · ${topic.claimsCount} 句主張 · ${topic.subtopics.length} 個子主題`;
    section.append(h2, meta);
    if (topic.description) {
      const desc = document.createElement("p");
      desc.className = "meta";
      desc.textContent = topic.description;
      section.append(desc);
    }
    if (topic.summary) {
      const summary = document.createElement("p");
      summary.className = "summary";
      summary.textContent = topic.summary;
      section.append(summary);
    }
    for (const subtopic of topic.subtopics) {
      const claims = subtopic.claims.filter(matches);
      if (query && claims.length === 0) continue;
      const wrap = document.createElement("div");
      wrap.className = "subtopic";
      const h3 = document.createElement("h3");
      h3.textContent = `${subtopic.name}（${subtopic.people} 人）`;
      wrap.append(h3);
      if (subtopic.description) {
        const desc = document.createElement("p");
        desc.className = "desc";
        desc.textContent = subtopic.description;
        wrap.append(desc);
      }
      for (const claim of claims) {
        const details = document.createElement("details");
        details.className = "claim";
        details.open = Boolean(query);
        const summary = document.createElement("summary");
        const count = document.createElement("span");
        count.className = "count";
        count.textContent = `${claim.people} 人`;
        const text = document.createElement("span");
        text.textContent = claim.text;
        summary.append(count, text);
        details.append(summary);
        for (const quote of claim.quotes) {
          const block = document.createElement("blockquote");
          block.textContent = quote.text;
          const cite = document.createElement("cite");
          cite.textContent = quote.interview ? `${quote.interview} · ${quote.commentId}` : quote.commentId;
          block.append(cite);
          details.append(block);
        }
        wrap.append(details);
      }
      section.append(wrap);
    }
    return section;
  }));
}

el("filter").addEventListener("input", (event) => {
  if (tree) renderTree(tree, event.target.value);
});

el("retry").addEventListener("click", async () => {
  const response = await fetch(`/api/reports/${reportId}/retry`, { method: "POST", headers: { "X-Report-Admin": adminToken } });
  el("pending-text").textContent = response.ok ? "已重新排程。" : `無法重新排程（${response.status}）`;
  setTimeout(load, 1500);
});

el("delete").addEventListener("click", async () => {
  if (!confirm("確定要刪除整份報告？輸入的發言、主張與議題樹都會清除，無法復原。")) return;
  const response = await fetch(`/api/reports/${reportId}`, { method: "DELETE", headers: { "X-Report-Admin": adminToken } });
  el("admin-status").textContent = response.ok ? "已刪除。" : `刪除失敗（${response.status}）`;
  if (response.ok) setTimeout(load, 800);
});

function showError(message) {
  clearInterval(timer);
  el("error").textContent = message;
  el("error").classList.remove("hidden");
  el("title").textContent = "無法顯示報告";
}
