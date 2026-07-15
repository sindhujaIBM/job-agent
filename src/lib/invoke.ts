import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';

const client = new LambdaClient({ region: process.env.AWS_REGION ?? 'ca-west-1' });

const STAGE = process.env.STAGE ?? 'prod';

// Each Lambda in the chain invokes the next one asynchronously.
// InvocationType: 'Event' = fire-and-forget (doesn't wait for response).
// This keeps each Lambda within its own timeout budget.
export async function invokeNext(functionName: string): Promise<void> {
  const fullName = `job-agent-${STAGE}-${functionName}`;
  console.log(`Invoking next: ${fullName}`);
  await client.send(new InvokeCommand({
    FunctionName: fullName,
    InvocationType: 'Event',
    Payload: Buffer.from('{}'),
  }));
}
