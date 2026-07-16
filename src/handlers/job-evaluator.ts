import { getPendingQueueItems, deleteQueueItem, saveMatchedJob } from '../lib/jobsDb';
import { invokeClaudeHaiku, stripJsonFences } from '../lib/bedrock';
import { invokeNext } from '../lib/invoke';
import type { QueueItem, JobEvaluationResult, MatchedJob } from '../types';

const THRESHOLD = 6;
const MATCH_TTL_SECONDS = 30 * 24 * 60 * 60;

const SINDHUJA_CRITERIA = `
SINDHUJA — 14 years, Engineering Leader / Tech Lead / Full-Stack, co-founder of MaidLink (AI cleaning marketplace).
Target titles: Engineering Manager, Staff/Senior Software Engineer, Forward Deployed Engineer, AI Engineer,
Founding Engineer, Tech Lead, AI Platform/Solutions Engineer.
Core stack: TypeScript, Node.js, React, AWS serverless (Lambda, Bedrock, DynamoDB), agentic/multi-agent AI,
event-driven architecture. Player-coach — hires, mentors, ships code, owns architecture.
Tolerate, do NOT disqualify for: Python depth, Kubernetes, named LLM frameworks like LangChain/LangGraph
(she builds custom multi-agent orchestration instead).
Target comp roughly $150K+ CAD or USD equivalent. Remote or Calgary, Canada.
Score LOW for: non-technical roles, junior/entry-level titles, roles requiring on-site presence with no remote option,
pure data-science/ML-research roles with no engineering/product surface.
`.trim();

const MUNI_CRITERIA = `
MUNI — Product Manager, co-founder of MaidLink, 10+ years across distributed systems, blockchain, and AI product.
Target: "AI Product Manager" (IC) or "Senior PM, AI Products" — individual contributor level ONLY.
Good match signals: roadmap ownership, customer discovery, prioritization, go-to-market, bridges business
stakeholders and AI/engineering teams, "technical background preferred" (not required).
Score LOW / avoid for: roles requiring hands-on Python, GCP, Docker, Kubernetes, or ETL/data-pipeline engineering;
roles requiring 3+ years leading AI/ML teams; titles like "AI Engineering Manager", "Manager of AI teams",
or "Data Science Manager" (those are Sindhuja's lane, not his); any Director- or Head-of-Product-level title
(he is not targeting leadership roles externally right now).
`.trim();

const SYSTEM_CONTEXT = `
You are evaluating remote job postings for two job seekers. Score each job 0-10 for EACH person independently —
a job can be a good fit for one, both, or neither.

${SINDHUJA_CRITERIA}

${MUNI_CRITERIA}
`.trim();

// job.description is stored full-length (job-approver needs the complete text later to
// generate a real resume) — cap it here just for prompt size/cost, scoring doesn't need more.
const EVAL_DESCRIPTION_CHARS = 1500;

function buildPrompt(job: QueueItem): string {
  return `${SYSTEM_CONTEXT}

Job posting:
Title: ${job.title}
Company: ${job.company}
Location: ${job.location}
Source: ${job.source}
Description: ${job.description.slice(0, EVAL_DESCRIPTION_CHARS)}

Return ONLY valid JSON (no markdown, no explanation):
{ "sindhuja_score": number_0_to_10, "sindhuja_reason": "one sentence", "muni_score": number_0_to_10, "muni_reason": "one sentence" }`;
}

export const handler = async (): Promise<{ evaluated: number; matchedSindhuja: number; matchedMuni: number; skipped: number }> => {
  const ttl = Math.floor(Date.now() / 1000) + MATCH_TTL_SECONDS;
  const items = await getPendingQueueItems();
  console.log(`Evaluating ${items.length} queued jobs`);

  let evaluated = 0;
  let matchedSindhuja = 0;
  let matchedMuni = 0;
  let skipped = 0;

  for (const job of items) {
    try {
      const raw = await invokeClaudeHaiku(buildPrompt(job), 384);
      const result: JobEvaluationResult = JSON.parse(stripJsonFences(raw));

      const isMatchForSindhuja = result.sindhuja_score >= THRESHOLD;
      const isMatchForMuni = result.muni_score >= THRESHOLD;

      if (isMatchForSindhuja) {
        const matched: MatchedJob = {
          jobId: job.jobId,
          url: job.url,
          title: job.title,
          company: job.company,
          location: job.location,
          source: job.source,
          description: job.description,
          score: result.sindhuja_score,
          reason: result.sindhuja_reason,
          status: 'matched',
          approvalToken: null,
          approvalTokenExpiry: null,
          resumeSlug: null,
          ttl,
          createdAt: new Date().toISOString(),
        };
        await saveMatchedJob('sindhuja', matched);
        matchedSindhuja++;
        console.log(`Matched for Sindhuja (score ${result.sindhuja_score}): ${job.title} @ ${job.company}`);
      }

      if (isMatchForMuni) {
        const matched: MatchedJob = {
          jobId: job.jobId,
          url: job.url,
          title: job.title,
          company: job.company,
          location: job.location,
          source: job.source,
          description: job.description,
          score: result.muni_score,
          reason: result.muni_reason,
          status: 'matched',
          approvalToken: null,
          approvalTokenExpiry: null,
          resumeSlug: null,
          ttl,
          createdAt: new Date().toISOString(),
        };
        await saveMatchedJob('muni', matched);
        matchedMuni++;
        console.log(`Matched for Muni (score ${result.muni_score}): ${job.title} @ ${job.company}`);
      }

      if (!isMatchForSindhuja && !isMatchForMuni) skipped++;

      await deleteQueueItem(job.jobId);
      evaluated++;
    } catch (err) {
      console.error(`Evaluation failed for ${job.jobId}:`, err);
      // left in the queue as pending_evaluation — retried on next job-scanner run
    }
  }

  console.log(`Evaluator complete — evaluated: ${evaluated}, matched(sindhuja): ${matchedSindhuja}, matched(muni): ${matchedMuni}, skipped: ${skipped}`);

  if (matchedSindhuja > 0 || matchedMuni > 0) {
    await invokeNext('job-notifier');
  } else {
    console.log('No matches — skipping job-notifier');
  }

  return { evaluated, matchedSindhuja, matchedMuni, skipped };
};
