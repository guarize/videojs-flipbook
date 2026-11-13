/**
 * A silenced context: `await quiet(context)` right after `browser.newContext()`.
 *
 * One implementation, tests/e2e/support/silence.mjs: the film swapped for a copy with no audio track, served by byte
 * range (a film answered whole, with no ranges, cannot be sought), and Web Audio kept from the speakers. This name is
 * kept for the scripts that grew up with it.
 */
export { silence as quiet, silence } from '../tests/e2e/support/silence.mjs';
