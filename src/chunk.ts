/**
 * Перетворення OpenAPI-специфікації на текстові чанки для пошуку.
 *
 * Один чанк = одна самодостатня одиниця, яку не соромно віддати моделі як
 * контекст: або цілий ендпоїнт з розкритими схемами, або іменована схема.
 * Ріжемо саме так, а не по N символів, бо межа "один ендпоїнт" тут природна —
 * розрив посередині опису тіла запиту зробив би чанк марним.
 */
import type { OpenApiSpec } from "./specs.ts";

export interface Chunk {
  id: string;
  /** "personal" | "acquiring" */
  spec: string;
  kind: "endpoint" | "schema";
  title: string;
  /** Повний текст — іде в контекст моделі. */
  text: string;
  /**
   * Скорочений текст — іде в ембединг.
   *
   * Перша версія індексувала `text` цілком, і пошук промахувався: у чанку
   * ендпоїнта опис займає два рядки, а розкрита схема — сорок, тож вектор
   * описував переважно назви полів, а не призначення методу. На питання
   * "як створити рахунок" invoice/create не потрапляв навіть у топ-3.
   * Тепер ембединг рахується по призначенню + іменах полів верхнього рівня.
   */
  embedText: string;
}

const HTTP_METHODS = ["get", "post", "put", "patch", "delete"] as const;

/** Максимальна глибина розкриття $ref — захист від рекурсивних схем. */
const MAX_DEPTH = 4;

type Json = Record<string, any>;

function resolveRef(spec: OpenApiSpec, ref: string): Json | undefined {
  // Підтримуємо лише локальні посилання виду #/components/schemas/Name
  if (!ref.startsWith("#/")) return undefined;
  let node: any = spec;
  for (const part of ref.slice(2).split("/")) {
    node = node?.[part];
    if (node === undefined) return undefined;
  }
  return node as Json;
}

/** Рекурсивно описує схему як відступований список полів. */
function describeSchema(
  spec: OpenApiSpec,
  schema: Json | undefined,
  depth = 0,
  seen: ReadonlySet<string> = new Set(),
): string {
  if (!schema || depth > MAX_DEPTH) return "";

  if (typeof schema.$ref === "string") {
    const ref: string = schema.$ref;
    if (seen.has(ref)) return `${"  ".repeat(depth)}(рекурсія → ${ref.split("/").pop()})`;
    const resolved = resolveRef(spec, ref);
    return describeSchema(spec, resolved, depth, new Set([...seen, ref]));
  }

  const pad = "  ".repeat(depth);
  const lines: string[] = [];

  for (const key of ["allOf", "oneOf", "anyOf"] as const) {
    const variants = schema[key];
    if (Array.isArray(variants)) {
      for (const variant of variants) {
        const nested = describeSchema(spec, variant, depth, seen);
        if (nested) lines.push(nested);
      }
    }
  }

  if (schema.type === "array" && schema.items) {
    lines.push(`${pad}масив з:`);
    const nested = describeSchema(spec, schema.items, depth + 1, seen);
    if (nested) lines.push(nested);
    return lines.join("\n");
  }

  const properties = schema.properties as Json | undefined;
  if (properties) {
    const required = new Set<string>(
      Array.isArray(schema.required) ? (schema.required as string[]) : [],
    );

    for (const [name, rawValue] of Object.entries(properties)) {
      const value = (
        typeof rawValue?.$ref === "string" ? resolveRef(spec, rawValue.$ref) ?? rawValue : rawValue
      ) as Json;

      const bits = [`${pad}- ${name}`];
      if (value.type) bits.push(`(${value.type})`);
      if (required.has(name)) bits.push("[обовʼязкове]");
      if (value.description) bits.push(`— ${String(value.description).replace(/\s+/g, " ")}`);
      if (value.example !== undefined) bits.push(`; приклад: ${JSON.stringify(value.example)}`);
      if (Array.isArray(value.enum)) bits.push(`; допустимі: ${value.enum.join(", ")}`);
      lines.push(bits.join(" "));

      const isContainer = value.properties || (value.type === "array" && value.items);
      if (isContainer && depth < MAX_DEPTH) {
        const nested = describeSchema(
          spec,
          value,
          depth + 1,
          typeof rawValue?.$ref === "string" ? new Set([...seen, rawValue.$ref]) : seen,
        );
        if (nested) lines.push(nested);
      }
    }
  } else if (schema.type && lines.length === 0) {
    const bits = [`${pad}${schema.type}`];
    if (schema.description) bits.push(`— ${String(schema.description).replace(/\s+/g, " ")}`);
    lines.push(bits.join(" "));
  }

  return lines.join("\n");
}

function describeBody(spec: OpenApiSpec, body: Json | undefined): string {
  const content = body?.content as Json | undefined;
  if (!content) return "";

  const out: string[] = [];
  for (const [mediaType, media] of Object.entries(content)) {
    out.push(`Тіло запиту (${mediaType}):`);
    const described = describeSchema(spec, (media as Json).schema, 1);
    out.push(described || "  (без опису полів)");
  }
  return out.join("\n");
}

