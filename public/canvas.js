// 議題畫布：report.json → 放射狀 SVG。主題＝扇區、子主題＝輻條、主張＝節點（大小＝人數）。純前端，無外部函式庫。
const reportId = (location.pathname.match(/^\/r\/([a-z0-9]{10})\/canvas/) || [])[1];
const el = (id) => document.getElementById(id);
const NS = "http://www.w3.org/2000/svg";
const SIZE = 1400;
const CX = SIZE / 2;
const CY = SIZE / 2;
const R_INNER = 150;
const R_OUTER = 560;
const R_LABEL = 640;
let nodes = [];
let view = { x: 0, y: 0, w: SIZE, h: SIZE };

if (!reportId) showError("網址不完整。");
else load();

async function load() {
  el("report-link").href = `/r/${reportId}`;
  const response = await fetch(`/api/reports/${reportId}/report.json`, { cache: "no-store" });
  if (response.status === 409) return showError("報告還沒完成，完成後再回來看畫布。");
  if (!response.ok) return showError(response.status === 410 ? "報告已刪除。" : "找不到這份報告。");
  const report = await response.json();
  document.title = `${report.title} · 畫布`;
  el("title").textContent = report.title;
  el("stats").textContent = `${report.stats.people} 人 · ${report.stats.comments} 則 · ${report.stats.claims} 句主張 · ${report.topics.length} 個主題`;
  layout(report);
  draw();
}

function layout(report) {
  const topics = report.topics.filter((topic) => topic.claimsCount > 0);
  const total = topics.reduce((sum, topic) => sum + topic.claimsCount, 0) || 1;
  const gap = 0.03;
  let angle = -Math.PI / 2;
  const legend = [];
  nodes = [];
  topics.forEach((topic, index) => {
    const color = `hsl(${Math.round((index * 360) / topics.length)} 55% 45%)`;
    const span = (topic.claimsCount / total) * (Math.PI * 2 - gap * topics.length);
    const start = angle;
    const end = angle + span;
    legend.push({ name: topic.name, color });
    const subs = topic.subtopics.filter((sub) => sub.claims.length > 0);
    const subTotal = subs.reduce((sum, sub) => sum + sub.claims.length, 0) || 1;
    let subAngle = start;
    for (const sub of subs) {
      const subSpan = (sub.claims.length / subTotal) * span;
      const mid = subAngle + subSpan / 2;
      const ring = Math.max(1, Math.ceil(sub.claims.length / 6));
      sub.claims.forEach((claim, ci) => {
        const t = sub.claims.length === 1 ? 0.5 : (ci % 6) / Math.min(5, sub.claims.length - 1 || 1);
        const a = subAngle + subSpan * (0.15 + 0.7 * (sub.claims.length === 1 ? 0.5 : t));
        const r = R_INNER + ((Math.floor(ci / 6) + 0.5) / ring) * (R_OUTER - R_INNER) * (0.55 + 0.45 * (ci % 2));
        nodes.push({ id: claim.id, x: CX + Math.cos(a) * r, y: CY + Math.sin(a) * r, size: 5 + Math.sqrt(claim.people) * 4, color, topic: topic.name, subtopic: sub.name, claim, midAngle: mid });
      });
      nodes.push({ spoke: true, angle: mid, name: sub.name, color, x: CX + Math.cos(mid) * (R_OUTER + 10), y: CY + Math.sin(mid) * (R_OUTER + 10) });
      subAngle += subSpan;
    }
    nodes.push({ sector: true, start, end, color, name: topic.name, mid: (start + end) / 2 });
    angle = end + gap;
  });
  el("legend").replaceChildren(...legend.map((item) => {
    const span = document.createElement("span");
    span.style.setProperty("--c", item.color);
    span.textContent = item.name;
    return span;
  }));
}

