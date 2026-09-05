import { DurableObject } from "cloudflare:workers";
import {
  CALLS_PER_ALARM,
  CLUSTERING_MAX_OUTPUT_TOKENS,
  CLUSTERING_PROMPT_MAX_BYTES,
  EXTRACTION_BATCH_SIZE,
  EXTRACTION_MAX_OUTPUT_TOKENS,
  EXTRACTION_PROMPT_MAX_BYTES,
  GROUPING_MAX_OUTPUT_TOKENS,
  GROUPING_PROMPT_MAX_BYTES,
  MIN_CLAIMS_TO_GROUP,
  MODEL,
  NeuronLedger,
  REPORT_NEURON_CEILING,
  SUMMARY_MAX_OUTPUT_TOKENS,
  SUMMARY_PROMPT_MAX_BYTES,
  nextUtcDayStart,
} from "./ai-budget";
import { COORDINATOR_INSTANCE } from "./coordinator";
import { parseJsonSafe, runModel, type PromptKind } from "./model";
import {
  KEY_SEPARATOR,
  UNASSIGNED_TOPIC,
  buildTree,
  clusteringPrompt,
  extractionPrompt,
  groupingPrompt,
  normalizeClaims,
  normalizeGroups,
  normalizeSummary,
  normalizeTaxonomy,
  summaryPrompt,
  systemPrompt,
  type ClaimGroup,
  type StoredClaim,
  type Taxonomy,
} from "./pipeline";
import type { PublicReport, ReportLanguage, ReportProgress, ReportStatus, ReportTree, SourceRow } from "./types";

type ReportMeta = {
  reportId: string;
  title: string;
  description: string;
  language: ReportLanguage;
  createdAt: number;
  updatedAt: number;
  adminHash: string;
};

export type CreateReportInput = {
  reportId: string;
  title: string;
  description: string;
  language: ReportLanguage;
  adminHash: string;
  rows: SourceRow[];
};

const MAX_ATTEMPTS = 3;
const RETRY_BASE_MS = 20_000;

/** 一份報告一個 Durable Object：輸入、管線進度、抽出的主張與最後的議題樹都在這裡。 */
export class ReportRoom extends DurableObject<Env> {
  private migrated = false;

