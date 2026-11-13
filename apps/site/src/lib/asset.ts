/** A file from the public folder, under the site's base, so the page works at a domain root or in a subfolder. */
export const asset = (path: string) => `${import.meta.env.BASE_URL.replace(/\/?$/, '/')}${path}`;