function draw() {
  const svg = el("svg");
  svg.replaceChildren();
  svg.setAttribute("viewBox", `${view.x} ${view.y} ${view.w} ${view.h}`);
  for (const n of nodes.filter((node) => node.sector)) {
    const path = document.createElementNS(NS, "path");
    const large = n.end - n.start > Math.PI ? 1 : 0;
    const p = (a, r) => `${CX + Math.cos(a) * r} ${CY + Math.sin(a) * r}`;
    path.setAttribute("d", `M ${p(n.start, R_INNER - 20)} L ${p(n.start, R_OUTER + 40)} A ${R_OUTER + 40} ${R_OUTER + 40} 0 ${large} 1 ${p(n.end, R_OUTER + 40)} L ${p(n.end, R_INNER - 20)} A ${R_INNER - 20} ${R_INNER - 20} 0 ${large} 0 ${p(n.start, R_INNER - 20)} Z`);
    path.setAttribute("fill", n.color);
    path.setAttribute("class", "sector");
    svg.append(path);
    const label = document.createElementNS(NS, "text");
    label.setAttribute("class", "topic");
    label.setAttribute("x", CX + Math.cos(n.mid) * R_LABEL);
    label.setAttribute("y", CY + Math.sin(n.mid) * R_LABEL);
    label.setAttribute("text-anchor", Math.cos(n.mid) < -0.2 ? "end" : Math.cos(n.mid) > 0.2 ? "start" : "middle");
    label.setAttribute("dominant-baseline", "middle");
    label.setAttribute("fill", n.color);
    label.textContent = n.name;
    svg.append(label);
  }
  for (const n of nodes.filter((node) => node.spoke)) {
    const line = document.createElementNS(NS, "line");
    line.setAttribute("class", "spoke");
    line.setAttribute("x1", CX + Math.cos(n.angle) * R_INNER);
    line.setAttribute("y1", CY + Math.sin(n.angle) * R_INNER);
    line.setAttribute("x2", CX + Math.cos(n.angle) * R_OUTER);
    line.setAttribute("y2", CY + Math.sin(n.angle) * R_OUTER);
    svg.append(line);
    const label = document.createElementNS(NS, "text");
    label.setAttribute("class", "sub");
    label.setAttribute("x", n.x);
    label.setAttribute("y", n.y);
    label.setAttribute("text-anchor", Math.cos(n.angle) < -0.2 ? "end" : Math.cos(n.angle) > 0.2 ? "start" : "middle");
    label.setAttribute("dominant-baseline", "middle");
    label.textContent = n.name;
    svg.append(label);
  }
  const query = el("filter").value.trim().toLowerCase();
  for (const n of nodes.filter((node) => node.claim)) {
    const circle = document.createElementNS(NS, "circle");
    circle.setAttribute("class", `claim${query && !matches(n, query) ? " dim" : ""}${n.active ? " active" : ""}`);
    circle.setAttribute("cx", n.x);
    circle.setAttribute("cy", n.y);
    circle.setAttribute("r", n.size);
    circle.setAttribute("fill", n.color);
    const title = document.createElementNS(NS, "title");
    title.textContent = `${n.claim.text}（${n.claim.people} 人）`;
    circle.append(title);
    circle.addEventListener("pointerdown", (event) => startNodeDrag(event, n));
    svg.append(circle);
  }
  const center = document.createElementNS(NS, "text");
  center.setAttribute("class", "topic");
  center.setAttribute("x", CX);
  center.setAttribute("y", CY);
  center.setAttribute("text-anchor", "middle");
  center.setAttribute("dominant-baseline", "middle");
  center.textContent = el("title").textContent.slice(0, 18);
  svg.append(center);
}

function matches(n, query) {
  return n.claim.text.toLowerCase().includes(query) || n.topic.toLowerCase().includes(query) || n.subtopic.toLowerCase().includes(query) || n.claim.quotes.some((q) => q.text.toLowerCase().includes(query) || (q.interview || "").toLowerCase().includes(query));
}

function showClaim(n) {
  for (const other of nodes) other.active = false;
  n.active = true;
  const panel = el("panel");
  panel.replaceChildren();
  const crumb = document.createElement("p");
  crumb.className = "hint";
  crumb.textContent = `${n.topic} › ${n.subtopic}`;
  const h3 = document.createElement("h3");
  h3.textContent = n.claim.text;
  const who = document.createElement("p");
  who.className = "hint";
  who.textContent = `${n.claim.people} 人 · ${n.claim.quotes.length} 則引述`;
  panel.append(crumb, h3, who);
  for (const quote of n.claim.quotes) {
    const box = document.createElement("div");
    box.className = "quote";
    box.textContent = quote.text;
    const w = document.createElement("div");
    w.className = "who";
    w.textContent = quote.interview || `#${quote.commentId}`;
    box.append(w);
    panel.append(box);
  }
  draw();
}

// ---- 互動：縮放、平移、拖節點 ----
const svg = el("svg");
let panning = null;
let dragging = null;
const toSvg = (event) => {
  const rect = svg.getBoundingClientRect();
  return { x: view.x + ((event.clientX - rect.left) / rect.width) * view.w, y: view.y + ((event.clientY - rect.top) / rect.height) * view.h };
};
svg.addEventListener("wheel", (event) => {
  event.preventDefault();
  const factor = event.deltaY > 0 ? 1.1 : 0.9;
  const p = toSvg(event);
  const w = Math.min(SIZE * 2, Math.max(200, view.w * factor));
  const h = w;
  view = { x: p.x - ((p.x - view.x) * w) / view.w, y: p.y - ((p.y - view.y) * h) / view.h, w, h };
  draw();
}, { passive: false });
svg.addEventListener("pointerdown", (event) => {
  if (dragging) return;
  panning = { start: toSvg(event), origin: { ...view } };
  svg.classList.add("dragging");
  svg.setPointerCapture(event.pointerId);
});
svg.addEventListener("pointermove", (event) => {
  if (dragging) {
    const p = toSvg(event);
    dragging.node.x = p.x;
    dragging.node.y = p.y;
    dragging.moved = true;
    draw();
    return;
  }
  if (!panning) return;
  const p = toSvg(event);
  view.x = panning.origin.x - (p.x - panning.start.x);
  view.y = panning.origin.y - (p.y - panning.start.y);
  svg.setAttribute("viewBox", `${view.x} ${view.y} ${view.w} ${view.h}`);
});
const endPointer = () => {
  if (dragging && !dragging.moved) showClaim(dragging.node);
  dragging = null;
  panning = null;
  svg.classList.remove("dragging");
};
svg.addEventListener("pointerup", endPointer);
svg.addEventListener("pointercancel", endPointer);
function startNodeDrag(event, node) {
  event.stopPropagation();
  dragging = { node, moved: false };
  svg.setPointerCapture(event.pointerId);
}
el("filter").addEventListener("input", draw);

function showError(message) {
  el("error").textContent = message;
  el("error").classList.remove("hidden");
  el("title").textContent = "無法顯示";
}
