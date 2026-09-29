/** URL-safe random identifier. Uses getRandomValues (available outside secure contexts). */
export function randomId(bytes = 16): string {
  const data = new Uint8Array(bytes);
  crypto.getRandomValues(data);
  let binary = '';
  for (const byte of data) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
