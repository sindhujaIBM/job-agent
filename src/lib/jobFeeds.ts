import { XMLParser } from 'fast-xml-parser';
import type { RawJobItem, JobSource } from '../types';

// processEntities as an object (not the `true` shorthand) raises fast-xml-parser's default
// entity-expansion limit from 1000 to Infinity — WWR's HTML-rich job descriptions routinely
// exceed 1000 entities and were silently failing (caught by the per-source try/catch below,
// so this had been returning zero WWR jobs this whole time without ever surfacing an error).
const parser = new XMLParser({ ignoreAttributes: false, processEntities: {} });

const WWR_SOURCES = [
  { name: 'We Work Remotely — Full-Stack', url: 'https://weworkremotely.com/categories/remote-full-stack-programming-jobs.rss' },
  { name: 'We Work Remotely — Programming', url: 'https://weworkremotely.com/categories/remote-programming-jobs.rss' },
  { name: 'We Work Remotely — Product', url: 'https://weworkremotely.com/categories/remote-product-jobs.rss' },
];

const REMOTEOK_URL = 'https://remoteok.com/api';
// category= is silently ignored by the public endpoint (confirmed: filtered and
// unfiltered calls return the identical job set) — pull everything and let the
// evaluator's scoring pass do the real filtering, same as RemoteOK's unsorted feed.
const REMOTIVE_URL = 'https://remotive.com/api/remote-jobs';
const USER_AGENT = 'job-agent/1.0 (personal job scanner; https://maidlink.ca)';

// Calgary-based (or Calgary-office) companies whose career pages run on Greenhouse or
// Lever — both platforms publish genuinely public, documented JSON APIs meant for exactly
// this kind of aggregation (no ToS risk, no scraping, no login/session involved at all,
// unlike LinkedIn/Indeed/Glassdoor which explicitly prohibit this and actively enforce
// against it). Slugs can't be reliably guessed from a company name — each one here was
// confirmed by hand. Add more by finding a company's real careers page and checking
// whether it's hosted on job-boards.greenhouse.io/{slug} or jobs.lever.co/{slug}.
interface CompanyBoard {
  name: string;
  platform: 'greenhouse' | 'lever';
  slug: string;
}

const CALGARY_COMPANIES: CompanyBoard[] = [
  { name: 'AltaML', platform: 'lever', slug: 'altaml' },
  { name: 'Attabotics', platform: 'lever', slug: 'attabotics' },
  { name: 'Critical Mass', platform: 'greenhouse', slug: 'criticalmass' },
  { name: 'Orennia', platform: 'greenhouse', slug: 'orennia' },
  { name: 'OneVest', platform: 'greenhouse', slug: 'onevest' },
  { name: 'StackAdapt', platform: 'greenhouse', slug: 'stackadapt' },
  { name: 'Fullscript', platform: 'lever', slug: 'fullscript' },
  { name: 'Promise Robotics', platform: 'lever', slug: 'promiserobotics' },
];

export async function fetchAllJobs(): Promise<RawJobItem[]> {
  const [wwr, remoteok, remotive, companyBoards] = await Promise.all([
    fetchWeWorkRemotely(),
    fetchRemoteOk(),
    fetchRemotive(),
    fetchCompanyBoards(),
  ]);
  return [...wwr, ...remoteok, ...remotive, ...companyBoards];
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
          // Full text, not truncated here — this is the only copy of the JD job-approver
          // will have to work with later (RemoteOK blocks WebFetch on individual job pages
          // with a 403, so re-fetching live at approval time isn't reliable). Truncate only
          // at specific call sites that need a shorter version (e.g. the evaluation prompt).
          description: stripHtml(String(item.description ?? '')),
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
        description: stripHtml(String(item.description ?? '')),
        postedAt: String(item.date ?? new Date().toISOString()),
      }));
  } catch (err) {
    console.error('Failed to fetch RemoteOK:', err);
    return [];
  }
}

