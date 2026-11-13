/**
 * `deck`: the book's hands on the fore-edge. The riffling deck of pages on hover and swipe (deck.ts), and flipping as
 * playing (flip.ts): a drag, a flick, the wheel or a held arrow on the edge moves the film itself, and a paused film
 * is a printed page that ← and → turn one at a time.
 */
import css from '../deck.css?inline';
import flipCss from '../flip.css?inline';
import { adopt } from '../features';
import '../deck';
import '../flip';

adopt(`${css}\n${flipCss}`);
