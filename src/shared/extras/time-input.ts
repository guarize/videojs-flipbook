import { type PropertyValues, PlayerController, playerContext, selectTime, UIElement } from '@videojs/html';
import { clock, parseTime, text } from './i18n';

/**
 * The time display, and a way to type a time: activate it and it becomes a field; `1:23` and Enter goes there,
 * Escape puts it back. It is the non-drag alternative to the seek bar (WCAG 2.5.7), and it's quicker than dragging.
 *
 * A time that can't be used is said in words, not only by colour (WCAG 3.3.1, 1.4.1): `[data-x-part="error"]` holds
 * the message, is linked to the field with `aria-describedby`, and is a polite live region, so it is heard as it
 * appears while focus stays in the field. It is empty (and takes no room) until there is something to say.
 *
 * The skin may author `[data-x-part="display"]`, `[data-x-part="field"]` and `[data-x-part="error"]` inside;
 * otherwise they are created.
 */

let uid = 0;
export class XTimeInputElement extends UIElement {
  #time = new PlayerController(this, playerContext, selectTime);
  #display: HTMLButtonElement | null = null;
  #field: HTMLInputElement | null = null;
  #error: HTMLElement | null = null;
  #errorTimer = 0;
  #abort: AbortController | null = null;

  connectedCallback() {
    super.connectedCallback();
    this.#abort?.abort();
    this.#abort = new AbortController();
    const { signal } = this.#abort;

    this.#display = this.querySelector('[data-x-part="display"]');
    if (!this.#display) {
      this.#display = document.createElement('button');
      this.#display.type = 'button';
      this.#display.dataset.xPart = 'display';
      this.append(this.#display);
    }
    this.#field = this.querySelector('[data-x-part="field"]');
    if (!this.#field) {
      this.#field = document.createElement('input');
      this.#field.dataset.xPart = 'field';
      this.append(this.#field);
    }
    this.#error = this.querySelector('[data-x-part="error"]');
    if (!this.#error) {
      this.#error = document.createElement('span');
      this.#error.dataset.xPart = 'error';
      this.append(this.#error);
    }
    const error = this.#error;
    error.id ||= `x-time-error-${++uid}`;
    error.setAttribute('aria-live', 'polite');
    error.setAttribute('aria-atomic', 'true');
    const field = this.#field;
    const display = this.#display;
    field.setAttribute('aria-describedby', error.id);
    field.type = 'text';
    field.inputMode = 'numeric';
    field.autocomplete = 'off';
    field.spellcheck = false;
    field.hidden = true;
    field.setAttribute('aria-label', text('timeField'));

    display.addEventListener('click', () => this.#open(), { signal });
    // A skin may show a hint on hover or focus ("Type a time"). Escape puts it away without moving the pointer or focus
    // (WCAG 1.4.13): `data-x-hint-dismissed` holds until the pointer leaves or focus moves on.
    document.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape' || display.hidden) return;
      if (display.matches(':hover') || display === document.activeElement) this.toggleAttribute('data-x-hint-dismissed', true);
    }, { capture: true, signal });
    const rearm = () => this.toggleAttribute('data-x-hint-dismissed', false);
    display.addEventListener('pointerleave', rearm, { signal });
    display.addEventListener('blur', rearm, { signal });
    field.addEventListener('keydown', (event) => {
      // Keys typed here belong to the field, not to the player's shortcuts.
      event.stopPropagation();
      if (event.key === 'Enter') {
        event.preventDefault();
        this.#commit();
      } else if (event.key === 'Escape') {
        event.preventDefault();
        this.#close(true);
      }
    }, { signal });
    field.addEventListener('input', () => this.#clearError(), { signal });
    field.addEventListener('blur', () => this.#close(false), { signal });
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.#abort?.abort();
  }

  update(changed: PropertyValues) {
    super.update(changed);
    const time = this.#time.value;
    const display = this.#display;
    if (!time || !display) return;
    const label = `${clock(time.currentTime)} / ${clock(time.duration)}`;
    if (display.textContent !== label) display.textContent = label;
    // The name starts with what the button shows (WCAG 2.5.3), then says what it does.
    display.setAttribute('aria-label', `${label}, ${text('goToTime')}`);
  }

  #open() {
    const field = this.#field;
    const display = this.#display;
    if (!field || !display) return;
    field.value = clock(this.#time.value?.currentTime ?? 0);
    display.hidden = true;
    field.hidden = false;
    this.toggleAttribute('data-editing', true);
    field.focus();
    field.select();
  }

  #commit() {
    const field = this.#field;
    const time = this.#time.value;
    if (!field || !time) return;
    const seconds = parseTime(field.value);
    if (seconds == null) {
      this.#showError(text('timeInvalid'));
      return;
    }
    if (time.duration && seconds > time.duration) {
      this.#showError(text('timeTooLate', { end: clock(time.duration) }));
      return;
    }
    void time.seek(seconds);
    this.#close(true);
  }

  #showError(message: string) {
    const error = this.#error;
    this.toggleAttribute('data-invalid', true);
    this.#field?.setAttribute('aria-invalid', 'true');
    if (!error) return;
    // Emptied first, then set a beat later: the same message twice in a row is heard twice.
    clearTimeout(this.#errorTimer);
    error.textContent = '';
    this.#errorTimer = window.setTimeout(() => {
      error.textContent = message;
    }, 60);
  }

  #clearError() {
    clearTimeout(this.#errorTimer);
    this.toggleAttribute('data-invalid', false);
    this.#field?.removeAttribute('aria-invalid');
    if (this.#error) this.#error.textContent = '';
  }

  #close(returnFocus: boolean) {
    const field = this.#field;
    const display = this.#display;
    if (!field || !display || field.hidden) return;
    field.hidden = true;
    display.hidden = false;
    this.#clearError();
    this.toggleAttribute('data-editing', false);
    if (returnFocus) display.focus();
  }
}

customElements.define('x-time-input', XTimeInputElement);