async function fetchRemotive(): Promise<RawJobItem[]> {
  try {
    const res = await fetch(REMOTIVE_URL, {
      headers: { 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${REMOTIVE_URL}`);

    const data = (await res.json()) as { jobs?: unknown[] };
    const jobs = data.jobs ?? [];

    return jobs
      .filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null)
      .filter(item => item.url && item.title)
      .map(item => ({
        url: String(item.url),
        title: String(item.title),
        company: String(item.company_name ?? 'Unknown'),
        location: String(item.candidate_required_location || 'Remote'),
        source: 'remotive' as JobSource,
        sourceCategory: item.category ? String(item.category) : null,
        description: stripHtml(String(item.description ?? '')),
        postedAt: String(item.publication_date ?? new Date().toISOString()),
      }));
  } catch (err) {
    console.error('Failed to fetch Remotive:', err);
    return [];
  }
}

async function fetchCompanyBoards(): Promise<RawJobItem[]> {
  const results = await Promise.all(
    CALGARY_COMPANIES.map(company =>
      (company.platform === 'greenhouse' ? fetchGreenhouseBoard(company) : fetchLeverBoard(company)).catch(err => {
        console.error(`Failed to fetch ${company.name}:`, err);
        return [];
      })
    )
  );
  return results.flat();
}

async function fetchGreenhouseBoard(company: CompanyBoard): Promise<RawJobItem[]> {
  // content=true — the default list response omits the job description entirely
  const url = `https://boards-api.greenhouse.io/v1/boards/${company.slug}/jobs?content=true`;
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);

  const data = (await res.json()) as { jobs?: unknown[] };
  const jobs = data.jobs ?? [];

  return jobs
    .filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null)
    .map(item => {
      const location = String((item.location as { name?: string } | undefined)?.name ?? '').trim();
      return { item, location };
    })
    .filter(({ location }) => location.toLowerCase().includes('calgary'))
    .map(({ item, location }) => ({
      url: String(item.absolute_url ?? ''),
      title: String(item.title ?? ''),
      company: company.name,
      location,
      source: 'companyboard' as JobSource,
      sourceCategory: company.name,
      description: stripHtml(String(item.content ?? '')),
      postedAt: String(item.updated_at ?? new Date().toISOString()),
    }))
    .filter(job => job.url && job.title);
}

async function fetchLeverBoard(company: CompanyBoard): Promise<RawJobItem[]> {
  const url = `https://api.lever.co/v0/postings/${company.slug}?mode=json`;
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);

  const jobs = (await res.json()) as unknown[];

  return jobs
    .filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null)
    .filter(item => {
      const categories = item.categories as { location?: string; allLocations?: unknown[] } | undefined;
      // allLocations catches multi-location postings where Calgary is an option but not
      // the primary listed location (e.g. AltaML's roles often list Edmonton first)
      const allLocations = Array.isArray(categories?.allLocations) ? categories.allLocations : [];
      const mentionsCalgary = [categories?.location, ...allLocations].some(l => String(l ?? '').toLowerCase().includes('calgary'));
      return mentionsCalgary;
    })
    .map(item => {
      const categories = item.categories as { location?: string } | undefined;
      return {
        url: String(item.hostedUrl ?? ''),
        title: String(item.text ?? ''),
        company: company.name,
        location: categories?.location ?? 'Calgary',
        source: 'companyboard' as JobSource,
        sourceCategory: company.name,
        description: stripHtml(String(item.descriptionPlain ?? item.description ?? '')),
        postedAt: String(item.createdAt ?? new Date().toISOString()),
      };
    })
    .filter(job => job.url && job.title);
}

const HTML_ENTITIES: Record<string, string> = {
  '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&nbsp;': ' ', '&apos;': "'",
};

function stripHtml(html: string): string {
  const decoded = html.replace(/&amp;|&lt;|&gt;|&quot;|&#39;|&nbsp;|&apos;/g, m => HTML_ENTITIES[m]);
  return decoded.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}
