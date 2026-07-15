import { XMLParser } from 'fast-xml-parser';
import type { RawJobItem, JobSource } from '../types';

const parser = new XMLParser({ ignoreAttributes: false });

const WWR_SOURCES = [
  { name: 'We Work Remotely — Full-Stack', url: 'https://weworkremotely.com/categories/remote-full-stack-programming-jobs.rss' },
  { name: 'We Work Remotely — Programming', url: 'https://weworkremotely.com/categories/remote-programming-jobs.rss' },
  { name: 'We Work Remotely — Product', url: 'https://weworkremotely.com/categories/remote-product-jobs.rss' },
];

const REMOTEOK_URL = 'https://remoteok.com/api';
const USER_AGENT = 'job-agent/1.0 (personal job scanner; https://maidlink.ca)';

export async function fetchAllJobs(): Promise<RawJobItem[]> {
  const [wwr, remoteok] = await Promise.all([
    fetchWeWorkRemotely(),
    fetchRemoteOk(),
  ]);
  return [...wwr, ...remoteok];
}

async function fetchWeWorkRemotely(): Promise<RawJobItem[]> {
  const results: RawJobItem[] = [];

  for (const source of WWR_SOURCES) {
    try {
      const res = await fetch(source.url, {
        headers: { 'User-Agent': USER_AGENT },
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} from ${source.url}`);

      const xml = await res.text();
      const parsed = parser.parse(xml);
      const rawItems: unknown[] = parsed?.rss?.channel?.item ?? [];

      for (const raw of rawItems) {
        if (typeof raw !== 'object' || raw === null) continue;
        const item = raw as Record<string, unknown>;

        const url = String(item.link ?? '');
        const rawTitle = String(item.title ?? '');
        if (!url || !rawTitle) continue;

        // WWR titles come as "Company: Job Title"
        const splitIdx = rawTitle.indexOf(':');
        const company = splitIdx > -1 ? rawTitle.slice(0, splitIdx).trim() : 'Unknown';
        const title = splitIdx > -1 ? rawTitle.slice(splitIdx + 1).trim() : rawTitle;

        results.push({
          url,
          title,
          company,
          location: String(item.region ?? 'Remote'),
          source: 'weworkremotely',
          sourceCategory: String(item.category ?? source.name),
          description: stripHtml(String(item.description ?? '')).slice(0, 500),
          postedAt: String(item.pubDate ?? new Date().toISOString()),
        });
      }
    } catch (err) {
      console.error(`Failed to fetch ${source.name}:`, err);
      // continue with other sources — one bad feed shouldn't kill the run
    }
  }

  return results;
}

async function fetchRemoteOk(): Promise<RawJobItem[]> {
  try {
    const res = await fetch(REMOTEOK_URL, {
      headers: { 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${REMOTEOK_URL}`);

    const data = (await res.json()) as unknown[];
    // element 0 is a legal/attribution notice, not a job — skip it
    const jobs = data.slice(1);

    return jobs
      .filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null)
      .filter(item => item.url && item.position)
      .map(item => ({
        url: String(item.url),
        title: String(item.position),
        company: String(item.company ?? 'Unknown'),
        location: String(item.location || 'Remote'),
        source: 'remoteok' as JobSource,
        sourceCategory: Array.isArray(item.tags) ? (item.tags as unknown[]).slice(0, 5).join(', ') : null,
        description: stripHtml(String(item.description ?? '')).slice(0, 500),
        postedAt: String(item.date ?? new Date().toISOString()),
      }));
  } catch (err) {
    console.error('Failed to fetch RemoteOK:', err);
    return [];
  }
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}
