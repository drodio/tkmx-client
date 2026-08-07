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

// Each row carries the reason it must be rejected FOR — a bare `assert.throws`
// would pass on any error at all, so a value rejected for the wrong reason
// (say, failing to parse rather than carrying credentials) would look fine.
for (const [name, input, reason] of [
  // The profile page is https, so an http image is mixed content the browser
  // blocks — failing loudly beats a picture that silently never renders.
  ["http is mixed content on an https page", "http://example.com/me.png", /must be https/],
  ["javascript: scheme", "javascript:alert(1)", /must be https/],
  ["data: scheme", "data:image/png;base64,AAAA", /must be https/],
  ["file: scheme", "file:///etc/passwd", /must be https/],
  // Posted off the machine and rendered in a public page attribute, so it must
  // not carry credentials.
  ["embedded credentials", "https://user:password@example.com/me.png", /credentials/],
  ["embedded username only", "https://user@example.com/me.png", /credentials/],
  ["not a URL at all", "me.png", /is not a URL/],
  ["gravatar: with no address", "gravatar:", /gravatar:/],
  ["gravatar: with a non-email", "gravatar:notanemail", /gravatar:/],
  ["gravatar: with no TLD", "gravatar:no@tld", /gravatar:/],
  ["gravatar: with whitespace inside", "gravatar:a b@c.com", /gravatar:/],
  ["github: with no handle", "github:", /github:/],
  ["github: leading hyphen", "github:-leading", /github:/],
  ["github: trailing hyphen", "github:trailing-", /github:/],
  ["github: double hyphen", "github:double--hyphen", /github:/],
  ["github: with a space", "github:has space", /github:/],
  ["github: with a slash", "github:has/slash", /github:/],
  ["github: over 39 chars", `github:${"a".repeat(40)}`, /github:/],
] as const) {
  test(`rejected — ${name}`, () => {
    assert.throws(() => resolveAvatarUrl(input), reason);
  });
}

test("the not-a-URL error names the accepted forms", () => {
  assert.throws(() => resolveAvatarUrl("me.png"), /gravatar:|github:|https/);
});

test("gravatar: uses d=404 so a missing Gravatar falls back to the profile's own avatar", () => {
  // Without d=404 Gravatar serves a stock silhouette, which would replace the
  // generated letter avatar with a worse placeholder.
  assert.match(resolveAvatarUrl("gravatar:test@example.com") as string, /[?&]d=404\b/);
});
