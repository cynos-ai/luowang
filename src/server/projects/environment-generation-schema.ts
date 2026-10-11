import { Type } from 'typebox';

const text = () => Type.String({ minLength: 1, maxLength: 2000 });
const command = () =>
  Type.Object({
    service: Type.String({ minLength: 1, maxLength: 63 }),
    command: Type.String({ minLength: 1, maxLength: 16384 }),
    timeoutSeconds: Type.Integer({ minimum: 1, maximum: 900 }),
  });

/** Native structured arguments: no JSON document encoded inside a second JSON string. */
export const environmentDefinitionSchema = Type.Object({
  summary: Type.String({ minLength: 1, maxLength: 4096 }),
  preparation: Type.Object({
    scope: text(),
    data: text(),
    account: Type.Object({
      mode: Type.Union([Type.Literal('none'), Type.Literal('provided'), Type.Literal('generated')]),
      description: text(),
    }),
    externalServices: text(),
    decisions: Type.Array(text(), { maxItems: 16 }),
    evidence: Type.Array(text(), { maxItems: 16 }),
  }),
  files: Type.Array(
    Type.Object({
      path: Type.String({ minLength: 1, maxLength: 255 }),
      content: Type.String({ maxLength: 524288 }),
    }),
    { minItems: 1, maxItems: 16 },
  ),
  runtime: Type.Object({
    workingDirectory: Type.String({ maxLength: 255 }),
    prepareCommand: Type.Array(Type.String()),
    startCommand: Type.Array(Type.String()),
    servicePort: Type.Integer({ minimum: 1, maximum: 65535 }),
    healthPath: Type.String({ maxLength: 255 }),
    healthTimeoutSeconds: Type.Integer({ minimum: 5, maximum: 600 }),
    composeFile: Type.String({ maxLength: 255 }),
    composeServices: Type.Array(Type.String(), { minItems: 1, maxItems: 32 }),
    applicationService: Type.String(),
    commandService: Type.String(),
    initializationSteps: Type.Array(command(), { maxItems: 16 }),
    preparationChecks: Type.Array(
      Type.Object({
        ...command().properties,
        kind: Type.Union([Type.Literal('data'), Type.Literal('account')]),
        label: Type.String({ minLength: 1, maxLength: 200 }),
      }),
      { maxItems: 16 },
    ),
  }),
});
