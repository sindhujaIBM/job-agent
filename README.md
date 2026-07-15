# job-agent

A daily remote-job scanner and matcher. It pulls listings from **We Work Remotely** and **Remote OK**, scores each one against two independent fit profiles using Claude Haiku on AWS Bedrock, and emails a digest to each person when there's a match. Approving a match from the email kicks off automatic resume + cover letter generation in a companion repo — nothing is ever auto-submitted to an employer; a human always reviews the generated documents before applying.

## Data sources & attribution

Job listings are sourced from:

- **[We Work Remotely](https://weworkremotely.com/)** — via their public category RSS feeds.
- **[Remote OK](https://remoteok.com/)** — via their [public API](https://remoteok.com/api). Per Remote OK's API terms: this project links back to Remote OK and credits it by name as the source of any listing pulled from their feed, and does not use the Remote OK logo.

All matching and scoring happens on top of the metadata these two sites already make public — no scraping beyond their documented feeds/APIs, and nothing here republishes full listings anywhere public.

## How it works

```
EventBridge Scheduler (daily)
  -> job-scanner    fetch We Work Remotely + Remote OK, dedup, queue new listings
  -> job-evaluator  Claude Haiku scores each listing 0-10 for each person independently
  -> job-notifier   one digest email per person, only if they have new matches
  -> job-approver   API Gateway endpoint behind the email's Approve / Not Interested links
```

Approving a listing saves its description to a companion repo and fires a `repository_dispatch` event that triggers tailored resume/cover-letter generation there. See that repo's `career/RESUME-GENERATOR.md` for how that half works.

## Stack

Node.js 20 + TypeScript, Serverless Framework v3 (AWS Lambda), DynamoDB, SES, Bedrock (Claude Haiku), API Gateway. See `CLAUDE.md` for the full architecture, table schemas, and operational notes.

## Commands

```bash
npm install
npm run typecheck
npm run build
npm run deploy   # deploys to AWS, prod stage
```
