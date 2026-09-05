// 管線的純函式：提示詞、模型輸出的正規化、議題樹的組裝。不碰儲存與網路。
import { MAX_SUBTOPICS_PER_TOPIC, MAX_TOPICS, packItemsUtf8, truncateUtf8, utf8ByteLength } from "./ai-budget";
import type { ReportClaim, ReportLanguage, ReportSubtopic, ReportTopic, ReportTree, SourceRow } from "./types";

export type Taxonomy = { name: string; description: string; subtopics: { name: string; description: string }[] }[];

export type ExtractedClaim = {
  commentId: string;
  claim: string;
  quote: string;
  topicName: string;
  subtopicName: string;
};

export type ClaimGroup = { claimText: string; originalClaimIds: string[] };

export const UNASSIGNED_TOPIC = "其他";
export const UNASSIGNED_SUBTOPIC = "未歸類";

const OUTPUT_LANGUAGE: Record<ReportLanguage, string> = {
  "zh-Hant": "Traditional Chinese as used in Taiwan (zh-Hant-TW)",
  en: "English",
};

export function systemPrompt(language: ReportLanguage): string {
  return (
    "You are a professional research assistant who has helped run many public consultations, surveys and citizen assemblies. " +
    "You extract clear, concise, atomic claims that other people could vote on, and you never invent content that is not in the source. " +
    `Write every name, description, claim and summary in ${OUTPUT_LANGUAGE[language]}. ` +
    "Reply with a single JSON object and nothing else: no prose, no markdown fences."
  );
}

export function clusteringPrompt(title: string, description: string, rows: SourceRow[], maxBytes: number): string {
  const head =
    `Consultation: ${sanitize(title, 200)}\n${description ? `Context: ${sanitize(description, 1_000)}\n` : ""}` +
    `Propose a way to break the comments below into ${Math.min(MAX_TOPICS, 7)} or fewer topics, each with ${MAX_SUBTOPICS_PER_TOPIC} or fewer subtopics. ` +
    "Topic names: 2-5 words. Topic descriptions: 25-35 words. Subtopic names: 2-6 words. Subtopic descriptions: 40-70 words describing which perspectives and issues fall under it.\n" +
    'Return {"taxonomy":[{"topicName":string,"topicShortDescription":string,"subtopics":[{"subtopicName":string,"subtopicShortDescription":string}]}]}\n\nComments:\n';
  const budget = Math.max(2_000, maxBytes - utf8ByteLength(head));
  return head + packItemsUtf8(rows.map((row) => ({ id: row.id, text: row.comment })), budget);
}

export function extractionPrompt(taxonomy: Taxonomy, rows: SourceRow[], maxBytes: number): string {
  const taxonomyText = taxonomy
    .map((topic) => `- ${topic.name}: ${topic.subtopics.map((subtopic) => subtopic.name).join(" / ")}`)
    .join("\n");
  const head =
    "For each comment below, extract the most important concise claims the participant may support. Only claims that map to one of the given topics and subtopics. " +
    "A claim must be general but not a platitude, something other people could disagree with, and atomic. Extract zero claims for vague comments, anecdotes without a principle, questions or musings. " +
    "Treat similar points as one claim. When unsure, extract nothing. For each claim give a short exact quote from that comment (you may use [...] to skip parts).\n" +
    'Return {"claims":[{"commentId":string,"claim":string,"quote":string,"topicName":string,"subtopicName":string}]} using the ids in square brackets as commentId.\n\n' +
    `Topics and subtopics:\n${taxonomyText}\n\nComments:\n`;
  const budget = Math.max(1_000, maxBytes - utf8ByteLength(head));
  return head + packItemsUtf8(rows.map((row) => ({ id: row.id, text: row.comment })), budget);
}

export function groupingPrompt(
  topic: string,
  subtopic: string,
  claims: { id: string; claim: string; quote: string }[],
  maxBytes: number,
): string {
  const head =
    `Topic: ${sanitize(topic, 80)} / Subtopic: ${sanitize(subtopic, 80)}\n` +
    "Group the claims below so readers can see which themes matter most. Group claims that share the same concern, the same recommendation, the same value, or are aspects or examples of the same idea. " +
    "Keep claims separate when they address different topics, take opposing positions, or when one is about process and the other about outcome. " +
    "For each group write one claim that captures the shared essence using the participants' own concepts, specific enough to be meaningful. Single-claim groups should be uncommon but are allowed. Every input id must appear in exactly one group.\n" +
    'Return {"groupedClaims":[{"claimText":string,"originalClaimIds":[string]}]}\n\nClaims:\n';
  const budget = Math.max(1_000, maxBytes - utf8ByteLength(head));
  return (
    head +
    packItemsUtf8(
      claims.map((claim) => ({ id: claim.id, text: `${claim.claim} — "${claim.quote}"` })),
      budget,
    )
  );
}

