// The google.com home page, which says whether the browser is signed in to
// Google. A signed-in page holds SignOutOptions and a signed-out one does not,
// in English and in German. The "SNlM0e" token the old spider read is on
// signed-out pages too, so it says nothing.
export const HOME_URL = 'https://www.google.com/?hl=en';

const SIGNED_IN_MARKER = 'SignOutOptions';

export function isSignedIn(html: string): boolean {
  return html.includes(SIGNED_IN_MARKER);
}
