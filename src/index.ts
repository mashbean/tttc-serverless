import { CsvError, MAX_CSV_BYTES, csvTable, parseSourceCsv } from "./csv";
import { COORDINATOR_INSTANCE, Coordinator } from "./coordinator";
import { ReportRoom } from "./report-room";
import type { ReportLanguage } from "./types";

export { Coordinator, ReportRoom };

const REPORT_ID = /^[a-z0-9]{10}$/;
const ADMIN_TOKEN = /^[0-9a-f]{32}$/;
const MAX_BODY_BYTES = MAX_CSV_BYTES + 16 * 1024;
const DEFAULT_MAX_ROWS = 600;

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (url.pathname === "/api/health") return health(request, env);
      if (url.pathname === "/api/reports" && request.method === "POST") return createReport(request, env, url);
      const reportMatch = url.pathname.match(/^\/api\/reports\/([a-z0-9]{10})(?:\/(report\.json|claims\.csv|retry))?$/);
      if (reportMatch) return reportApi(request, env, reportMatch[1] as string, reportMatch[2]);
      if (url.pathname.startsWith("/api/")) return jsonError("not found", 404);
      if (/^\/r\/[a-z0-9]{10}\/?$/.test(url.pathname)) {
        const page = await env.ASSETS.fetch(new Request(new URL("/report.html", url.origin), request));
        return new Response(page.body, { status: page.status, headers: withSecurity(new Headers(page.headers)) });
      }
      return env.ASSETS.fetch(request);
    } catch (error) {
      console.error("unhandled", error instanceof Error ? error.message : error);
      return jsonError("internal error", 500);
    }
  },
} satisfies ExportedHandler<Env>;

async function health(request: Request, env: Env): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") return jsonError("method not allowed", 405);
  const coordinator = env.COORDINATOR.get(env.COORDINATOR.idFromName(COORDINATOR_INSTANCE));
  const remaining = await coordinator.dailyRemaining();
  return json({ ok: true, aiMode: isFakeAi(env) ? "fake" : "live", maxRows: maxRows(env), dailyNeuronsRemaining: Math.floor(remaining) }, 200);
}

async function createReport(request: Request, env: Env, url: URL): Promise<Response> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > MAX_BODY_BYTES) return jsonError(`request too large (max ${MAX_BODY_BYTES} bytes)`, 413);
  const input = await readCreateInput(request);
  if ("error" in input) return jsonError(input.error, 400);
  const title = cleanLine(input.title, 120);
  if (!title) return jsonError("title is required", 400);
  const description = cleanText(input.description, 2_000);
  const language: ReportLanguage = input.language === "en" ? "en" : "zh-Hant";
  if (input.csv.length > MAX_CSV_BYTES) return jsonError(`csv too large (max ${MAX_CSV_BYTES} bytes)`, 413);
  let rows;
  try {
    rows = parseSourceCsv(input.csv, maxRows(env));
  } catch (error) {
    if (error instanceof CsvError) return jsonError(error.message, 400);
    throw error;
  }
  if (input.confirmed !== true) return jsonError("confirmed must be true: the caller has checked the CSV contains no direct identifiers and has consent to analyze it", 400);
  const coordinator = env.COORDINATOR.get(env.COORDINATOR.idFromName(COORDINATOR_INSTANCE));
  if (!(await coordinator.reserveCreation())) return jsonError("creation rate limit reached, try again later", 429);
  const reportId = randomId(10);
  const adminToken = randomHex(16);
  const adminHash = await sha256Hex(adminToken);
  const stub = env.REPORT.get(env.REPORT.idFromName(reportId));
  const created = await stub.create({ reportId, title, description, language, adminHash, rows });
  if (!created.ok) return jsonError(created.error, 500);
  return json(
    {
      reportId,
      title,
      rows: rows.length,
      status: "queued",
      adminToken,
      urls: {
        report: `${url.origin}/r/${reportId}`,
        api: `${url.origin}/api/reports/${reportId}`,
        manage: `${url.origin}/r/${reportId}#admin=${adminToken}`,
      },
      privacy: { storedByService: true, storedFields: ["title", "description", "rows", "claims", "tree"], adminTokenStored: "sha-256 hash only" },
    },
    201,
  );
}

