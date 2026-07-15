import { createHash } from 'crypto';
import { fetchAllJobs } from '../lib/jobFeeds';
import { saveQueueItem, queueItemExists } from '../lib/jobsDb';
import { invokeNext } from '../lib/invoke';
import type { QueueItem } from '../types';

// Scratch queue TTL — short, since matched jobs are what's worth keeping (that lives
// on the person tables, written by job-evaluator). This is just dedup + staging.
const QUEUE_TTL_SECONDS = 3 * 24 * 60 * 60;

export const handler = async (): Promise<{ saved: number; skipped: number }> => {
  const ttl = Math.floor(Date.now() / 1000) + QUEUE_TTL_SECONDS;

  console.log('Scanning We Work Remotely + RemoteOK for jobs');

  const items = await fetchAllJobs();
  console.log(`Found ${items.length} raw listings across both sources`);

  let saved = 0;
  let skipped = 0;

  for (const item of items) {
    const jobId = createHash('sha256').update(item.url).digest('hex').slice(0, 16);

    const exists = await queueItemExists(jobId);
    if (exists) {
      skipped++;
      continue;
    }

    const queueItem: QueueItem = {
      jobId,
      url: item.url,
      title: item.title,
      company: item.company,
      location: item.location,
      source: item.source,
      sourceCategory: item.sourceCategory,
      description: item.description,
      postedAt: item.postedAt,
      status: 'pending_evaluation',
      ttl,
      createdAt: new Date().toISOString(),
    };

    try {
      await saveQueueItem(queueItem);
      saved++;
    } catch (err: unknown) {
      if (err instanceof Error && err.name === 'ConditionalCheckFailedException') {
        skipped++;
      } else {
        throw err;
      }
    }
  }

  console.log(`Scanner complete — saved: ${saved}, skipped (duplicates): ${skipped}`);

  if (saved > 0) {
    await invokeNext('job-evaluator');
  } else {
    console.log('No new jobs — skipping job-evaluator');
  }

  return { saved, skipped };
};
