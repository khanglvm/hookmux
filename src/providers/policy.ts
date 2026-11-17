// Privacy rule for model providers: a prompt leaves the machine only when the
// provider runs on loopback or its config opts in with `allow_remote = true`.

import type { ProviderSettings } from "../checks/registry.ts";

const IPV4_LOOPBACK = /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;

/**
 * True when the URL's host is exactly localhost, an address in 127.0.0.0/8 or ::1.
 * The host is compared whole, so "127.0.0.1.example.com" and "localhost.evil.com"
 * count as remote. URL.hostname keeps the brackets around IPv6 addresses.
 */
export function isLoopbackUrl(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  return host === "localhost" || host === "[::1]" || IPV4_LOOPBACK.test(host);
}

/** Returns why the provider may not receive prompts, or null when it may. */
export function remoteRefusal(name: string, provider: ProviderSettings): string | null {
  let protocol: string;
  try {
    protocol = new URL(provider.url).protocol;
  } catch {
    return `provider '${name}' has an invalid url`;
  }
  if (protocol !== "http:" && protocol !== "https:") return `provider '${name}' url must be http or https`;
  if (provider.allowRemote === true || isLoopbackUrl(provider.url)) return null;
  return `provider '${name}' is not on this machine; set allow_remote = true under [providers.${name}] to send prompts to it`;
}
