import { createHmac, randomBytes } from 'crypto';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { getMatchedJobsByStatus, updateMatchedJob } from '../lib/jobsDb';
import { sendJobDigestEmail, type DigestJob } from '../lib/ses';
import type { Person } from '../types';

const ssm = new SSMClient({ region: 'ca-west-1' });

const SINDHUJA_EMAIL = process.env.SINDHUJA_EMAIL ?? 'onvsindhu@gmail.com';
const MUNI_EMAIL = process.env.MUNI_EMAIL ?? 'munivku@gmail.com';
const BASE_URL = process.env.APPROVAL_BASE_URL ?? '';

const TOKEN_TTL_HOURS = 48;

async function getApprovalSecret(): Promise<string> {
  const res = await ssm.send(new GetParameterCommand({
    Name: '/job-agent/prod/approval-secret',
    WithDecryption: true,
  }));
  return res.Parameter?.Value ?? '';
}

function generateApprovalToken(jobId: string, person: Person, secret: string): string {
  const nonce = randomBytes(8).toString('hex');
  const payload = `${person}:${jobId}:${nonce}`;
  const sig = createHmac('sha256', secret).update(payload).digest('hex');
  return Buffer.from(`${payload}:${sig}`).toString('base64url');
}

async function notifyPerson(person: Person, email: string, secret: string): Promise<number> {
  const jobs = await getMatchedJobsByStatus(person, 'matched');
  if (jobs.length === 0) {
    console.log(`No new matches for ${person} — skipping email`);
    return 0;
  }

  const expiry = Math.floor(Date.now() / 1000) + TOKEN_TTL_HOURS * 3600;
  const digestJobs: DigestJob[] = [];

  for (const job of jobs) {
    // person + jobId are embedded in the signed token payload itself (see generateApprovalToken),
    // so the approve/reject endpoint can recover both from the token alone — no separate
    // query param to keep in sync (and no way to mismatch person against a token meant for someone else).
    const token = generateApprovalToken(job.jobId, person, secret);
    const approveUrl = `${BASE_URL}/approve-job?token=${token}`;
    const rejectUrl = `${BASE_URL}/approve-job?token=${token}&action=reject`;

    digestJobs.push({
      title: job.title,
      company: job.company,
      location: job.location,
      source: job.source,
      score: job.score,
      reason: job.reason,
      url: job.url,
      approveUrl,
      rejectUrl,
    });

    await updateMatchedJob(person, job.jobId, {
      status: 'awaiting_approval',
      approvalToken: token,
      approvalTokenExpiry: expiry,
    });
  }

  const personName = person === 'sindhuja' ? 'Sindhuja' : 'Muni';
  await sendJobDigestEmail(email, personName, digestJobs);
  console.log(`Digest sent to ${email}: ${digestJobs.length} job(s)`);
  return digestJobs.length;
}

export const handler = async (): Promise<{ sindhujaNotified: number; muniNotified: number }> => {
  const secret = await getApprovalSecret();

  const [sindhujaNotified, muniNotified] = await Promise.all([
    notifyPerson('sindhuja', SINDHUJA_EMAIL, secret).catch(err => {
      console.error('Sindhuja digest failed:', err);
      return 0;
    }),
    notifyPerson('muni', MUNI_EMAIL, secret).catch(err => {
      console.error('Muni digest failed:', err);
      return 0;
    }),
  ]);

  console.log(`Notifier complete — sindhuja: ${sindhujaNotified}, muni: ${muniNotified}`);
  return { sindhujaNotified, muniNotified };
};
