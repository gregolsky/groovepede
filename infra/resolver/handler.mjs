/**
 * Groovepede Resolver Proxy — AWS Lambda adapter.
 *
 * Thin adapter over resolver-core.mjs: parses the Lambda Function URL event,
 * provides a DynamoDB-backed cache, and maps the core result to a Function URL
 * response. All resolve logic (token verify, CORS, allowlist, Odesli) lives in
 * the shared core so the self-hosted Pi server (infra/resolver-pi) reuses it.
 *
 * Security:
 *  - x-gp-token is verified in the core (ECDSA-P256, 5-min window, URL-bound).
 *  - Function URL AuthType: AWS_IAM means only CloudFront OAC can invoke us.
 *  - WAF at the edge pre-filters malformed tokens on cache misses.
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { resolveRequest } from './resolver-core.mjs';

const ddb   = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const TABLE = process.env.CACHE_TABLE;

// DynamoDB cache adapter — items carry a numeric `exp` for TTL expiry.
const cache = {
  async get(k) {
    const hit = await ddb.send(new GetCommand({ TableName: TABLE, Key: { k } }));
    return hit.Item?.body ?? null;
  },
  async put(k, body, ttlS) {
    await ddb.send(new PutCommand({
      TableName: TABLE,
      Item: { k, body, exp: Math.floor(Date.now() / 1000) + ttlS },
    }));
  },
};

export const handler = async (event) => {
  // Lambda Function URL sends headers as lowercase keys.
  const q = event.queryStringParameters || {};
  const { statusCode, headers, body } = await resolveRequest({
    method: event.requestContext?.http?.method ?? 'GET',
    origin: event.headers?.origin ?? '',
    url:    q.url ?? '',
    cc:     q.userCountry || 'US',
    token:  event.headers?.['x-gp-token'] ?? '',
    cache,
  });

  return { statusCode, headers, body: body == null ? '' : JSON.stringify(body) };
};
