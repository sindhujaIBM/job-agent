import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';

// Bedrock is only available in certain regions — us-east-1 has the widest model support
const client = new BedrockRuntimeClient({ region: 'us-east-1' });

// Claude Haiku 4.5 via cross-region inference profile
const MODEL_ID = 'us.anthropic.claude-haiku-4-5-20251001-v1:0';

export async function invokeClaudeHaiku(prompt: string, maxTokens = 1024): Promise<string> {
  const body = JSON.stringify({
    anthropic_version: 'bedrock-2023-05-31',
    max_tokens: maxTokens,
    messages: [{ role: 'user', content: prompt }],
  });

  const command = new InvokeModelCommand({
    modelId: MODEL_ID,
    body,
    contentType: 'application/json',
    accept: 'application/json',
  });

  const response = await client.send(command);
  const decoded = JSON.parse(new TextDecoder().decode(response.body));
  return decoded.content[0].text as string;
}

export function stripJsonFences(raw: string): string {
  return raw.trim().replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim();
}