async function reportApi(request: Request, env: Env, reportId: string, sub: string | undefined): Promise<Response> {
  const stub = env.REPORT.get(env.REPORT.idFromName(reportId));
  if (sub === "retry") {
    if (request.method !== "POST") return jsonError("method not allowed", 405);
    const auth = await requireAdmin(request, stub);
    if (auth) return auth;
    return json({ ok: await stub.retry() }, 200);
  }
  if (request.method === "DELETE" && !sub) {
    const auth = await requireAdmin(request, stub);
    if (auth) return auth;
    return json({ ok: await stub.deleteReport() }, 200);
  }
  if (request.method !== "GET" && request.method !== "HEAD") return jsonError("method not allowed", 405);
  const report = await stub.publicReport();
  if (!report) return jsonError("not found", 404);
  if (report.progress.status === "deleted") return jsonError("deleted", 410);
  if (sub === "claims.csv") {
    if (!report.tree) return jsonError("report not ready", 409);
    const rows = await stub.claimRows();
    const csv = csvTable(["topic", "subtopic", "claim", "people", "quote", "interview", "comment_id"], rows.map((row) => [row.topic, row.subtopic, row.claim, row.people, row.quote, row.interview, row.commentId]));
    return new Response(csv, {
      headers: withSecurity(new Headers({ "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="tttc-${reportId}-claims.csv"` })),
    });
  }
  if (sub === "report.json") {
    if (!report.tree) return jsonError("report not ready", 409);
    return json({ reportId, title: report.title, description: report.description, language: report.language, model: report.model, ...report.tree }, 200);
  }
  return json(report, 200);
}

async function requireAdmin(request: Request, stub: DurableObjectStub<ReportRoom>): Promise<Response | null> {
  const token = request.headers.get("X-Report-Admin") ?? "";
  if (!ADMIN_TOKEN.test(token)) return jsonError("missing admin token", 401);
  if (!(await stub.verifyAdmin(await sha256Hex(token)))) return jsonError("admin token does not match", 403);
  return null;
}

type CreateInput = { title: string; description: string; language: string; csv: string; confirmed: boolean };

async function readCreateInput(request: Request): Promise<CreateInput | { error: string }> {
  const type = request.headers.get("content-type") ?? "";
  if (type.startsWith("multipart/form-data")) {
    const form = await request.formData();
    const file = form.get("file");
    const csv = file instanceof File ? await file.text() : String(form.get("csv") ?? "");
    return {
      title: String(form.get("title") ?? ""),
      description: String(form.get("description") ?? ""),
      language: String(form.get("language") ?? ""),
      csv,
      confirmed: String(form.get("confirmed") ?? "") === "true",
    };
  }
  if (!type.startsWith("application/json")) return { error: "send application/json or multipart/form-data" };
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) return { error: "request too large" };
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return { error: "invalid JSON" };
  }
  if (typeof body !== "object" || body === null) return { error: "invalid body" };
  const record = body as Record<string, unknown>;
  return {
    title: typeof record.title === "string" ? record.title : "",
    description: typeof record.description === "string" ? record.description : "",
    language: typeof record.language === "string" ? record.language : "",
    csv: typeof record.csv === "string" ? record.csv : "",
    confirmed: record.confirmed === true,
  };
}

export function isFakeAi(env: Env): boolean {
  return String(env.AI_MODE) === "fake";
}

function maxRows(env: Env): number {
  const raw = Number(env.MAX_ROWS);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_MAX_ROWS;
}

function cleanLine(value: string, max: number): string {
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

function cleanText(value: string, max: number): string {
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").replace(/\r\n?/g, "\n").trim().slice(0, max);
}

function randomId(length: number): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join("");
}

function randomHex(bytes: number): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function withSecurity(headers: Headers): Headers {
  headers.set("Cache-Control", "no-store");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Referrer-Policy", "no-referrer");
  return headers;
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: withSecurity(new Headers({ "Content-Type": "application/json; charset=utf-8" })) });
}

function jsonError(message: string, status: number): Response {
  return json({ error: message }, status);
}
