export type ReportLanguage = "zh-Hant" | "en";

export type SourceRow = {
  seq: number;
  id: string;
  interview: string;
  comment: string;
};

export type Quote = {
  text: string;
  interview: string;
  commentId: string;
};

export type ReportClaim = {
  id: string;
  text: string;
  quotes: Quote[];
  /** 這句歸納涵蓋了幾位不同的發言者（interview 不同；沒有 interview 時以 commentId 計）。 */
  people: number;
};

export type ReportSubtopic = {
  name: string;
  description: string;
  claims: ReportClaim[];
  claimsCount: number;
  people: number;
};

export type ReportTopic = {
  name: string;
  description: string;
  summary: string;
  subtopics: ReportSubtopic[];
  claimsCount: number;
  people: number;
};

export type ReportStatus =
  | "queued"
  | "clustering"
  | "extracting"
  | "grouping"
  | "summarizing"
  | "ready"
  | "waiting-budget"
  | "failed"
  | "deleted";

export type ReportProgress = {
  status: ReportStatus;
  step: string;
  done: number;
  total: number;
  attempts: number;
  lastError: string;
  nextAttemptAt: number | null;
  neuronsReserved: number;
};

export type ReportSummary = {
  reportId: string;
  title: string;
  description: string;
  language: ReportLanguage;
  createdAt: number;
  updatedAt: number;
  rows: number;
  progress: ReportProgress;
  model: string;
};

export type ReportTree = {
  topics: ReportTopic[];
  stats: {
    comments: number;
    people: number;
    claims: number;
    groupedClaims: number;
    unassigned: number;
  };
  generatedAt: number;
};

export type PublicReport = ReportSummary & { tree: ReportTree | null };
