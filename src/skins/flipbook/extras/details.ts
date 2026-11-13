/** The details (details.ts): their stylesheet, their glyphs and the little script three of them need. */
import css from '../details.css?inline';
import { adopt } from '../features';
import '../icons-details';
import '../details-ui';
import type { FbDetailsUiElement } from '../details-ui';

adopt(css);

/** Brings a container's details in line with its `data-fb-details`; called by details.ts on every change. */
export function sync(container: HTMLElement): void {
  let ui = container.querySelector<FbDetailsUiElement>(':scope > fb-details-ui');
  if (!ui) {
    ui = document.createElement('fb-details-ui') as FbDetailsUiElement;
    ui.hidden = true;
    container.append(ui);
  }
  ui.apply();
}
