import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { STALE_AFTER_DAYS, indexAgeDays, isStale } from "../src/index-store.ts";
import { specHash } from "../src/specs.ts";
import type { OpenApiSpec } from "../src/specs.ts";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-07-26T12:00:00.000Z");

describe("вік індексу", () => {
  it("свіжий індекс має вік близько нуля", () => {
    assert.ok(indexAgeDays({ builtAt: new Date(NOW).toISOString() }, NOW) < 0.01);
  });

  it("рахує дні правильно", () => {
    const built = new Date(NOW - 5 * DAY).toISOString();
    assert.equal(Math.round(indexAgeDays({ builtAt: built }, NOW)), 5);
  });

  it("нерозбірлива дата вважається нескінченно старою", () => {
    assert.equal(indexAgeDays({ builtAt: "не дата" }, NOW), Number.POSITIVE_INFINITY);
  });

  it("свіжий індекс не застарілий", () => {
    assert.equal(isStale({ builtAt: new Date(NOW - DAY).toISOString() }, NOW), false);
  });

  it("індекс за межею вважається застарілим", () => {
    const built = new Date(NOW - (STALE_AFTER_DAYS + 1) * DAY).toISOString();
    assert.equal(isStale({ builtAt: built }, NOW), true);
  });

  it("рівно на межі ще не застарілий", () => {
    const built = new Date(NOW - STALE_AFTER_DAYS * DAY).toISOString();
    assert.equal(isStale({ builtAt: built }, NOW), false);
  });

  it("зіпсована дата теж вважається застарілою", () => {
    assert.equal(isStale({ builtAt: "" }, NOW), true);
  });
});

describe("відбиток специфікації", () => {
  const base: OpenApiSpec = {
    paths: { "/a": { get: { summary: "A", responses: {} } } },
    components: { schemas: { S: { type: "object" } } },
  };

  it("однакові специфікації дають однаковий відбиток", () => {
    assert.equal(specHash(base), specHash(structuredClone(base)));
  });

  it("новий ендпоїнт змінює відбиток", () => {
    const changed = structuredClone(base);
    changed.paths!["/b"] = { get: { summary: "B", responses: {} } };
    assert.notEqual(specHash(base), specHash(changed));
  });

  it("зміна схеми змінює відбиток", () => {
    const changed = structuredClone(base);
    changed.components!.schemas!.S = { type: "object", properties: { x: { type: "string" } } };
    assert.notEqual(specHash(base), specHash(changed));
  });

  it("зміна лише версії в info відбиток не чіпає", () => {
    // Відбиток стежить за формою API, а не за косметикою документації —
    // інакше doctor кричав би на кожну правку опису.
    const changed = structuredClone(base);
    changed.info = { title: "інша", version: "9.9" };
    assert.equal(specHash(base), specHash(changed));
  });

  it("відбиток короткий і стабільний за довжиною", () => {
    assert.equal(specHash(base).length, 16);
  });
});
