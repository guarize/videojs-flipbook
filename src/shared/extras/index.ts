/*
 * The details web players lack, shared by every skin here. Each is a small custom element (or, for fine scrubbing,
 * an attribute on Video.js's own time slider) that reads the player's state and leaves the look to the skin.
 *
 * - <x-time-input>: click the time and type one (`1:23`, `83`, `1:02:03`) to go there. A non-drag way to seek.
 * - <x-ends-at>: "Ends 21:42", from the time left and the playback rate.
 * - data-x-fine-scrub on media-time-slider: while dragging, moving up away from the bar slows the scrub.
 * - <x-rewind-captions>: going back up to 30 seconds turns captions on for 10 seconds: "what did they say?"
 * - <x-resume>: "Resume from 0:42", a few seconds before where you stopped, kept per video in this browser.
 * - Page keys: shortcuts work without clicking the player first; they go to the player you last used, or the one in view.
 */
import './i18n';
import './time-input';
import './ends-at';
import './fine-scrub';
import './rewind-captions';
import './resume';
import './page-keys';