export function summaryPrompt(topic: ReportTopic, maxBytes: number): string {
  const head =
    `Topic: ${sanitize(topic.name, 80)}\nDescription: ${sanitize(topic.description, 400)}\n` +
    "Write a 100-140 word summary that synthesizes the key themes across the subtopics, highlights the main claims and perspectives, and captures the breadth of the discussion. Do not add facts that are not in the claims.\n" +
    'Return {"summary":string}\n\nSubtopics and claims:\n';
  const lines: { id: string; text: string }[] = [];
  for (const subtopic of topic.subtopics) {
    for (const claim of subtopic.claims) {
      lines.push({ id: `${subtopic.name}#${lines.length + 1}`, text: `${claim.text}（${claim.people} 人）` });
    }
  }
  const budget = Math.max(1_000, maxBytes - utf8ByteLength(head));
  return head + (lines.length > 0 ? packItemsUtf8(lines, budget) : "(no claims)");
}

export function normalizeTaxonomy(raw: unknown): Taxonomy | null {
  const record = raw as { taxonomy?: unknown } | null;
  const list = Array.isArray(record?.taxonomy) ? record.taxonomy : Array.isArray(raw) ? raw : null;
  if (!list) return null;
  const seen = new Set<string>();
  const taxonomy: Taxonomy = [];
  for (const item of list.slice(0, MAX_TOPICS)) {
    if (typeof item !== "object" || item === null) continue;
    const topic = item as Record<string, unknown>;
    const name = sanitize(topic.topicName ?? topic.name, 60);
    if (!name || seen.has(name.toLowerCase())) continue;
    const subtopics: Taxonomy[number]["subtopics"] = [];
    const subSeen = new Set<string>();
    const rawSubs = Array.isArray(topic.subtopics) ? topic.subtopics : [];
    for (const rawSub of rawSubs.slice(0, MAX_SUBTOPICS_PER_TOPIC)) {
      if (typeof rawSub !== "object" || rawSub === null) continue;
      const sub = rawSub as Record<string, unknown>;
      const subName = sanitize(sub.subtopicName ?? sub.name, 60);
      if (!subName || subSeen.has(subName.toLowerCase())) continue;
      subSeen.add(subName.toLowerCase());
      subtopics.push({ name: subName, description: sanitize(sub.subtopicShortDescription ?? sub.description, 600) });
    }
    if (subtopics.length === 0) subtopics.push({ name: "一般", description: "" });
    seen.add(name.toLowerCase());
    taxonomy.push({ name, description: sanitize(topic.topicShortDescription ?? topic.description, 400), subtopics });
  }
  return taxonomy.length > 0 ? taxonomy : null;
}

/** 只接受批次裡存在的 commentId；主題／子主題對不上時歸到「其他／未歸類」。 */
export function normalizeClaims(raw: unknown, taxonomy: Taxonomy, batch: SourceRow[]): ExtractedClaim[] {
  const record = raw as { claims?: unknown } | null;
  const list = Array.isArray(record?.claims) ? record.claims : Array.isArray(raw) ? raw : [];
  const rowById = new Map(batch.map((row) => [row.id, row]));
  const topicByLower = new Map(taxonomy.map((topic) => [topic.name.toLowerCase(), topic]));
  const out: ExtractedClaim[] = [];
  for (const item of list) {
    if (typeof item !== "object" || item === null) continue;
    const claimRecord = item as Record<string, unknown>;
    const commentId = sanitize(claimRecord.commentId ?? claimRecord.id, 120);
    const row = rowById.get(commentId);
    if (!row) continue;
    const claim = sanitize(claimRecord.claim, 300);
    if (!claim) continue;
    let quote = sanitize(claimRecord.quote, 400);
    if (!quote) quote = truncateUtf8(row.comment, 200);
    const topic = topicByLower.get(sanitize(claimRecord.topicName, 60).toLowerCase());
    const subtopicName = sanitize(claimRecord.subtopicName, 60);
    const subtopic = topic?.subtopics.find((candidate) => candidate.name.toLowerCase() === subtopicName.toLowerCase());
    out.push({
      commentId,
      claim,
      quote,
      topicName: topic ? topic.name : UNASSIGNED_TOPIC,
      subtopicName: topic ? (subtopic ? subtopic.name : (topic.subtopics[0]?.name ?? UNASSIGNED_SUBTOPIC)) : UNASSIGNED_SUBTOPIC,
    });
    if (out.length >= batch.length * 4) break;
  }
  return out;
}

