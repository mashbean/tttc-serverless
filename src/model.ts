import { MODEL, NeuronLedger, neuronsForPrompts } from "./ai-budget";

export type PromptKind = "clustering" | "extraction" | "grouping" | "summary";

export type ModelCallResult =
  | { ok: true; text: string; neurons: number }
  | { ok: false; reason: "budget"; neurons: number }
  | { ok: false; reason: "error"; error: string };

export type GlobalReserve = (neurons: number) => Promise<boolean>;

/**
 * 呼叫模型前先在兩層帳本預留（本地報告帳本、全部署日帳本），任一失敗就不呼叫。
 * AI_MODE=fake 時回傳可預期的假結果，讓測試不需要真正的 Workers AI。
 */
export async function runModel(
  env: Env,
  kind: PromptKind,
  systemPrompt: string,
  userPrompt: string,
  maxTokens: number,
  ledger: NeuronLedger,
  reserveGlobal: GlobalReserve,
): Promise<ModelCallResult> {
  const neurons = neuronsForPrompts(systemPrompt, userPrompt, maxTokens);
  if (!ledger.tryReserve(neurons)) return { ok: false, reason: "budget", neurons };
  let granted = false;
  try {
    granted = await reserveGlobal(neurons);
  } catch (error) {
    return { ok: false, reason: "error", error: `coordinator: ${describe(error)}` };
  }
  if (!granted) return { ok: false, reason: "budget", neurons };
  if (String(env.AI_MODE) === "fake") return { ok: true, text: fakeResponse(kind, userPrompt), neurons };
  try {
    const result = await env.AI.run(MODEL, {
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      max_tokens: maxTokens,
      temperature: 0.2,
      chat_template_kwargs: { enable_thinking: false },
    } as never);
    return { ok: true, text: extractText(result), neurons };
  } catch (error) {
    return { ok: false, reason: "error", error: `model: ${describe(error)}` };
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300);
}

/** Workers AI 的回應形狀不只一種：字串、{response}、內容陣列、OpenAI 風格 choices。 */
export function extractText(result: unknown): string {
  if (typeof result === "string") return result;
  if (typeof result !== "object" || result === null) return JSON.stringify(result);
  const record = result as Record<string, unknown>;
  if (typeof record.response === "string" && record.response) return record.response;
  const fromResponse = flattenContent(record.response);
  if (fromResponse) return fromResponse;
  const fromRoot = flattenContent(result);
  if (fromRoot) return fromRoot;
  if (Array.isArray(record.choices) && record.choices.length > 0) {
    const choice = record.choices[0] as Record<string, unknown> | undefined;
    const message = choice?.message as Record<string, unknown> | undefined;
    if (typeof message?.content === "string" && message.content) return message.content;
    const fromParts = flattenContent(message?.content);
    if (fromParts) return fromParts;
  }
  return JSON.stringify(result);
}

function flattenContent(value: unknown): string {
  if (!Array.isArray(value)) return "";
  return value
    .map((part) => {
      if (typeof part === "string") return part;
      if (typeof part !== "object" || part === null) return "";
      const record = part as Record<string, unknown>;
      if (record.type === "thinking" || record.type === "reasoning") return "";
      return typeof record.text === "string" ? record.text : "";
    })
    .join("")
    .trim();
}

/** 容忍 ```json 圍欄、前後贅字；先整段解析，再抓最外層的物件或陣列。 */
export function parseJsonSafe<T>(text: string): T | null {
  if (!text || typeof text !== "string") return null;
  let clean = text.trim();
  if (clean.startsWith("```")) clean = clean.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  clean = clean.trim();
  const attempt = (slice: string): T | null => {
    try {
      return JSON.parse(slice) as T;
    } catch {
      return null;
    }
  };
  const direct = attempt(clean);
  if (direct !== null) return direct;
  const firstBrace = clean.indexOf("{");
  const lastBrace = clean.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    const object = attempt(clean.slice(firstBrace, lastBrace + 1));
    if (object !== null) return object;
  }
  const firstBracket = clean.indexOf("[");
  const lastBracket = clean.lastIndexOf("]");
  if (firstBracket >= 0 && lastBracket > firstBracket) {
    const array = attempt(clean.slice(firstBracket, lastBracket + 1));
    if (array !== null) return array;
  }
  return null;
}

/** 測試用的假模型：依提示詞裡的項目回傳合乎格式的結果。 */
function fakeResponse(kind: PromptKind, userPrompt: string): string {
  const ids = [...userPrompt.matchAll(/^\[([^\]\n]+)\] /gm)].map((match) => match[1] as string);
  if (kind === "clustering") {
    return JSON.stringify({
      taxonomy: [
        {
          topicName: "供電與成本",
          topicShortDescription: "關於電力穩定、電價與產業用電的看法。",
          subtopics: [
            { subtopicName: "基載與穩定", subtopicShortDescription: "夜間備轉、跳電風險與基載電力的討論。" },
            { subtopicName: "電價與產業", subtopicShortDescription: "電價上漲對家庭與中小企業的影響。" },
          ],
        },
        {
          topicName: "風險與核廢",
          topicShortDescription: "關於安全、地震與核廢料處置的看法。",
          subtopics: [{ subtopicName: "核廢料去向", subtopicShortDescription: "中期貯存、蘭嶼遷出與最終處置。" }],
        },
      ],
    });
  }
  if (kind === "extraction") {
    const subtopics = [
      ["供電與成本", "基載與穩定"],
      ["供電與成本", "電價與產業"],
      ["風險與核廢", "核廢料去向"],
    ];
    return JSON.stringify({
      claims: ids.map((id, index) => {
        const [topicName, subtopicName] = subtopics[index % subtopics.length] as [string, string];
        return { commentId: id, claim: `發言 ${id} 的核心主張`, quote: `發言 ${id} 的引述`, topicName, subtopicName };
      }),
    });
  }
  if (kind === "grouping") {
    const groups: { claimText: string; originalClaimIds: string[] }[] = [];
    for (let index = 0; index < ids.length; index += 2) {
      groups.push({ claimText: `合併主張 ${groups.length + 1}`, originalClaimIds: ids.slice(index, index + 2) });
    }
    return JSON.stringify({ groupedClaims: groups });
  }
  return JSON.stringify({ summary: "這個主題的發言集中在幾個彼此相關的關切，參與者從不同處境提出主張。" });
}
