/**
 * Copy text to the clipboard. Returns true on success, false otherwise.
 *
 * Uses the async Clipboard API when available (secure contexts: https / localhost),
 * with a legacy execCommand fallback for insecure contexts (e.g. plain-http on a
 * LAN IP, where `navigator.clipboard` is undefined) and older browsers. The
 * `typeof` guards keep this import safe under SSR/prerender.
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // fall through to the legacy path
    }
  }

  if (typeof document === "undefined") return false;

  try {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "");
    textarea.style.cssText = "position:fixed;top:-9999px;opacity:0";
    document.body.appendChild(textarea);
    textarea.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(textarea);
    return ok;
  } catch {
    return false;
  }
}