/** 每個輸入 id 只能出現在一個群；沒被分到的 id 各自成群。 */
export function normalizeGroups(raw: unknown, ids: string[]): ClaimGroup[] {
  const record = raw as { groupedClaims?: unknown } | null;
  const list = Array.isArray(record?.groupedClaims) ? record.groupedClaims : Array.isArray(raw) ? raw : [];
  const valid = new Set(ids);
  const used = new Set<string>();
  const groups: ClaimGroup[] = [];
  for (const item of list) {
    if (typeof item !== "object" || item === null) continue;
    const group = item as Record<string, unknown>;
    const claimText = sanitize(group.claimText ?? group.claim, 300);
    const members: string[] = [];
    for (const raw of Array.isArray(group.originalClaimIds) ? group.originalClaimIds : []) {
      const id = sanitize(raw, 120);
      if (valid.has(id) && !used.has(id) && !members.includes(id)) members.push(id);
    }
    if (!claimText || members.length === 0) continue;
    for (const id of members) used.add(id);
    groups.push({ claimText, originalClaimIds: members });
  }
  for (const id of ids) if (!used.has(id)) groups.push({ claimText: "", originalClaimIds: [id] });
  return groups;
}

export type StoredClaim = ExtractedClaim & { id: string; interview: string };

/** 主題與子主題組成群組表的 key 時用的分隔字元（U+241F）。 */
export const KEY_SEPARATOR = "\u241f";

/** 把已抽取、已分群的主張組成公開的議題樹，並算人數與句數。 */
export function buildTree(
  taxonomy: Taxonomy,
  claims: StoredClaim[],
  groups: Map<string, ClaimGroup[]>,
  summaries: Map<string, string>,
  rows: SourceRow[],
  generatedAt: number,
): ReportTree {
  const claimById = new Map(claims.map((claim) => [claim.id, claim]));
  const people = (members: StoredClaim[]) => new Set(members.map((claim) => claim.interview || `#${claim.commentId}`)).size;
  const topics: ReportTopic[] = [];
  const fullTaxonomy: Taxonomy = [...taxonomy, { name: UNASSIGNED_TOPIC, description: "", subtopics: [{ name: UNASSIGNED_SUBTOPIC, description: "" }] }];
  let groupedTotal = 0;
  let unassigned = 0;
  for (const topic of fullTaxonomy) {
    const subtopics: ReportSubtopic[] = [];
    for (const subtopic of topic.subtopics) {
      const members = claims.filter((claim) => claim.topicName === topic.name && claim.subtopicName === subtopic.name);
      if (members.length === 0) continue;
      const key = `${topic.name}\u241f${subtopic.name}`;
      const groupList = groups.get(key) ?? members.map((claim) => ({ claimText: "", originalClaimIds: [claim.id] }));
      const reportClaims: ReportClaim[] = groupList
        .map((group, index) => {
          const groupMembers = group.originalClaimIds.map((id) => claimById.get(id)).filter((claim): claim is StoredClaim => Boolean(claim));
          if (groupMembers.length === 0) return null;
          const first = groupMembers[0] as StoredClaim;
          return {
            id: `${slug(topic.name)}-${slug(subtopic.name)}-${index + 1}`,
            text: group.claimText || first.claim,
            quotes: groupMembers.map((claim) => ({ text: claim.quote, interview: claim.interview, commentId: claim.commentId })),
            people: people(groupMembers),
          };
        })
        .filter((claim): claim is ReportClaim => claim !== null)
        .sort((left, right) => right.people - left.people || right.quotes.length - left.quotes.length);
      groupedTotal += reportClaims.length;
      if (topic.name === UNASSIGNED_TOPIC) unassigned += members.length;
      subtopics.push({
        name: subtopic.name,
        description: subtopic.description,
        claims: reportClaims,
        claimsCount: members.length,
        people: people(members),
      });
    }
    if (subtopics.length === 0) continue;
    const members = claims.filter((claim) => claim.topicName === topic.name);
    subtopics.sort((left, right) => right.people - left.people);
    topics.push({
      name: topic.name,
      description: topic.description,
      summary: summaries.get(topic.name) ?? "",
      subtopics,
      claimsCount: members.length,
      people: people(members),
    });
  }
  topics.sort((left, right) => (left.name === UNASSIGNED_TOPIC ? 1 : right.name === UNASSIGNED_TOPIC ? -1 : right.people - left.people));
  return {
    topics,
    stats: {
      comments: rows.length,
      people: new Set(rows.map((row) => row.interview || `#${row.id}`)).size,
      claims: claims.length,
      groupedClaims: groupedTotal,
      unassigned,
    },
    generatedAt,
  };
}

export function normalizeSummary(raw: unknown): string {
  const record = raw as { summary?: unknown; topicSummary?: unknown } | null;
  return sanitize(record?.summary ?? record?.topicSummary ?? (typeof raw === "string" ? raw : ""), 1_200);
}

export function sanitize(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  return value
    .replace(/<[^>]*>/g, "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function slug(value: string): string {
  const cleaned = value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "");
  return cleaned.slice(0, 24) || "t";
}
