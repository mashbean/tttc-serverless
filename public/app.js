const form = document.querySelector("#create-form");
const status = document.querySelector("#status");
const submit = document.querySelector("#submit");
const result = document.querySelector("#result");

fetch("/api/health").then((response) => response.json()).then((health) => {
  if (health && Number.isFinite(health.maxRows)) document.querySelector("#max-rows").textContent = String(health.maxRows);
}).catch(() => {});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const file = document.querySelector("#file").files[0];
  let csv = document.querySelector("#csv").value;
  if (file) {
    if (file.size > 3 * 1024 * 1024) {
      status.textContent = "檔案超過 3 MiB。";
      return;
    }
    csv = await file.text();
  }
  if (!csv.trim()) {
    status.textContent = "請放入 CSV。";
    return;
  }
  if (!document.querySelector("#confirmed").checked) {
    status.textContent = "請先確認資料沒有直接識別資訊，且你有權利交給模型分析。";
    return;
  }
  submit.disabled = true;
  status.textContent = "正在檢查 CSV 並建立報告…";
  try {
    const response = await fetch("/api/reports", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: document.querySelector("#title").value,
        description: document.querySelector("#description").value,
        language: document.querySelector("#language").value,
        csv,
        confirmed: true,
      }),
    });
    const body = await response.json();
    if (!response.ok) {
      status.textContent = body && body.error ? body.error : `建立失敗（${response.status}）`;
      return;
    }
    document.querySelector("#report-link").href = body.urls.report;
    document.querySelector("#report-link").textContent = body.urls.report;
    document.querySelector("#manage-link").href = body.urls.manage;
    document.querySelector("#manage-link").textContent = body.urls.manage;
    result.classList.remove("hidden");
    status.textContent = `已建立，共 ${body.rows} 則發言。`;
    result.scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (error) {
    status.textContent = error instanceof Error ? error.message : "建立失敗。";
  } finally {
    submit.disabled = false;
  }
});
