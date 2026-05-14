import { describe, expect, it } from "vitest";
import { parseMatcherPlan, parseNormalizedMatcherQuery } from "./matcher-query.js";

describe("matcher lowering contract", () => {
  it("normalizes parser output for dialect lowerers", () => {
    const normalized = parseNormalizedMatcherQuery("tag = backend and descendant of api");

    expect(normalized.features).toEqual(["boolean", "field", "hierarchy"]);
    expect(normalized.ast).toMatchObject({
      type: "and",
      nodes: [
        { type: "field", field: "tag", op: "=", values: ["BACKEND"] },
        { type: "hierarchy", relation: "descendant of", taskId: "API" }
      ]
    });
  });

  it("keeps planner filters explicit and independent from SQL dialect", () => {
    const plan = parseMatcherPlan("priority >= 3 or comments > 0", {
      includeArchived: true,
      includeFinished: false,
      sort: "priority"
    });

    expect(plan.features).toEqual(["boolean", "field"]);
    expect(plan.filters).toEqual({
      includeArchived: true,
      includeFinished: false,
      sort: "priority"
    });
  });
});
