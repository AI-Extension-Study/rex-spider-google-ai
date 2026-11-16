import assert from 'node:assert/strict';
import { test } from 'node:test';

import { HOME_URL, isSignedIn } from '../../src/home.mts';

// Synthetic pages with the markers the capture found: a signed-in home page
// holds SignOutOptions, and signed-in and signed-out pages both hold the
// "SNlM0e" token the old spider read.
const SIGNED_IN = '<!doctype html><html><head><script>window.WIZ_global_data={"SNlM0e":"tokenvalue","qwAQke":"x"};</script></head><body><div jscontroller="x" data-ogsr-up=""><script>var a={"SignOutOptions":[1]};</script><a aria-label="Account">Account</a></div></body></html>';
const SIGNED_OUT = '<!doctype html><html><head><script>window.WIZ_global_data={"SNlM0e":"tokenvalue","qwAQke":"x"};</script></head><body><a aria-label="Sign in" href="https://accounts.google.com/ServiceLogin">Sign in</a></body></html>';

test('the home page is google.com in English', () => {
  assert.equal(HOME_URL, 'https://www.google.com/?hl=en');
});

test('a page holding SignOutOptions is signed in', () => {
  assert.equal(isSignedIn(SIGNED_IN), true);
  assert.equal(isSignedIn('SignOutOptions'), true);
});

test('a page without SignOutOptions is signed out', () => {
  assert.equal(isSignedIn('<html><body>Google</body></html>'), false);
  assert.equal(isSignedIn(''), false);
  // The marker is matched as written.
  assert.equal(isSignedIn('signoutoptions'), false);
  assert.equal(isSignedIn('SignOut Options'), false);
});

test('a page holding "SNlM0e" only is signed out', () => {
  assert.equal(isSignedIn(SIGNED_OUT), false);
  assert.equal(isSignedIn('"SNlM0e":"tokenvalue"'), false);
});
