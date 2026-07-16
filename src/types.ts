export type Person = 'sindhuja' | 'muni';

export type JobSource = 'weworkremotely' | 'remoteok' | 'remotive';

// Status on the two person-scoped match tables (remote-jobs-sindhu / remote-jobs-muni)
export type JobStatus =
  | 'matched'
  | 'awaiting_approval'
  | 'approved'
  | 'resume_ready'
  | 'dismissed';

// Status on the scratch scan-queue table (remote-jobs-scan-queue)
export type QueueStatus = 'pending_evaluation';

// A raw, normalized listing pulled from a job board — not yet scored or stored.
export interface RawJobItem {
  url: string;
  title: string;
  company: string;
  location: string;
  source: JobSource;
  sourceCategory: string | null;
  description: string;
  postedAt: string;
}

// One row in remote-jobs-scan-queue — dedup + evaluation staging, short TTL.
export interface QueueItem {
  jobId: string;         // sha256(url).slice(0, 16) — primary key
  url: string;
  title: string;
  company: string;
  location: string;
  source: JobSource;
  sourceCategory: string | null;
  description: string;
  postedAt: string;
  status: QueueStatus;
  ttl: number;
  createdAt: string;
}

// One row in remote-jobs-sindhu or remote-jobs-muni — a job that scored >= threshold for that person.
export interface MatchedJob {
  jobId: string;          // sha256(url).slice(0, 16) — primary key, same id as the queue item it came from
  url: string;
  title: string;
  company: string;
  location: string;
  source: JobSource;
  description: string;
  score: number;
  reason: string;
  status: JobStatus;
  approvalToken: string | null;
  approvalTokenExpiry: number | null; // unix timestamp
  resumeSlug: string | null;          // company slug used for career/output/{slug} once approved
  ttl: number;
  createdAt: string;
}

export interface JobEvaluationResult {
  sindhuja_score: number;
  sindhuja_reason: string;
  muni_score: number;
  muni_reason: string;
}
