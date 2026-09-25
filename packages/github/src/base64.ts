/**
 * UTF-8 safe base64, using only `atob`/`btoa` and `TextEncoder`/`TextDecoder` so the package stays
 * isomorphic: those four are global in every evergreen browser and in Node 18+, unlike `Buffer`,
 * which is Node-only. The Contents API sends and receives base64 with the file's bytes; going
 * through `atob`/`btoa` directly (which only understand Latin-1) would corrupt anything outside
 * that range.
 */

export function encodeBase64Utf8(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function decodeBase64Utf8(base64: string): string {
  const binary = atob(base64.replace(/\n/g, ""));
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}
