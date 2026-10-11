/** Response headers for every page and JSON answer the web server sends. */
export const SECURITY_HEADERS = {
  "content-security-policy":
    "default-src 'none'; script-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "cache-control": "no-store",
};
