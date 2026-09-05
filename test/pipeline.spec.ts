import { describe, expect, it } from "vitest";
import { NeuronLedger, neuronsForPrompts, nextUtcDayStart, packItemsUtf8 } from "../src/ai-budget";
import { tryReserveDailyNeurons } from "../src/coordinator";
import { parseJsonSafe } from "../src/model";
import { UNASSIGNED_TOPIC, buildTree, clusteringPrompt, normalizeClaims, normalizeGroups, normalizeTaxonomy, type Taxonomy } from "../src/pipeline";
import type { SourceRow } from "../src/types";

const rows: SourceRow[] = [
  { seq: 0, id: "a", interview: "阿德", comment: "演習從來沒真的演過怎麼撤。" },
  { seq: 1, id: "b", interview: "Vivian", comment: "基載電力不能只靠天然氣船準時到港。" },
  { seq: 2, id: "c", interview: "", comment: "電價三年漲了快五成。" },
];

const taxonomy: Taxonomy = [
  { name: "供電", description: "", subtopics: [{ name: "基載", description: "" }, { name: "電價", description: "" }] },
  { name: "安全", description: "", subtopics: [{ name: "撤離", description: "" }] },
];

describe("pipeline normalization", () => {
  it("normalizes a taxonomy and drops duplicates and empties", () => {
    const parsed = normalizeTaxonomy({ taxonomy: [
      { topicName: "供電", topicShortDescription: "x", subtopics: [{ subtopicName: "基載" }, { subtopicName: "基載" }, { name: "電價" }] },
      { topicName: "供電", subtopics: [] },
      { topicName: "", subtopics: [] },
      { topicName: "安全", subtopics: [] },
    ] });
    expect(parsed?.map((topic) => topic.name)).toEqual(["供電", "安全"]);
    expect(parsed?.[0]?.subtopics.map((subtopic) => subtopic.name)).toEqual(["基載", "電價"]);
    expect(parsed?.[1]?.subtopics).toHaveLength(1);
    expect(normalizeTaxonomy({ taxonomy: [] })).toBeNull();
  });

  it("keeps only claims for comments in the batch and maps unknown topics to unassigned", () => {
    const claims = normalizeClaims({ claims: [
      { commentId: "a", claim: "撤離計畫應先公開", quote: "演習從來沒真的演過", topicName: "安全", subtopicName: "撤離" },
      { commentId: "b", claim: "需要基載", quote: "", topicName: "供電", subtopicName: "不存在" },
      { commentId: "zzz", claim: "幽靈", quote: "", topicName: "供電", subtopicName: "基載" },
      { commentId: "c", claim: "電價", quote: "x", topicName: "不存在", subtopicName: "" },
    ] }, taxonomy, rows);
    expect(claims.map((claim) => [claim.commentId, claim.topicName, claim.subtopicName])).toEqual([
      ["a", "安全", "撤離"],
      ["b", "供電", "基載"],
      ["c", UNASSIGNED_TOPIC, "未歸類"],
    ]);
    expect(claims[1]?.quote).toBe("基載電力不能只靠天然氣船準時到港。");
  });

  it("makes every claim id appear in exactly one group", () => {
    const groups = normalizeGroups({ groupedClaims: [
      { claimText: "合併", originalClaimIds: ["c0-1", "c1-1", "c0-1", "ghost"] },
      { claimText: "", originalClaimIds: ["c2-1"] },
    ] }, ["c0-1", "c1-1", "c2-1", "c3-1"]);
    expect(groups).toEqual([
      { claimText: "合併", originalClaimIds: ["c0-1", "c1-1"] },
      { claimText: "", originalClaimIds: ["c2-1"] },
      { claimText: "", originalClaimIds: ["c3-1"] },
    ]);
  });

  it("builds a tree with people counts, sorted by reach, unassigned last", () => {
    const claims = [
      { id: "c0-1", commentId: "a", interview: "阿德", claim: "撤離計畫應先公開", quote: "q1", topicName: "安全", subtopicName: "撤離" },
      { id: "c1-1", commentId: "b", interview: "Vivian", claim: "需要基載", quote: "q2", topicName: "供電", subtopicName: "基載" },
      { id: "c1-2", commentId: "b", interview: "Vivian", claim: "天然氣有風險", quote: "q3", topicName: "供電", subtopicName: "基載" },
      { id: "c2-1", commentId: "c", interview: "", claim: "電價太高", quote: "q4", topicName: UNASSIGNED_TOPIC, subtopicName: "未歸類" },
    ];
    const groups = new Map([["供電␟基載", [{ claimText: "供電要有基載且不能只靠天然氣", originalClaimIds: ["c1-1", "c1-2"] }]]]);
    const tree = buildTree(taxonomy, claims, groups, new Map([["供電", "摘要"]]), rows, 1);
    expect(tree.stats).toEqual({ comments: 3, people: 3, claims: 4, groupedClaims: 3, unassigned: 1 });
    expect(tree.topics.map((topic) => topic.name)).toEqual(["供電", "安全", UNASSIGNED_TOPIC]);
    const grouped = tree.topics[0]?.subtopics[0]?.claims[0];
    expect(grouped?.text).toBe("供電要有基載且不能只靠天然氣");
    expect(grouped?.people).toBe(1);
    expect(grouped?.quotes).toHaveLength(2);
    expect(tree.topics[0]?.summary).toBe("摘要");
  });

  it("packs prompts under a byte budget while keeping every id", () => {
    const packed = packItemsUtf8(rows.map((row) => ({ id: row.id, text: row.comment.repeat(50) })), 400);
    expect(packed.split("\n")).toHaveLength(3);
    expect(new TextEncoder().encode(packed).length).toBeLessThanOrEqual(400);
    expect(packed).toContain("[a] ");
    expect(clusteringPrompt("t", "", rows, 2_500)).toContain("[c] 電價");
  });

  it("parses fenced or padded JSON", () => {
    expect(parseJsonSafe('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(parseJsonSafe('Sure! {"a":[1,2]} done')).toEqual({ a: [1, 2] });
    expect(parseJsonSafe("nope")).toBeNull();
  });
});

describe("neuron budget", () => {
  it("prices calls from UTF-8 bytes and max_tokens, never string length", () => {
    const cost = neuronsForPrompts("系統", "使用者", 1_000);
    expect(cost).toBeCloseTo(((6 + 9 + 256) / 1e6) * 9091 + (1_000 / 1e6) * 27273, 6);
    const ledger = new NeuronLedger(100);
    expect(ledger.tryReserve(60)).toBe(true);
    expect(ledger.tryReserve(50)).toBe(false);
    expect(ledger.remaining()).toBe(40);
  });

  it("reserves per UTC day, fails closed on malformed state, and never refunds", () => {
    const day = Date.parse("2026-09-05T10:00:00Z");
    const first = tryReserveDailyNeurons(null, 5_000, day, 9_000);
    expect(first.ok && first.next).toEqual({ utcDay: "2026-09-05", reserved: 5_000 });
    const raw = first.ok ? JSON.stringify(first.next) : "";
    expect(tryReserveDailyNeurons(raw, 5_000, day, 9_000)).toEqual({ ok: false, remaining: 4_000 });
    const nextDay = tryReserveDailyNeurons(raw, 5_000, day + 24 * 3600 * 1000, 9_000);
    expect(nextDay.ok && nextDay.next.utcDay).toBe("2026-09-06");
    expect(tryReserveDailyNeurons("{bad", 1, day, 9_000).ok).toBe(false);
    expect(new Date(nextUtcDayStart(day)).toISOString()).toBe("2026-09-06T00:05:00.000Z");
  });
});
