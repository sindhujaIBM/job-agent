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

// Saves the job's full description as the JD file the resume command reads (--jd, not
// --url). Tried --url (live WebFetch) first — RemoteOK blocks it with a 403 on individual
// job pages, and a job posting can also just be taken down between scan time and approval
// click. A file we already have is more reliable than a live fetch we don't control.
export async function saveJobDescriptionToRepo(slug: string, jd: string): Promise<string> {
  const token = await getGithubToken();
  const filePath = `career/output/${slug}/jd.txt`;
  const apiUrl = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/contents/${filePath}`;

  const res = await fetch(apiUrl, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'User-Agent': 'job-agent/1.0',
      Accept: 'application/vnd.github+json',
    },
    body: JSON.stringify({
      message: `job-agent: save JD for ${slug}`,
      content: Buffer.from(jd).toString('base64'),
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`GitHub API error ${res.status} saving ${filePath}: ${body}`);
  }

  return filePath;
}

export async function dispatchResumeGeneration({
  person,
  slug,
  company,
  role,
  jdPath,
  url,
}: {
  person: Person;
  slug: string;
  company: string;
  role: string;
  jdPath: string;
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
      client_payload: { person, slug, company, role, jdPath, url },
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`GitHub dispatch error ${res.status}: ${body}`);
  }
}
