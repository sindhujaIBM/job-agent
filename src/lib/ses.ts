import { SESClient, SendEmailCommand } from '@aws-sdk/client-ses';

const client = new SESClient({ region: 'us-east-1' });

const FROM_EMAIL = 'agent@maidlink.ca';

export interface DigestJob {
  title: string;
  company: string;
  location: string;
  source: string;
  score: number;
  reason: string;
  url: string;
  approveUrl: string;
  rejectUrl: string;
}

export async function sendJobDigestEmail(to: string, personName: string, jobs: DigestJob[]): Promise<void> {
  const subject = `${jobs.length} job match${jobs.length === 1 ? '' : 'es'} today for ${personName}`;

  const sorted = [...jobs].sort((a, b) => b.score - a.score);

  const body = `
JOB MATCHES FOR ${personName.toUpperCase()}
==========================

${sorted.map((job, i) => `
${i + 1}. ${job.title} — ${job.company}
   Location: ${job.location}
   Source: ${job.source} | Score: ${job.score}/10
   ${job.reason}
   ${job.url}

   [ GENERATE RESUME + COVER LETTER ]
   ${job.approveUrl}

   [ NOT INTERESTED ]
   ${job.rejectUrl}
`.trim()).join('\n\n---\n\n')}

==========================
Approval links expire in 48 hours.
Source note: listings via We Work Remotely, Remote OK (remoteok.com), and Remotive (remotive.com).
  `.trim();

  await client.send(new SendEmailCommand({
    Source: FROM_EMAIL,
    Destination: { ToAddresses: [to] },
    Message: {
      Subject: { Data: subject, Charset: 'UTF-8' },
      Body: { Text: { Data: body, Charset: 'UTF-8' } },
    },
  }));
}
