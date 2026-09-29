import assert from "node:assert/strict";
import { test } from "node:test";
import { LANCET_COMMAND_NAME, registerLancetCommand } from "./index.ts";

test("registers the Smart Approve LANCET namespace without the legacy command", () => {
  const registrations: Array<{ name: string; description: string }> = [];
  registerLancetCommand(
    {
      registerCommand: (name, definition) => {
        registrations.push({ name, description: definition.description });
      },
    },
    async () => undefined,
  );

  assert.deepEqual(registrations, [{
    name: "smart-approve-lancet",
    description: "Inspect, install, enable, disable, or check Smart Approve LANCET",
  }]);
  assert.equal(LANCET_COMMAND_NAME, "smart-approve-lancet");
  assert.equal(registrations.some(({ name }) => name === "lancet-guard"), false);
});
