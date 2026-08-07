import * as crypto from "node:crypto";

// Resolves the AVATAR setting to a plain image URL for the profile page.
//
// Three ways to say it, one variable, because the server only ever has to
// store and render a single string no matter which one you pick:
//
//   https://example.com/me.png   an image you host yourself
//   gravatar:you@example.com     your Gravatar
//   github:yourhandle            your GitHub profile picture
//
// The Gravatar form hashes the address here and sends only the resulting URL,
// so your email address never leaves this machine.
//
// Returns null when unset. Throws on a malformed value: a typo'd avatar is a
// config error the operator can fix, and failing the run beats a silently
// ignored setting that leaves them wondering why their picture never showed up.
//
// No error here echoes the offending value back. The caller writes these to
// stderr, which on an installed client is an unattended launchd/systemd log —
// and a malformed value is exactly the case that can still carry a password
// (`https://user:secret@…` fails to parse, so it reaches the error path).

// Rendered at 72px on the profile today; 256 keeps it sharp on 3x displays
// without shipping a needlessly large image.
const SIZE = 256;

// GitHub's own rule: 1-39 chars, alphanumeric or single inner hyphens.
const GITHUB_USERNAME = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;

export function resolveAvatarUrl(raw: string): string | null {
  const value = raw.trim();
  if (!value) return null;

  if (value.startsWith("gravatar:")) {
    const email = value.slice("gravatar:".length).trim().toLowerCase();
    if (!email || /\s/.test(email) || !/^[^@]+@[^@.]+\.[^@]+$/.test(email)) {
      throw new Error("gravatar: needs an email address");
    }
    // Gravatar accepts a SHA-256 of the trimmed, lowercased address; d=404
    // makes it 404 rather than serve a stock silhouette when the address has
    // no Gravatar, so the profile falls back to its own default avatar.
    const hash = crypto.createHash("sha256").update(email).digest("hex");
    return `https://www.gravatar.com/avatar/${hash}?s=${SIZE}&d=404`;
  }

  if (value.startsWith("github:")) {
    const user = value.slice("github:".length).trim();
    if (!GITHUB_USERNAME.test(user)) {
      throw new Error("github: needs a GitHub username");
    }
    return `https://github.com/${user}.png?size=${SIZE}`;
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(
      "AVATAR is not a URL — expected https://..., gravatar:you@example.com, or github:yourhandle",
    );
  }
  // https only: the profile page is served over https, so a http:// image is
  // mixed content and the browser blocks it. Failing here beats shipping a URL
  // that silently refuses to render.
  if (url.protocol !== "https:") {
    throw new Error(`avatar URL must be https, got ${url.protocol}//`);
  }
  // This URL is posted off the machine and ends up in an attribute on a public
  // page, so it must not carry credentials.
  if (url.username || url.password) {
    throw new Error("avatar URL must not embed credentials (user:password@)");
  }
  return url.toString();
}
