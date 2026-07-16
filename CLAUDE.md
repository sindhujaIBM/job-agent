# CLAUDE.md — Job Agent

## What This Is
A cloud-based daily job-matching agent that runs on AWS. It scans We Work Remotely, RemoteOK, and Remotive, scores each listing against Sindhuja's and Muni's individual fit criteria using Claude Haiku on Bedrock, and emails each of them their own digest. Clicking "Generate Resume + Cover Letter" in the email triggers a GitHub Actions workflow in the `Personal Branding` repo that runs the real `/sindhu-resume` or `/muni-resume` slash command against that job — nothing is auto-submitted anywhere; the human still reviews the PDF before applying.

Sibling project to `signal-agent` (same account, same conventions) — see that repo's CLAUDE.md for the news/LinkedIn-draft pipeline this one is modeled on.

## Stack
- **Runtime:** Node.js 20 + TypeScript strict mode
- **Infra:** Serverless Framework v3 — deploys to AWS Lambda
- **Region:** ca-west-1
- **AI:** Claude Haiku via AWS Bedrock (no Anthropic API key — uses IAM role)
- **DB:** DynamoDB — three tables, see below
- **Email:** SES — verified Gmail identities (same `agent@maidlink.ca` sender as signal-agent)
- **Scheduler:** EventBridge Scheduler — daily 7:30am MT
- **Approval → resume generation:** API Gateway → job-approver Lambda → GitHub Contents API (save JD) + `repository_dispatch` → GitHub Actions workflow in `Personal Branding` repo runs the actual resume slash command

## Architecture (4 Lambdas)
```
EventBridge Scheduler (7:30am MT daily)
  → job-scanner    — fetch WWR RSS + RemoteOK API + Remotive API, dedup, save new jobs to remote-jobs-scan-queue
  → job-evaluator  — Claude scores each job 0-10 for Sindhuja AND Muni in one call
                      writes a row to remote-jobs-sindhu / remote-jobs-muni for each score >= 6
  → job-notifier   — one digest email per person (only if they have new matches), each job has
                      an Approve link and a Not Interested link
  → job-approver   — API Gateway endpoint hit by the email links:
                        reject  → marks the job dismissed, done
                        approve → saves the JD to Personal Branding's career/output/{slug}/jd.txt,
                                  fires repository_dispatch(job-approved), marks the job approved
```

## DynamoDB tables
- **`remote-jobs-scan-queue`** — every listing seen by job-scanner, `pending_evaluation` until job-evaluator drains it (then deleted). 3-day TTL — pure scratch space, nothing worth keeping lives here.
- **`remote-jobs-sindhu`** / **`remote-jobs-muni`** — one row per job that scored >=6 for that person. `status`: `matched` → `awaiting_approval` (emailed) → `approved` (resume dispatched) → `resume_ready` (set by the GitHub Actions workflow once it commits the PDFs) or `dismissed`. 30-day TTL.

## Email Routing
- Sindhuja matches → onvsindhu@gmail.com
- Muni matches → munivku@gmail.com
- Never a combined email — always one digest per person, per day, only if they have new matches.

## Key Files
| File | Purpose |
|---|---|
| `src/lib/jobFeeds.ts` | Fetch + normalize We Work Remotely RSS, RemoteOK API, and Remotive API |
| `src/lib/jobsDb.ts` | DynamoDB helpers for all three tables |
| `src/lib/bedrock.ts` | Claude Haiku via Bedrock, dual-score prompt |
| `src/lib/ses.ts` | Digest email (approve/reject links per job) |
| `src/lib/github.ts` | Save JD + fire `repository_dispatch` to Personal Branding repo |
| `src/types.ts` | Shared types |
| `src/handlers/job-scanner.ts` | Lambda 1 |
| `src/handlers/job-evaluator.ts` | Lambda 2 |
| `src/handlers/job-notifier.ts` | Lambda 3 |
| `src/handlers/job-approver.ts` | Lambda 4 (API Gateway) |

## Guardrails
- Score < 6 → job never stored in either person table, never emailed
- No daily cap — this is a digest, not a content-drafting queue
- Approval token expires after 48 hours; person + jobId are embedded in the signed token itself (no separate query param to tamper with)
- Nothing is auto-submitted to any job board — approval only generates documents for human review
- Idempotent match writes — a job re-evaluated after its queue entry ages out won't overwrite an existing approved/dismissed row

## SSM Secrets
- `/job-agent/prod/approval-secret` — HMAC secret for signing approval tokens (own secret, generated fresh)
- `/signal-agent/prod/github-token` — **reused** from signal-agent (same repo, same required scope) rather than duplicated

## Common Commands
```bash
npm run dev          # typecheck in watch mode
npm run build         # compile TypeScript
npm run deploy        # deploy to AWS (prod stage)
npx sls invoke -f job-scanner --stage prod    # manually trigger scanner
npx sls invoke -f job-evaluator --stage prod  # manually trigger evaluator
npx sls logs -f job-scanner --stage prod      # tail logs
```

## Learning Notes (AWS Console locations)
After each deployment step, check:
- **DynamoDB:** DynamoDB → Tables → remote-jobs-scan-queue / remote-jobs-sindhu / remote-jobs-muni
- **Lambdas:** Lambda → Functions → find job-agent-* → Test tab
- **SES:** SES → Verified identities (should already show both Gmails, verified by signal-agent)
- **EventBridge:** EventBridge → Scheduler → job-agent-daily-scan
- **Logs:** CloudWatch → Log groups → /aws/lambda/job-agent-*
- **API Gateway:** API Gateway → job-agent → Stages → prod

## The other half of this pipeline

The resume/cover-letter generation itself does **not** live here — it's the existing `/sindhu-resume` and `/muni-resume` slash commands in the `Personal Branding` repo, triggered via a `.github/workflows/generate-resume.yml` GitHub Actions workflow that fires on the `job-approved` `repository_dispatch` event this repo sends. See that repo's `CLAUDE.md` and `career/RESUME-GENERATOR.md` for how that side works.
