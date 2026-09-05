/**
 * Workers AI 免費額度的硬契約（@cf/google/gemma-4-26b-a4b-it）。
 *
 * 官方計價：9091 神經元 / 百萬輸入 token、27273 神經元 / 百萬輸出 token，每日免費 10,000（UTC 重置）。
 * 輸入 token 不用 string.length 估，而用 UTF-8 位元組數加上聊天模板的固定額外量當作上限；
 * 輸出一律以該次呼叫強制的 max_tokens 計。這是上限，不是精確 token 數。
 *
 * 帳本有兩層：每份報告的本地帳本（一份報告最多用掉多少），以及全部署的 UTC 日帳本（Coordinator DO）。
 * 兩層都預留成功才呼叫模型；額度用完時報告進入 waiting-budget，隔日自動續跑。
 */
export const MODEL = "@cf/google/gemma-4-26b-a4b-it" as const;
export const NEURONS_PER_M_INPUT = 9091;
export const NEURONS_PER_M_OUTPUT = 27273;
export const FREE_NEURONS_PER_DAY = 10_000;
export const DEFAULT_DAILY_CEILING = 9_000;
/** 一份報告從頭到尾最多用的神經元；超過就分天續跑。 */
export const REPORT_NEURON_CEILING = 9_000;
export const CHAT_TEMPLATE_OVERHEAD_TOKENS = 256;

export const CLUSTERING_MAX_OUTPUT_TOKENS = 2_048;
export const EXTRACTION_MAX_OUTPUT_TOKENS = 1_536;
export const GROUPING_MAX_OUTPUT_TOKENS = 1_536;
export const SUMMARY_MAX_OUTPUT_TOKENS = 768;

/** 提示詞（system+user 內容）的 UTF-8 位元組上限。 */
export const CLUSTERING_PROMPT_MAX_BYTES = 60_000;
export const EXTRACTION_PROMPT_MAX_BYTES = 12_000;
export const GROUPING_PROMPT_MAX_BYTES = 16_000;
export const SUMMARY_PROMPT_MAX_BYTES = 12_000;

export const EXTRACTION_BATCH_SIZE = 8;
export const MAX_TOPICS = 8;
export const MAX_SUBTOPICS_PER_TOPIC = 6;
/** 子主題內至少這麼多句歸納才做合併，省下對小群的呼叫。 */
export const MIN_CLAIMS_TO_GROUP = 3;
/** 一次 alarm 最多做幾次模型呼叫，避免單次執行過長。 */
export const CALLS_PER_ALARM = 4;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function utf8ByteLength(text: string): number {
  return encoder.encode(text).length;
}

export function truncateUtf8(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  const bytes = encoder.encode(text);
  if (bytes.length <= maxBytes) return text;
  let end = maxBytes;
  while (end > 0 && ((bytes[end] ?? 0) & 0b1100_0000) === 0b1000_0000) end -= 1;
  return decoder.decode(bytes.slice(0, end));
}

export function inputTokenUpperBound(systemPrompt: string, userPrompt: string): number {
  return utf8ByteLength(systemPrompt) + utf8ByteLength(userPrompt) + CHAT_TEMPLATE_OVERHEAD_TOKENS;
}

export function neuronsForCall(inputTokenUpper: number, maxOutputTokens: number): number {
  return (inputTokenUpper / 1_000_000) * NEURONS_PER_M_INPUT + (maxOutputTokens / 1_000_000) * NEURONS_PER_M_OUTPUT;
}

export function neuronsForPrompts(systemPrompt: string, userPrompt: string, maxOutputTokens: number): number {
  return neuronsForCall(inputTokenUpperBound(systemPrompt, userPrompt), maxOutputTokens);
}

/**
 * 把多則發言排進一個位元組上限：每則都保留 id，文字平均分配後截斷。
 * id 本身放不下時丟錯，呼叫端不得送出超過上限的提示詞。
 */
export function packItemsUtf8(items: { id: string; text: string }[], maxBytes: number): string {
  if (items.length === 0) return "";
  const headers = items.map((item) => `[${item.id}] `);
  const newlineBytes = items.length > 1 ? items.length - 1 : 0;
  const headerBytes = headers.reduce((total, header) => total + utf8ByteLength(header), 0) + newlineBytes;
  if (headerBytes > maxBytes) throw new Error(`packItemsUtf8: ${items.length} ids need ${headerBytes} bytes, cap is ${maxBytes}`);
  const per = Math.floor((maxBytes - headerBytes) / items.length);
  return items.map((item, index) => `${headers[index]}${per > 0 ? truncateUtf8(item.text, per) : ""}`).join("\n");
}

export class NeuronLedger {
  readonly ceiling: number;
  reserved: number;

  constructor(ceiling = REPORT_NEURON_CEILING, reserved = 0) {
    this.ceiling = ceiling;
    this.reserved = reserved;
  }

  remaining(): number {
    return this.ceiling - this.reserved;
  }

  tryReserve(neurons: number): boolean {
    if (!Number.isFinite(neurons) || neurons < 0) return false;
    if (this.reserved + neurons > this.ceiling) return false;
    this.reserved += neurons;
    return true;
  }
}

export function utcDayKey(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

/** 下一個 UTC 零點再加五分鐘：額度用完時的續跑時間。 */
export function nextUtcDayStart(now: number): number {
  const next = new Date(now);
  next.setUTCHours(24, 5, 0, 0);
  return next.getTime();
}
