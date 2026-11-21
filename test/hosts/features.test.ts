import assert from "node:assert/strict";
import { test } from "node:test";
import { FEATURES, type FeatureId, featuresFor, isDeclared } from "../../src/core/features.ts";
import { CANONICAL_EVENTS } from "../../src/core/types.ts";
import { droid } from "../../src/hosts/droid.ts";
import { ADAPTERS } from "../../src/hosts/index.ts";
import { parseOrFail } from "./helpers.ts";

for (const adapter of Object.values(ADAPTERS)) {
  test(`${adapter.id} states exactly the feature cells it must`, () => {
    for (const feature of FEATURES) {
      const declared = adapter.features[feature.id as FeatureId];
      for (const event of CANONICAL_EVENTS) {
        const where = `${adapter.id} ${feature.id} on ${event}`;
        if (isDeclared(adapter, feature, event)) {
          assert.ok(event in declared, `${where} must be stated (use null when unknown)`);
        } else {
          assert.ok(!(event in declared), `${where} is derived or not applicable, so it is not declared`);
        }
      }
    }
  });

  test(`${adapter.id} puts its resolved features on every parsed event`, () => {
    for (const event of CANONICAL_EVENTS) {
      const parsed = parseOrFail(adapter, event, adapter.sample(event));
      assert.deepEqual(parsed.host.features, featuresFor(adapter, event));
    }
  });
}

test("a feature that qualifies an effect is no where the host cannot perform it", () => {
  const facts = featuresFor(droid, "tool.before");
  assert.equal(facts["inject.before-call"], false);
  assert.equal(facts["inject.markup"], false);
  assert.equal(facts["block.prevents"], true);
});
