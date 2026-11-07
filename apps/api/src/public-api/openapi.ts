import { applyDecorators, HttpStatus } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  ApiBody,
  ApiParam,
  ApiQuery,
  ApiResponse,
  DocumentBuilder,
  SwaggerModule,
} from '@nestjs/swagger';
import { API_SCOPES, publicErrorSchema } from '@wacrm/shared';
import { z } from 'zod';
import { PublicApiModule } from './public-api.module';

type JsonSchema = Record<string, unknown> & { properties?: Record<string, JsonSchema> };

/** The same Zod schemas that validate the requests describe them, so the docs cannot drift. */
function jsonSchema(schema: z.ZodType, io: 'input' | 'output'): JsonSchema {
  const json = z.toJSONSchema(schema, { io, unrepresentable: 'any' }) as JsonSchema;
  delete json.$schema;
  return json;
}

const ERRORS = [
  [400, 'The input is not valid'],
  [401, 'The API key is missing, wrong, expired or revoked'],
  [402, 'The workspace’s plan does not include this, or a limit was reached'],
  [403, 'The API key does not have the scope for this'],
  [404, 'Not found, or belongs to another workspace'],
  [409, 'Not possible right now, such as a closed 24-hour window or no consent'],
  [429, 'Too many requests for this API key'],
] as const;

export function Documented(spec: {
  params?: z.ZodObject;
  query?: z.ZodObject;
  body?: z.ZodType;
  response: z.ZodType;
  status?: number;
}) {
  const decorators: MethodDecorator[] = [
    ApiResponse({
      status: spec.status ?? HttpStatus.OK,
      schema: jsonSchema(spec.response, 'output'),
    }),
    ...ERRORS.map(([status, description]) =>
      ApiResponse({ status, description, schema: jsonSchema(publicErrorSchema, 'output') }),
    ),
  ];
  if (spec.body) decorators.push(ApiBody({ schema: jsonSchema(spec.body, 'input') }));
  for (const name of Object.keys(spec.params?.shape ?? {})) {
    decorators.push(ApiParam({ name, schema: { type: 'string', format: 'uuid' } }));
  }
  if (spec.query) {
    const schema = jsonSchema(spec.query, 'input');
    const required = (schema.required as string[] | undefined) ?? [];
    for (const [name, property] of Object.entries(schema.properties ?? {})) {
      decorators.push(
        ApiQuery({
          name,
          required: required.includes(name),
          schema: property,
          ...(typeof property.description === 'string'
            ? { description: property.description }
            : {}),
        }),
      );
    }
  }
  return applyDecorators(...decorators);
}

/** Generated from the /v1 controllers. The document is public: it describes no customer's data. */
export function setupOpenApi(app: NestFastifyApplication): void {
  const config = new DocumentBuilder()
    .setTitle('WhatsApp CRM API')
    .setVersion('1')
    .setDescription(
      [
        'Authenticate with an API key from Settings > API keys: `Authorization: Bearer wak_...`.',
        '',
        `Scopes: ${API_SCOPES.join(', ')}.`,
        '',
        'Lists use cursor pagination: pass `nextCursor` back as `cursor`. Rate limits are per key, ' +
          'reported in `X-RateLimit-Limit` and `X-RateLimit-Remaining`.',
        '',
        'Webhooks are signed: `X-Wacrm-Signature: t=<unix seconds>,v1=<hex>`, an HMAC-SHA256 of ' +
          '`<t>.<raw body>` using the endpoint’s secret. Reject old timestamps, and dedupe on ' +
          '`X-Wacrm-Event-Id`, since delivery is at least once.',
      ].join('\n'),
    )
    .addBearerAuth({ type: 'http', scheme: 'bearer', bearerFormat: 'wak_...' })
    .build();
  const document = SwaggerModule.createDocument(app, config, { include: [PublicApiModule] });
  SwaggerModule.setup('v1/docs', app, document, { jsonDocumentUrl: 'v1/openapi.json' });
}
