import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import type { Person } from '../types';

const ssm = new SSMClient({ region: 'ca-west-1' });

const REPO_OWNER = 'sindhujaIBM';
const REPO_NAME = 'personal-branding';

// Reuses signal-agent's existing GitHub token rather than provisioning a second
// copy of the same credential — same repo, same scope needed (contents write + dispatch).
async function getGithubToken(): Promise<string> {
  const res = await ssm.send(new GetParameterCommand({
    Name: '/signal-agent/prod/github-token',
    WithDecryption: true,
  }));
  return res.Parameter?.Value ?? '';
}

// Deliberately does NOT pre-save a JD file. MatchedJob.description is truncated to 500
// chars (fine for scoring/email, not enough for a real resume — a real run against a
// truncated copy produced a garbled resume + cover letter). The dispatched workflow uses
// /sindhu-resume and /muni-resume's own --url mode instead, which WebFetches the live,
// full posting directly — no truncated copy in the loop at all.
export async function dispatchResumeGeneration({
  person,
  slug,
  company,
  role,
  url,
}: {
  person: Person;
  slug: string;
  company: string;
  role: string;
  url: string;
}): Promise<void> {
  const token = await getGithubToken();
  const apiUrl = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/dispatches`;

  const res = await fetch(apiUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'User-Agent': 'job-agent/1.0',
      Accept: 'application/vnd.github+json',
    },
    body: JSON.stringify({
      event_type: 'job-approved',
      client_payload: { person, slug, company, role, url },
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`GitHub dispatch error ${res.status}: ${body}`);
  }
}