function describeResponses(spec: OpenApiSpec, responses: Json | undefined): string {
  if (!responses) return "";

  const out: string[] = ["Відповіді:"];
  for (const [code, rawResponse] of Object.entries(responses)) {
    const response = rawResponse as Json;
    out.push(`  ${code} — ${response.description ?? ""}`.trimEnd());

    const content = response.content as Json | undefined;
    const media = content?.["application/json"];
    if (media?.schema) {
      const described = describeSchema(spec, media.schema, 2);
      if (described) out.push(described);
    }
  }
  return out.join("\n");
}

function describeParameters(spec: OpenApiSpec, parameters: unknown): string {
  if (!Array.isArray(parameters) || parameters.length === 0) return "";

  const out: string[] = ["Параметри:"];
  for (const rawParameter of parameters) {
    const parameter = (
      typeof rawParameter?.$ref === "string"
        ? resolveRef(spec, rawParameter.$ref) ?? rawParameter
        : rawParameter
    ) as Json;

    const bits = [`  - ${parameter.name} (in: ${parameter.in})`];
    if (parameter.required) bits.push("[обовʼязковий]");
    if (parameter.schema?.type) bits.push(`тип ${parameter.schema.type}`);
    if (parameter.description) bits.push(`— ${String(parameter.description).replace(/\s+/g, " ")}`);
    if (parameter.example !== undefined) bits.push(`; приклад: ${JSON.stringify(parameter.example)}`);
    out.push(bits.join(" "));
  }
  return out.join("\n");
}

/** Імена полів верхнього рівня — те, чим користувач реально називає сутність. */
function topLevelFieldNames(spec: OpenApiSpec, schema: Json | undefined, depth = 0): string[] {
  if (!schema || depth > 2) return [];

  if (typeof schema.$ref === "string") {
    return topLevelFieldNames(spec, resolveRef(spec, schema.$ref), depth + 1);
  }
  if (schema.type === "array" && schema.items) {
    return topLevelFieldNames(spec, schema.items, depth + 1);
  }
  if (schema.properties) return Object.keys(schema.properties as Json);

  for (const key of ["allOf", "oneOf", "anyOf"] as const) {
    if (Array.isArray(schema[key])) {
      return schema[key].flatMap((variant: Json) => topLevelFieldNames(spec, variant, depth + 1));
    }
  }
  return [];
}

export function chunkSpec(specName: string, spec: OpenApiSpec): Chunk[] {
  const chunks: Chunk[] = [];
  const baseUrl = spec.servers?.[0]?.url ?? "https://api.monobank.ua";

  for (const [route, rawOperations] of Object.entries(spec.paths ?? {})) {
    const operations = rawOperations as Json;

    for (const method of HTTP_METHODS) {
      const operation = operations[method] as Json | undefined;
      if (!operation) continue;

      const title = `${method.toUpperCase()} ${route}`;
      const sections = [
        `# ${title}`,
        `Специфікація: monobank ${specName}`,
        `Повний URL: ${baseUrl}${route}`,
        operation.summary ? `Призначення: ${operation.summary}` : "",
        operation.description
          ? `Опис: ${String(operation.description).replace(/\s+/g, " ")}`
          : "",
        Array.isArray(operation.tags) && operation.tags.length
          ? `Розділ: ${operation.tags.join(", ")}`
          : "",
        Array.isArray(operation.security) && operation.security.length
          ? `Авторизація: ${operation.security
              .flatMap((entry: Json) => Object.keys(entry))
              .join(", ")}`
          : "",
        describeParameters(spec, operation.parameters ?? operations.parameters),
        describeBody(spec, operation.requestBody as Json | undefined),
        describeResponses(spec, operation.responses as Json | undefined),
      ];

      const bodySchema = (operation.requestBody as Json | undefined)?.content?.[
        "application/json"
      ]?.schema;
      const okResponse = (operation.responses as Json | undefined)?.["200"]?.content?.[
        "application/json"
      ]?.schema;

      const fieldNames = [
        ...topLevelFieldNames(spec, bodySchema),
        ...topLevelFieldNames(spec, okResponse),
      ];

      chunks.push({
        id: `${specName}:${method}:${route}`,
        spec: specName,
        kind: "endpoint",
        title,
        text: sections.filter(Boolean).join("\n"),
        embedText: [
          title,
          operation.summary ?? "",
          String(operation.description ?? "").replace(/\s+/g, " ").slice(0, 400),
          Array.isArray(operation.tags) ? operation.tags.join(" ") : "",
          fieldNames.length ? `поля: ${[...new Set(fieldNames)].join(", ")}` : "",
        ]
          .filter(Boolean)
          .join(". "),
      });
    }
  }

  for (const [name, rawSchema] of Object.entries(spec.components?.schemas ?? {})) {
    const schema = rawSchema as Json;
    const described = describeSchema(spec, schema, 1);
    if (!described) continue;

    chunks.push({
      id: `${specName}:schema:${name}`,
      spec: specName,
      kind: "schema",
      title: `Схема ${name}`,
      text: [
        `# Схема ${name}`,
        `Специфікація: monobank ${specName}`,
        schema.description ? `Опис: ${String(schema.description).replace(/\s+/g, " ")}` : "",
        "Поля:",
        described,
      ]
        .filter(Boolean)
        .join("\n"),
      embedText: [
        `Схема ${name}`,
        String(schema.description ?? "").replace(/\s+/g, " ").slice(0, 300),
        `поля: ${topLevelFieldNames(spec, schema).join(", ")}`,
      ]
        .filter(Boolean)
        .join(". "),
    });
  }

  return chunks;
}
