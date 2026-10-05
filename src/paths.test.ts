import assert from "node:assert/strict";
import { test } from "node:test";
import { ProtectedPathMatcher } from "./paths.ts";

test("protected path matching keeps negations and safe project files distinct", () => {
  const matcher = new ProtectedPathMatcher([
    ".env",
    ".env.*",
    "!.env.example",
    "**/.ssh/**",
    "**/*.key",
  ]);

  assert.equal(matcher.isProtected("/repo/.env"), true);
  assert.equal(matcher.isProtected("/repo/.env.local"), true);
  assert.equal(matcher.isProtected("/repo/.env.example"), false);
  assert.equal(matcher.isProtected("/repo/.ssh/id_ed25519"), true);
  assert.equal(matcher.isProtected("/repo/config/app.key"), true);
  assert.equal(matcher.isProtected("/repo/src/index.ts"), false);
});
