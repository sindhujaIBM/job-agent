import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { createHmac } from 'crypto';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { getMatchedJobByToken, updateMatchedJob } from '../lib/jobsDb';
import { dispatchResumeGeneration } from '../lib/github';
import type { Person } from '../types';

const ssm = new SSMClient({ region: 'ca-west-1' });

async function getApprovalSecret(): Promise<string> {
  const res = await ssm.send(new GetParameterCommand({
    Name: '/job-agent/prod/approval-secret',
    WithDecryption: true,
  }));
  return res.Parameter?.Value ?? '';
}

// Token payload is `${person}:${jobId}:${nonce}` — decoding it (after verifying the
// signature) recovers which person and which job this link is for, so there's no
// separate query param that could be tampered with independently of the signed token.
function decodeToken(token: string, secret: string): { person: Person; jobId: string } | null {
  try {
    const decoded = Buffer.from(token, 'base64url').toString('utf-8');
    const lastColon = decoded.lastIndexOf(':');
    const payload = decoded.slice(0, lastColon);
    const providedSig = decoded.slice(lastColon + 1);
    const expectedSig = createHmac('sha256', secret).update(payload).digest('hex');
    if (providedSig !== expectedSig) return null;

    const [person, jobId] = payload.split(':');
    if (person !== 'sindhuja' && person !== 'muni') return null;
    if (!jobId) return null;
    return { person, jobId };
  } catch {
    return null;
  }
}

function slugify(company: string): string {
  return company.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 60) || 'unknown';
}

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  const token = event.queryStringParameters?.token;
  if (!token) return html(400, 'Missing approval token.');

  const secret = await getApprovalSecret();
  const decoded = decodeToken(token, secret);
  if (!decoded) return html(400, 'Invalid approval token.');

  const { person, jobId } = decoded;
  const personName = person === 'sindhuja' ? 'Sindhuja' : 'Muni';

  const job = await getMatchedJobByToken(person, token);
  if (!job) return html(404, 'Job not found. It may have already been actioned or the link is stale.');

  if (job.approvalTokenExpiry && Date.now() / 1000 > job.approvalTokenExpiry) {
    return html(400, 'This approval link has expired (48 hour limit).');
  }

  const action = event.queryStringParameters?.action ?? 'approve';

  if (action === 'reject') {
    if (job.status === 'dismissed') {
      return html(200, `Already marked not interested: "${job.title}" @ ${job.company}.`);
    }
    await updateMatchedJob(person, jobId, { status: 'dismissed' });
    console.log(`Dismissed for ${person}: ${jobId}`);
    return html(200, `Got it — "<strong>${job.title}</strong>" @ ${job.company} won't be actioned further.`);
  }

  if (job.status === 'approved' || job.status === 'resume_ready') {
    return html(200, `Already approved: "${job.title}" @ ${job.company}. Check your email for the resume-ready notice.`);
  }

  const slug = slugify(job.company);

  try {
    await dispatchResumeGeneration({ person, slug, company: job.company, role: job.title, url: job.url });
  } catch (err) {
    console.error(`Failed to kick off resume generation for ${jobId}:`, err);
    return html(500, `Approved, but couldn't start resume generation automatically. Run <code>/${person === 'sindhuja' ? 'sindhu' : 'muni'}-resume</code> manually with this job's JD.`);
  }

  await updateMatchedJob(person, jobId, { status: 'approved', resumeSlug: slug });

  console.log(`Approved for ${personName}, resume generation dispatched: ${slug}`);

  return html(200, `
    <strong>Approved.</strong><br/><br/>
    "${job.title}" @ ${job.company}<br/><br/>
    Generating your tailored resume and cover letter now — you'll get an email when it's ready
    (usually a few minutes). Nothing gets submitted automatically; you'll review the PDF before applying.
  `);
};

function html(statusCode: number, body: string): APIGatewayProxyResult {
  return {
    statusCode,
    headers: { 'Content-Type': 'text/html' },
    body: `<!DOCTYPE html><html><body style="font-family:sans-serif;max-width:600px;margin:40px auto;padding:0 20px">${body}</body></html>`,
  };
}
