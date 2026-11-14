// Small decisions of the login form, kept apart from the page so they can be tested without a browser.

/** The "Default password is 123456" hint is true only while no password has been set.
 *  `hasPassword` comes from /api/auth/status; when that call fails the page assumes a password exists,
 *  so the hint is never shown on a guess. */
export function showDefaultPasswordHint(hasPassword) {
  return hasPassword === false;
}

/** Login can be sent once something is typed and no lockout is counting down. */
export function canSubmitLogin({ password, retryAfter = 0 } = {}) {
  return typeof password === "string" && password.length > 0 && !(retryAfter > 0);
}
