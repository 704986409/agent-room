// Keep template source pages ready for later re-listing, while leaving them
// out of production routes and homepage navigation unless explicitly enabled.
// Vite development keeps the pages available for local review.
export const TEMPLATE_PAGES_ENABLED = import.meta.env.DEV
  || (import.meta.env as Record<string, string | boolean | undefined>).VITE_ENABLE_TEMPLATE_PAGES === 'true';
