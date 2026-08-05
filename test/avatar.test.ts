import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveAvatarUrl } from "../reporter/avatar";

// sha256("test@example.com") — hard-coded rather than recomputed with crypto so
// this pins the hash Gravatar is actually addressed by. Recomputing it here
// would just restate the implementation and pass no matter what it did.
const TEST_EMAIL_SHA256 =
  "973dfe463ec85785f5f95af5ba3906eedb2d931c24e69824a89ea65dba4e813b";

test("unset avatar resolves to null", () => {
  for (const raw of ["", "   ", "\t\n"]) {
    assert.equal(resolveAvatarUrl(raw), null, `"${raw}" should mean "no avatar"`);
  }
});

test("an https URL is passed through", () => {
  assert.equal(
    resolveAvatarUrl("https://example.com/me.png"),
    "https://example.com/me.png",
  );
  assert.equal(
    resolveAvatarUrl("  https://example.com/me.png  "),
    "https://example.com/me.png",
    "surrounding whitespace is trimmed",
  );
});

test("a non-https URL is rejected, because the profile page would block it", () => {
  // The profile is served over https, so an http image is mixed content and
  // never renders. Failing loudly beats a picture that silently doesn't show.
  assert.throws(() => resolveAvatarUrl("http://example.com/me.png"), /https/);
});

test("a non-image scheme is rejected", () => {
  for (const raw of ["javascript:alert(1)", "data:image/png;base64,AAAA", "file:///etc/passwd"]) {
    assert.throws(() => resolveAvatarUrl(raw), `"${raw}" should be rejected`);
  }
});

test("a value that isn't a URL at all is rejected with a message naming the accepted forms", () => {
  assert.throws(() => resolveAvatarUrl("me.png"), /gravatar:|github:|https/);
});

test("gravatar: hashes the address, lowercased and trimmed", () => {
  const expected = `https://www.gravatar.com/avatar/${TEST_EMAIL_SHA256}?s=256&d=404`;
  assert.equal(resolveAvatarUrl("gravatar:test@example.com"), expected);
  assert.equal(
    resolveAvatarUrl("gravatar:  Test@Example.COM  "),
    expected,
    "Gravatar addresses are case-insensitive and trimmed before hashing",
  );
});

test("gravatar: uses d=404 so a missing Gravatar falls back to the profile's own avatar", () => {
  // Without d=404 Gravatar serves a stock silhouette, which would replace the
  // generated letter avatar with a worse placeholder.
  assert.match(resolveAvatarUrl("gravatar:test@example.com") as string, /[?&]d=404\b/);
});

test("gravatar: rejects anything that isn't an email address", () => {
  for (const raw of ["gravatar:", "gravatar:notanemail", "gravatar:no@tld", "gravatar:a b@c.com"]) {
    assert.throws(() => resolveAvatarUrl(raw), `"${raw}" should be rejected`);
  }
});

test("github: builds the profile-picture URL", () => {
  assert.equal(
    resolveAvatarUrl("github:octocat"),
    "https://github.com/octocat.png?size=256",
  );
  assert.equal(
    resolveAvatarUrl("github:some-user-1"),
    "https://github.com/some-user-1.png?size=256",
    "inner hyphens and digits are valid GitHub usernames",
  );
});

test("github: rejects anything that isn't a GitHub username", () => {
  for (const raw of [
    "github:",
    "github:-leading",
    "github:trailing-",
    "github:double--hyphen",
    "github:has space",
    "github:has/slash",
    `github:${"a".repeat(40)}`,
  ]) {
    assert.throws(() => resolveAvatarUrl(raw), `"${raw}" should be rejected`);
  }
});
