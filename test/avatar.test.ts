import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveAvatarUrl } from "../reporter/avatar";

// sha256("test@example.com") — hard-coded rather than recomputed with crypto so
// this pins the hash Gravatar is actually addressed by. Recomputing it here
// would just restate the implementation and pass no matter what it did.
const TEST_EMAIL_SHA256 =
  "973dfe463ec85785f5f95af5ba3906eedb2d931c24e69824a89ea65dba4e813b";
const GRAVATAR = `https://www.gravatar.com/avatar/${TEST_EMAIL_SHA256}?s=256&d=404`;

for (const [name, input, expected] of [
  ["unset is no avatar", "", null],
  ["whitespace-only is no avatar", "  \t\n ", null],
  ["https URL passes through", "https://example.com/me.png", "https://example.com/me.png"],
  ["surrounding whitespace is trimmed", "  https://example.com/me.png  ", "https://example.com/me.png"],
  ["gravatar: hashes the address", "gravatar:test@example.com", GRAVATAR],
  // Gravatar addresses are case-insensitive; hashing must normalise first.
  ["gravatar: lowercases and trims before hashing", "gravatar:  Test@Example.COM  ", GRAVATAR],
  ["github: builds the profile-picture URL", "github:octocat", "https://github.com/octocat.png?size=256"],
  ["github: allows inner hyphens and digits", "github:some-user-1", "https://github.com/some-user-1.png?size=256"],
] as const) {
  test(`accepted — ${name}`, () => {
    assert.equal(resolveAvatarUrl(input), expected);
  });
}

for (const [name, input] of [
  // The profile page is https, so an http image is mixed content the browser
  // blocks — failing loudly beats a picture that silently never renders.
  ["http is mixed content on an https page", "http://example.com/me.png"],
  ["javascript: scheme", "javascript:alert(1)"],
  ["data: scheme", "data:image/png;base64,AAAA"],
  ["file: scheme", "file:///etc/passwd"],
  // Posted off the machine and rendered in a public page attribute, so it must
  // not carry credentials.
  ["embedded credentials", "https://user:password@example.com/me.png"],
  ["embedded username only", "https://user@example.com/me.png"],
  ["not a URL at all", "me.png"],
  ["gravatar: with no address", "gravatar:"],
  ["gravatar: with a non-email", "gravatar:notanemail"],
  ["gravatar: with no TLD", "gravatar:no@tld"],
  ["gravatar: with whitespace inside", "gravatar:a b@c.com"],
  ["github: with no handle", "github:"],
  ["github: leading hyphen", "github:-leading"],
  ["github: trailing hyphen", "github:trailing-"],
  ["github: double hyphen", "github:double--hyphen"],
  ["github: with a space", "github:has space"],
  ["github: with a slash", "github:has/slash"],
  ["github: over 39 chars", `github:${"a".repeat(40)}`],
] as const) {
  test(`rejected — ${name}`, () => {
    assert.throws(() => resolveAvatarUrl(input), `"${input}" should be rejected`);
  });
}

test("the error message names the accepted forms", () => {
  assert.throws(() => resolveAvatarUrl("me.png"), /gravatar:|github:|https/);
});

test("gravatar: uses d=404 so a missing Gravatar falls back to the profile's own avatar", () => {
  // Without d=404 Gravatar serves a stock silhouette, which would replace the
  // generated letter avatar with a worse placeholder.
  assert.match(resolveAvatarUrl("gravatar:test@example.com") as string, /[?&]d=404\b/);
});