  private sql() {
    if (!this.migrated) {
      const sql = this.ctx.storage.sql;
      sql.exec(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
      sql.exec(`CREATE TABLE IF NOT EXISTS rows (seq INTEGER PRIMARY KEY, id TEXT NOT NULL, interview TEXT NOT NULL, comment TEXT NOT NULL)`);
      sql.exec(
        `CREATE TABLE IF NOT EXISTS claims (id TEXT PRIMARY KEY, seq INTEGER NOT NULL, comment_id TEXT NOT NULL, interview TEXT NOT NULL, claim TEXT NOT NULL, quote TEXT NOT NULL, topic TEXT NOT NULL, subtopic TEXT NOT NULL)`,
      );
      sql.exec(`CREATE TABLE IF NOT EXISTS groups (key TEXT NOT NULL, idx INTEGER NOT NULL, claim_text TEXT NOT NULL, member_ids TEXT NOT NULL, PRIMARY KEY (key, idx))`);
      sql.exec(`CREATE TABLE IF NOT EXISTS summaries (topic TEXT PRIMARY KEY, summary TEXT NOT NULL)`);
      this.migrated = true;
    }
    return this.ctx.storage.sql;
  }

  private getMeta<T>(key: string): T | null {
    const rows = this.sql().exec(`SELECT value FROM meta WHERE key = ?`, key).toArray();
    if (rows.length === 0) return null;
    try {
      return JSON.parse(String(rows[0]?.value)) as T;
    } catch {
      return null;
    }
  }

  private setMeta(key: string, value: unknown): void {
    this.sql().exec(
      `INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      key,
      JSON.stringify(value),
    );
  }

  // ---- 建立、讀取、刪除 ----

  async create(input: CreateReportInput): Promise<{ ok: true } | { ok: false; error: string }> {
    if (this.getMeta<ReportMeta>("report")) return { ok: false, error: "report already exists" };
    const now = Date.now();
    const meta: ReportMeta = {
      reportId: input.reportId,
      title: input.title,
      description: input.description,
      language: input.language,
      createdAt: now,
      updatedAt: now,
      adminHash: input.adminHash,
    };
    this.ctx.storage.transactionSync(() => {
      this.setMeta("report", meta);
      for (const row of input.rows) {
        this.sql().exec(`INSERT INTO rows (seq, id, interview, comment) VALUES (?, ?, ?, ?)`, row.seq, row.id, row.interview, row.comment);
      }
      this.setMeta("progress", initialProgress(input.rows.length));
      this.setMeta("ledger", 0);
      this.setMeta("cursor", 0);
    });
    await this.ctx.storage.setAlarm(now + 250);
    return { ok: true };
  }

  async publicReport(): Promise<PublicReport | null> {
    const meta = this.getMeta<ReportMeta>("report");
    if (!meta) return null;
    const progress = this.getMeta<ReportProgress>("progress") ?? initialProgress(0);
    const rows = Number(this.sql().exec(`SELECT COUNT(*) AS n FROM rows`).one().n);
    const tree = progress.status === "ready" ? this.getMeta<ReportTree>("tree") : null;
    return {
      reportId: meta.reportId,
      title: meta.title,
      description: meta.description,
      language: meta.language,
      createdAt: meta.createdAt,
      updatedAt: meta.updatedAt,
      rows,
      progress,
      model: String(this.env.AI_MODE) === "fake" ? "fake" : MODEL,
      tree,
    };
  }

  async claimRows(): Promise<{ topic: string; subtopic: string; claim: string; people: number; quote: string; interview: string; commentId: string }[]> {
    const tree = this.getMeta<ReportTree>("tree");
    if (!tree) return [];
    const out: { topic: string; subtopic: string; claim: string; people: number; quote: string; interview: string; commentId: string }[] = [];
    for (const topic of tree.topics) {
      for (const subtopic of topic.subtopics) {
        for (const claim of subtopic.claims) {
          for (const quote of claim.quotes) {
            out.push({ topic: topic.name, subtopic: subtopic.name, claim: claim.text, people: claim.people, quote: quote.text, interview: quote.interview, commentId: quote.commentId });
          }
        }
      }
    }
    return out;
  }

  async verifyAdmin(hash: string): Promise<boolean> {
    const meta = this.getMeta<ReportMeta>("report");
    return Boolean(meta) && timingSafeEqual(meta?.adminHash ?? "", hash);
  }

  async deleteReport(): Promise<boolean> {
    const meta = this.getMeta<ReportMeta>("report");
    if (!meta) return false;
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
    this.migrated = false;
    this.sql();
    this.setMeta("report", { ...meta, title: "", description: "" });
    this.setMeta("progress", { ...initialProgress(0), status: "deleted" satisfies ReportStatus });
    return true;
  }

  /** 失敗或等額度的報告可由主辦者重新排程；不重跑已完成的步驟。 */
  async retry(): Promise<boolean> {
    const progress = this.getMeta<ReportProgress>("progress");
    if (!progress || !["failed", "waiting-budget"].includes(progress.status)) return false;
    const status: ReportStatus = progress.step === "clustering" ? "queued" : (progress.step as ReportStatus);
    this.setMeta("progress", { ...progress, status, attempts: 0, lastError: "", nextAttemptAt: null });
    await this.ctx.storage.setAlarm(Date.now() + 250);
    return true;
  }

  // ---- 管線：每次 alarm 做有限次模型呼叫，進度存進 SQLite，再排下一次 ----

  async alarm(): Promise<void> {
    const meta = this.getMeta<ReportMeta>("report");
    const progress = this.getMeta<ReportProgress>("progress");
    if (!meta || !progress) return;
    if (["ready", "failed", "deleted"].includes(progress.status)) return;
    if (progress.status === "waiting-budget" && progress.nextAttemptAt && Date.now() < progress.nextAttemptAt) {
      await this.ctx.storage.setAlarm(progress.nextAttemptAt);
      return;
    }
    const ledger = new NeuronLedger(REPORT_NEURON_CEILING, this.getMeta<number>("ledger") ?? 0);
    const coordinator = this.env.COORDINATOR.get(this.env.COORDINATOR.idFromName(COORDINATOR_INSTANCE));
    const reserveGlobal = async (neurons: number) => (await coordinator.reserveNeurons(neurons)).ok;
    const system = systemPrompt(meta.language);
    let calls = 0;
    let current: ReportProgress = progress.status === "waiting-budget" || progress.status === "queued"
      ? { ...progress, status: progress.step === "clustering" ? "clustering" : (progress.step as ReportStatus), nextAttemptAt: null }
      : progress;

    const call = async (kind: PromptKind, user: string, maxTokens: number) => {
      calls += 1;
      const result = await runModel(this.env, kind, system, user, maxTokens, ledger, reserveGlobal);
      this.setMeta("ledger", ledger.reserved);
      return result;
    };

    const save = (next: Partial<ReportProgress>) => {
      current = { ...current, ...next, neuronsReserved: ledger.reserved };
      this.setMeta("progress", current);
      this.setMeta("report", { ...meta, updatedAt: Date.now() });
    };

    try {
      while (calls < CALLS_PER_ALARM) {
        const rows = this.allRows();
        if (current.status === "clustering") {
          const result = await call("clustering", clusteringPrompt(meta.title, meta.description, rows, CLUSTERING_PROMPT_MAX_BYTES), CLUSTERING_MAX_OUTPUT_TOKENS);
          if (!result.ok) return await this.handleFailure(result, current, save);
          const taxonomy = normalizeTaxonomy(parseJsonSafe(result.text));
          if (!taxonomy) return await this.handleFailure({ ok: false, reason: "error", error: "clustering returned no usable taxonomy" }, current, save);
          this.setMeta("taxonomy", taxonomy);
          this.setMeta("cursor", 0);
          save({ status: "extracting", step: "extracting", done: 0, total: rows.length, attempts: 0, lastError: "" });
          continue;
        }
        if (current.status === "extracting") {
          const taxonomy = this.getMeta<Taxonomy>("taxonomy") ?? [];
          const cursor = this.getMeta<number>("cursor") ?? 0;
          if (cursor >= rows.length) {
            const queue = this.subtopicKeysToGroup();
            this.setMeta("groupQueue", queue);
            save({ status: "grouping", step: "grouping", done: 0, total: queue.length, attempts: 0, lastError: "" });
            continue;
          }
          const batch = rows.slice(cursor, cursor + EXTRACTION_BATCH_SIZE);
          const result = await call("extraction", extractionPrompt(taxonomy, batch, EXTRACTION_PROMPT_MAX_BYTES), EXTRACTION_MAX_OUTPUT_TOKENS);
          if (!result.ok) {
            if (result.reason === "error" && current.attempts + 1 >= MAX_ATTEMPTS) {
              // 這一批連續失敗：跳過，記下來，繼續往前，避免整份報告卡死。
              this.setMeta("cursor", cursor + batch.length);
              save({ done: cursor + batch.length, attempts: 0, lastError: `skipped ${batch.length} comments after repeated failures: ${result.error}` });
              continue;
            }
            return await this.handleFailure(result, current, save);
          }
          const claims = normalizeClaims(parseJsonSafe(result.text), taxonomy, batch);
          this.storeClaims(claims, batch);
          this.setMeta("cursor", cursor + batch.length);
          save({ done: cursor + batch.length, attempts: 0 });
          continue;
        }
        if (current.status === "grouping") {
          const queue = this.getMeta<string[]>("groupQueue") ?? [];
          const key = queue[0];
          if (!key) {
            const topics = (this.getMeta<Taxonomy>("taxonomy") ?? []).map((topic) => topic.name).filter((name) => this.topicHasClaims(name));
            this.setMeta("summaryQueue", topics);
            save({ status: "summarizing", step: "summarizing", done: 0, total: topics.length, attempts: 0, lastError: "" });
            continue;
          }
          const [topic, subtopic] = splitKey(key);
          const members = this.claimsFor(topic, subtopic);
          const result = await call("grouping", groupingPrompt(topic, subtopic, members.map((claim) => ({ id: claim.id, claim: claim.claim, quote: claim.quote })), GROUPING_PROMPT_MAX_BYTES), GROUPING_MAX_OUTPUT_TOKENS);
          if (!result.ok) {
            if (result.reason === "error" && current.attempts + 1 >= MAX_ATTEMPTS) {
              this.setMeta("groupQueue", queue.slice(1));
              save({ done: current.done + 1, attempts: 0, lastError: `left ${key} ungrouped after repeated failures: ${result.error}` });
              continue;
            }
            return await this.handleFailure(result, current, save);
          }
          const groups = normalizeGroups(parseJsonSafe(result.text), members.map((claim) => claim.id));
          this.storeGroups(key, groups);
          this.setMeta("groupQueue", queue.slice(1));
          save({ done: current.done + 1, attempts: 0 });
          continue;
        }
        if (current.status === "summarizing") {
          const queue = this.getMeta<string[]>("summaryQueue") ?? [];
          const topicName = queue[0];
          if (!topicName) {
            const tree = this.assembleTree(rows);
            this.setMeta("tree", tree);
            save({ status: "ready", step: "ready", done: current.total, attempts: 0, lastError: "", nextAttemptAt: null });
            return;
          }
          const interim = this.assembleTree(rows);
          const topic = interim.topics.find((candidate) => candidate.name === topicName);
          if (!topic) {
            this.setMeta("summaryQueue", queue.slice(1));
            continue;
          }
          const result = await call("summary", summaryPrompt(topic, SUMMARY_PROMPT_MAX_BYTES), SUMMARY_MAX_OUTPUT_TOKENS);
          if (!result.ok) {
            if (result.reason === "error" && current.attempts + 1 >= MAX_ATTEMPTS) {
              this.setMeta("summaryQueue", queue.slice(1));
              save({ done: current.done + 1, attempts: 0, lastError: `no summary for ${topicName}: ${result.error}` });
              continue;
            }
            return await this.handleFailure(result, current, save);
          }
          this.sql().exec(`INSERT INTO summaries (topic, summary) VALUES (?, ?) ON CONFLICT(topic) DO UPDATE SET summary = excluded.summary`, topicName, normalizeSummary(parseJsonSafe(result.text)));
          this.setMeta("summaryQueue", queue.slice(1));
          save({ done: current.done + 1, attempts: 0 });
          continue;
        }
        // queued 或未知狀態：從分群開始
        save({ status: "clustering", step: "clustering" });
      }
      // 本次呼叫額度用完但工作未完：排下一次
      await this.ctx.storage.setAlarm(Date.now() + 500);
    } catch (error) {
      await this.handleFailure({ ok: false, reason: "error", error: error instanceof Error ? error.message.slice(0, 300) : String(error) }, current, save);
    }
  }

  private async handleFailure(
    result: { ok: false; reason: "budget"; neurons: number } | { ok: false; reason: "error"; error: string },
    current: ReportProgress,
    save: (next: Partial<ReportProgress>) => void,
  ): Promise<void> {
    if (result.reason === "budget") {
      const ledger = this.getMeta<number>("ledger") ?? 0;
      if (ledger + result.neurons > REPORT_NEURON_CEILING) {
        save({ status: "failed", lastError: `這份報告需要的神經元超過單份上限 ${REPORT_NEURON_CEILING}；請減少發言數或提高上限後重試。`, nextAttemptAt: null });
        return;
      }
      const next = nextUtcDayStart(Date.now());
      save({ status: "waiting-budget", lastError: "今日的 Workers AI 免費額度已用完，明天（UTC）自動續跑。", nextAttemptAt: next });
      await this.ctx.storage.setAlarm(next);
      return;
    }
    const attempts = current.attempts + 1;
    if (attempts >= MAX_ATTEMPTS) {
      save({ status: "failed", attempts, lastError: result.error, nextAttemptAt: null });
      return;
    }
    const next = Date.now() + RETRY_BASE_MS * attempts;
    save({ attempts, lastError: result.error, nextAttemptAt: next });
    await this.ctx.storage.setAlarm(next);
  }

  // ---- 儲存輔助 ----

  private allRows(): SourceRow[] {
    return this.sql()
      .exec(`SELECT seq, id, interview, comment FROM rows ORDER BY seq`)
      .toArray()
      .map((row) => ({ seq: Number(row.seq), id: String(row.id), interview: String(row.interview), comment: String(row.comment) }));
  }

  private storeClaims(claims: ReturnType<typeof normalizeClaims>, batch: SourceRow[]): void {
    const rowById = new Map(batch.map((row) => [row.id, row]));
    this.ctx.storage.transactionSync(() => {
      claims.forEach((claim, index) => {
        const row = rowById.get(claim.commentId);
        if (!row) return;
        this.sql().exec(
          `INSERT OR REPLACE INTO claims (id, seq, comment_id, interview, claim, quote, topic, subtopic) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          `c${row.seq}-${index + 1}`,
          row.seq,
          row.id,
          row.interview,
          claim.claim,
          claim.quote,
          claim.topicName,
          claim.subtopicName,
        );
      });
    });
  }

  private storeGroups(key: string, groups: ClaimGroup[]): void {
    this.ctx.storage.transactionSync(() => {
      this.sql().exec(`DELETE FROM groups WHERE key = ?`, key);
      groups.forEach((group, index) => {
        this.sql().exec(`INSERT INTO groups (key, idx, claim_text, member_ids) VALUES (?, ?, ?, ?)`, key, index, group.claimText, JSON.stringify(group.originalClaimIds));
      });
    });
  }

  private allClaims(): StoredClaim[] {
    return this.sql()
      .exec(`SELECT id, comment_id, interview, claim, quote, topic, subtopic FROM claims ORDER BY seq, id`)
      .toArray()
      .map((row) => ({
        id: String(row.id),
        commentId: String(row.comment_id),
        interview: String(row.interview),
        claim: String(row.claim),
        quote: String(row.quote),
        topicName: String(row.topic),
        subtopicName: String(row.subtopic),
      }));
  }

  private claimsFor(topic: string, subtopic: string): StoredClaim[] {
    return this.allClaims().filter((claim) => claim.topicName === topic && claim.subtopicName === subtopic);
  }

  private topicHasClaims(topic: string): boolean {
    return Number(this.sql().exec(`SELECT COUNT(*) AS n FROM claims WHERE topic = ?`, topic).one().n) > 0;
  }

  private subtopicKeysToGroup(): string[] {
    return this.sql()
      .exec(`SELECT topic, subtopic, COUNT(*) AS n FROM claims WHERE topic != ? GROUP BY topic, subtopic HAVING n >= ? ORDER BY n DESC`, UNASSIGNED_TOPIC, MIN_CLAIMS_TO_GROUP)
      .toArray()
      .map((row) => joinKey(String(row.topic), String(row.subtopic)));
  }

  private assembleTree(rows: SourceRow[]): ReportTree {
    const taxonomy = this.getMeta<Taxonomy>("taxonomy") ?? [];
    const groups = new Map<string, ClaimGroup[]>();
    for (const row of this.sql().exec(`SELECT key, idx, claim_text, member_ids FROM groups ORDER BY key, idx`).toArray()) {
      const key = String(row.key);
      const list = groups.get(key) ?? [];
      list.push({ claimText: String(row.claim_text), originalClaimIds: JSON.parse(String(row.member_ids)) as string[] });
      groups.set(key, list);
    }
    const summaries = new Map<string, string>();
    for (const row of this.sql().exec(`SELECT topic, summary FROM summaries`).toArray()) summaries.set(String(row.topic), String(row.summary));
    return buildTree(taxonomy, this.allClaims(), groups, summaries, rows, Date.now());
  }
}

function initialProgress(total: number): ReportProgress {
  return { status: "queued", step: "clustering", done: 0, total, attempts: 0, lastError: "", nextAttemptAt: null, neuronsReserved: 0 };
}

function joinKey(topic: string, subtopic: string): string {
  return `${topic}${KEY_SEPARATOR}${subtopic}`;
}
function splitKey(key: string): [string, string] {
  const index = key.indexOf(KEY_SEPARATOR);
  return index < 0 ? [key, ""] : [key.slice(0, index), key.slice(index + 1)];
}

function timingSafeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let index = 0; index < left.length; index += 1) diff |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return diff === 0;
}
