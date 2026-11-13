/**
 * `cover`: the dust jacket at the start (and the scanimation opening, with `?opening=scan`), the cover turning over
 * on first play (with `turns` on too), and the back cover at the end. The jacket is the player at rest, so this one
 * loads as soon as the player is on the page; its opening comes in the same chunk, so a first press on the cover
 * always gets its turn.
 */
import jacketCss from '../jacket.css?inline';
import riffleCss from '../riffle.css?inline';
import coverCss from '../cover.css?inline';
import { adopt } from '../features';
import './paper';
import '../jacket';
import '../scan';
import '../riffle';
import '../cover';

adopt(`${jacketCss}\n${riffleCss}\n${coverCss}`);
