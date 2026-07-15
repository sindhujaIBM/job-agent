import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, UpdateCommand, QueryCommand, ScanCommand, DeleteCommand } from '@aws-sdk/lib-dynamodb';
import type { QueueItem, MatchedJob, JobStatus, Person } from '../types';

const client = new DynamoDBClient({ region: process.env.AWS_REGION ?? 'ca-west-1' });
const db = DynamoDBDocumentClient.from(client);

const QUEUE_TABLE = process.env.QUEUE_TABLE ?? 'remote-jobs-scan-queue';

function matchTable(person: Person): string {
  return person === 'sindhuja'
    ? process.env.SINDHUJA_TABLE ?? 'remote-jobs-sindhu'
    : process.env.MUNI_TABLE ?? 'remote-jobs-muni';
}

// ── Scan queue (dedup + evaluation staging) ──────────────────────────────

export async function saveQueueItem(item: QueueItem): Promise<void> {
  await db.send(new PutCommand({
    TableName: QUEUE_TABLE,
    Item: item,
    ConditionExpression: 'attribute_not_exists(jobId)',
  }));
}

export async function queueItemExists(jobId: string): Promise<boolean> {
  const result = await db.send(new QueryCommand({
    TableName: QUEUE_TABLE,
    KeyConditionExpression: 'jobId = :id',
    ExpressionAttributeValues: { ':id': jobId },
    Limit: 1,
  }));
  return (result.Count ?? 0) > 0;
}

export async function getPendingQueueItems(): Promise<QueueItem[]> {
  const result = await db.send(new ScanCommand({
    TableName: QUEUE_TABLE,
    FilterExpression: '#s = :status',
    ExpressionAttributeNames: { '#s': 'status' },
    ExpressionAttributeValues: { ':status': 'pending_evaluation' },
  }));
  return (result.Items ?? []) as QueueItem[];
}

export async function deleteQueueItem(jobId: string): Promise<void> {
  await db.send(new DeleteCommand({ TableName: QUEUE_TABLE, Key: { jobId } }));
}

// ── Person match tables (remote-jobs-sindhu / remote-jobs-muni) ─────────

// Idempotent: if this job was already recorded for this person (e.g. re-listed by the
// board after its queue entry aged out and got re-evaluated), leave the existing row
// — including any approval/dismissed state — untouched rather than overwriting it.
export async function saveMatchedJob(person: Person, job: MatchedJob): Promise<void> {
  try {
    await db.send(new PutCommand({
      TableName: matchTable(person),
      Item: job,
      ConditionExpression: 'attribute_not_exists(jobId)',
    }));
  } catch (err: unknown) {
    if (err instanceof Error && err.name === 'ConditionalCheckFailedException') return;
    throw err;
  }
}

export async function getMatchedJobsByStatus(person: Person, status: JobStatus): Promise<MatchedJob[]> {
  const result = await db.send(new ScanCommand({
    TableName: matchTable(person),
    FilterExpression: '#s = :status',
    ExpressionAttributeNames: { '#s': 'status' },
    ExpressionAttributeValues: { ':status': status },
  }));
  return (result.Items ?? []) as MatchedJob[];
}

export async function getMatchedJobByToken(person: Person, token: string): Promise<MatchedJob | null> {
  const result = await db.send(new ScanCommand({
    TableName: matchTable(person),
    FilterExpression: 'approvalToken = :token',
    ExpressionAttributeValues: { ':token': token },
  }));
  const items = result.Items ?? [];
  return items.length > 0 ? (items[0] as MatchedJob) : null;
}

export async function updateMatchedJob(
  person: Person,
  jobId: string,
  fields: Partial<Pick<MatchedJob, 'status' | 'approvalToken' | 'approvalTokenExpiry' | 'resumeSlug'>>
): Promise<void> {
  const entries = Object.entries(fields).filter(([, v]) => v !== undefined);
  if (entries.length === 0) return;

  const ExpressionAttributeNames: Record<string, string> = {};
  const ExpressionAttributeValues: Record<string, unknown> = {};
  const setParts: string[] = [];

  for (const [key, value] of entries) {
    const nameKey = `#${key}`;
    const valueKey = `:${key}`;
    ExpressionAttributeNames[nameKey] = key;
    ExpressionAttributeValues[valueKey] = value;
    setParts.push(`${nameKey} = ${valueKey}`);
  }

  await db.send(new UpdateCommand({
    TableName: matchTable(person),
    Key: { jobId },
    UpdateExpression: `SET ${setParts.join(', ')}`,
    ExpressionAttributeNames,
    ExpressionAttributeValues,
  }));
}
