/**
 * @license
 * Copyright 2023 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import '../../divider/divider.js';

import {html, isServer, LitElement, nothing} from 'lit';
import {property, query, state} from 'lit/decorators.js';
import {classMap} from 'lit/directives/class-map.js';

import {ARIAMixinStrict} from '../../internal/aria/aria.js';
import {requestUpdateOnAriaChange} from '../../internal/aria/delegate.js';
import {redispatchEvent} from '../../internal/controller/events.js';

import {DIALOG_DEFAULT_CLOSE_ANIMATION, DIALOG_DEFAULT_OPEN_ANIMATION, DialogAnimation, DialogAnimationArgs} from './animations.js';

/**
 * A dialog component.
 *
 * @fires open {Event} Dispatched when the dialog is opening before any animations.
 * @fires opened {Event} Dispatched when the dialog has opened after any animations.
 * @fires close {Event} Dispatched when the dialog is closing before any animations.
 * @fires closed {Event} Dispatched when the dialog has closed after any animations.
 * @fires cancel {Event} Dispatched when the dialog has been canceled by clicking
 * on the scrim or pressing Escape.
 */
export class Dialog extends LitElement {
  static {
    requestUpdateOnAriaChange(Dialog);
  }

  /** @nocollapse */
  static override shadowRootOptions = {
    ...LitElement.shadowRootOptions,
    delegatesFocus: true,
  };

  /**
   * Opens the dialog when set to `true` and closes it when set to `false`.
   */
  @property({type: Boolean})
  get open() {
    return this.isOpen;
  }

  set open(open: boolean) {
    if (open === this.isOpen) {
      return;
    }

    this.isOpen = open;
    if (open) {
      this.setAttribute('open', '');
      this.show();
    } else {
      this.removeAttribute('open');
      this.close();
    }
  }

  /**
   * Gets or sets the dialog's return value, usually to indicate which button
   * a user pressed to close it.
   *
   * https://developer.mozilla.org/en-US/docs/Web/API/HTMLDialogElement/returnValue
   */
  @property({attribute: false}) returnValue = '';

  /**
   * The type of dialog for accessibility. Set this to `alert` to announce a
   * dialog as an alert dialog.
   */
  @property() type?: 'alert';

  /**
   * If the dialog should have a close button.
   */
  @property({type: Boolean, attribute: 'has-close-button'}) hasCloseButton = true;

  /**
   * Gets the opening animation for a dialog. Set to a new function to customize
   * the animation.
   */
  getOpenAnimation = () => DIALOG_DEFAULT_OPEN_ANIMATION;

  /**
   * Gets the closing animation for a dialog. Set to a new function to customize
   * the animation.
   */
  getCloseAnimation = () => DIALOG_DEFAULT_CLOSE_ANIMATION;

  private isOpen = false;
  private isOpening = false;
  // getIsConnectedPromise() immediately sets the resolve property.
  private isConnectedPromiseResolve!: () => void;
  private isConnectedPromise = this.getIsConnectedPromise();
  @query('dialog') private readonly dialog!: HTMLDialogElement | null;
  @query('.scrim') private readonly scrim!: HTMLDialogElement | null;
  @query('.container') private readonly container!: HTMLDialogElement | null;
  @query('.headline') private readonly headline!: HTMLDialogElement | null;
  @query('.content') private readonly content!: HTMLDialogElement | null;
  @query('.actions') private readonly actions!: HTMLDialogElement | null;
  @state() private isAtScrollTop = false;
  @state() private isAtScrollBottom = false;
  @query('.scroller') private readonly scroller!: HTMLElement | null;
  @query('.top.anchor') private readonly topAnchor!: HTMLElement | null;
  @query('.bottom.anchor') private readonly bottomAnchor!: HTMLElement | null;
  private nextClickIsFromContent = false;
  private intersectionObserver?: IntersectionObserver;
  // Dialogs should not be SSR'd while open, so we can just use runtime checks.
  @state() private hasHeadline = false;
  @state() private hasActions = false;

  constructor() {
    super();
    if (!isServer) {
      this.addEventListener('submit', this.handleSubmit);
    }
  }

  /**
   * Opens the dialog and fires a cancelable `open` event. After a dialog's
   * animation, an `opened` event is fired.
   *
   * Add an `autocomplete` attribute to a child of the dialog that should
   * receive focus after opening.
   *
   * @return A Promise that resolves after the animation is finished and the
   *     `opened` event was fired.
   */
  async show() {
    this.isOpening = true;
    // Dialogs can be opened before being attached to the DOM, so we need to
    // wait until we're connected before calling `showModal()`.
    await this.isConnectedPromise;
    await this.updateComplete;
    const dialog = this.dialog!;
    // Check if already opened or if `dialog.close()` was called while awaiting.
    if (dialog.open || !this.isOpening) {
      this.isOpening = false;
      return;
    }

    const preventOpen = !this.dispatchEvent(new Event('open', {cancelable: true}));
    if (preventOpen) {
      this.open = false;
      return;
    }

    // All Material dialogs are modal.
    dialog.showModal();
    this.open = true;
    // Reset scroll position if re-opening a dialog with the same content.
    if (this.scroller) {
      this.scroller.scrollTop = 0;
    }
    // Native modal dialogs ignore autofocus and instead force focus to the
    // first focusable child. Override this behavior if there is a child with
    // an autofocus attribute.
    this.querySelector<HTMLElement>('[autofocus]')?.focus();

    await this.animateDialog(this.getOpenAnimation());
    this.dispatchEvent(new Event('opened'));
    this.isOpening = false;
  }

  /**
   * Closes the dialog and fires a cancelable `close` event. After a dialog's
   * animation, a `closed` event is fired.
   *
   * @param returnValue A return value usually indicating which button was used
   *     to close a dialog. If a dialog is canceled by clicking the scrim or
   *     pressing Escape, it will not change the return value after closing.
   * @return A Promise that resolves after the animation is finished and the
   *     `closed` event was fired.
   */
  async close(returnValue = this.returnValue) {
    this.isOpening = false;
    if (!this.isConnected) {
      // Disconnected dialogs do not fire close events or animate.
      this.open = false;
      return;
    }

    await this.updateComplete;
    const dialog = this.dialog!;
    // Check if already closed or if `dialog.show()` was called while awaiting.
    if (!dialog.open || this.isOpening) {
      this.open = false;
      return;
    }

    const prevReturnValue = this.returnValue;
    this.returnValue = returnValue;
    const preventClose = !this.dispatchEvent(new Event('close', {cancelable: true}));
    if (preventClose) {
      this.returnValue = prevReturnValue;
      return;
    }

    await this.animateDialog(this.getCloseAnimation());
    dialog.close(returnValue);
    this.open = false;
    this.dispatchEvent(new Event('closed'));
  }

  override connectedCallback() {
    super.connectedCallback();
    this.isConnectedPromiseResolve();
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this.isConnectedPromise = this.getIsConnectedPromise();
  }

  protected override render() {
    const scrollable = this.open && !(this.isAtScrollTop && this.isAtScrollBottom);
    const classes = {
      'has-headline': this.hasHeadline,
      'has-actions': this.hasActions,
      'scrollable': scrollable
    };

    const {ariaLabel} = this as ARIAMixinStrict;
    return html`
      <div class="scrim"></div>
      <dialog
        class=${classMap(classes)}
        aria-label=${ariaLabel || nothing}
        aria-labelledby=${this.hasHeadline ? 'headline' : nothing}
        role=${this.type === 'alert' ? 'alertdialog' : nothing}
        @cancel=${this.handleCancel}
        @click=${this.handleDialogClick}
        .returnValue=${this.returnValue || nothing}
      >
        <div class="container" @click=${this.handleContentClick}>
          <div class="headline">
            <h2 id="headline" aria-hidden=${!this.hasHeadline || nothing}>
              <slot name="headline" @slotchange=${this.handleHeadlineChange}></slot>
            </h2>
            <div class="close-button-container" aria-hidden=${!this.hasCloseButton || nothing}>
              ${this.renderCloseButton()}
            </div>
          </div>
          <div class="scroller">
            <div class="content">
              <div class="top anchor"></div>
              <slot name="content"></slot>
              <div class="bottom anchor"></div>
            </div>
          </div>
          <div class="actions">
            <slot name="actions" @slotchange=${this.handleActionsChange}></slot>
          </div>
        </div>
      </dialog>
    `;
  }
  
  private renderCloseButton() {
    return !this.hasCloseButton ? nothing : html`
      <md-icon-button class="close-button" @click=${this.close}>
        <md-icon>close</md-icon>
      </md-icon-button>
    `;
  }

  protected override firstUpdated() {
    this.intersectionObserver = new IntersectionObserver(
      entries => {
        for (const entry of entries) {
          this.handleAnchorIntersection(entry);
        }
      },
      {root: this.scroller!},
    );

    this.intersectionObserver.observe(this.topAnchor!);
    this.intersectionObserver.observe(this.bottomAnchor!);
  }

  private handleDialogClick() {
    if (this.nextClickIsFromContent) {
      // Avoid doing a layout calculation below if we know the click came from
      // content.
      this.nextClickIsFromContent = false;
      return;
    }

    // Click originated on the backdrop. Native `<dialog>`s will not cancel,
    // but Material dialogs do.
    const preventDefault = !this.dispatchEvent(new Event('cancel', {cancelable: true}));
    if (preventDefault) {
      return;
    }

    this.close();
  }

  private handleContentClick() {
    this.nextClickIsFromContent = true;
  }

  private handleSubmit(event: SubmitEvent) {
    const form = event.target as HTMLFormElement;
    const {submitter} = event;
    if (form.method !== 'dialog' || !submitter) {
      return;
    }

    // Close reason is the submitter's value attribute, or the dialog's
    // `returnValue` if there is no attribute.
    this.close(submitter.getAttribute('value') ?? this.returnValue);
  }

  private handleCancel(event: Event) {
    if (event.target !== this.dialog) {
      // Ignore any cancel events dispatched by content.
      return;
    }

    const preventDefault = !redispatchEvent(this, event);
    // We always prevent default on the original dialog event since we'll
    // animate closing it before it actually closes.
    event.preventDefault();
    if (preventDefault) {
      return;
    }

    this.close();
  }

  private async animateDialog(animation: DialogAnimation) {
    const {dialog, scrim, container, headline, content, actions} = this;
    if (!dialog || !scrim || !container || !headline || !content || !actions) {
      return;
    }

    const {container: containerAnimate, dialog: dialogAnimate, scrim: scrimAnimate, headline: headlineAnimate, content: contentAnimate, actions: actionsAnimate} = animation;

    const elementAndAnimation: Array<[Element, DialogAnimationArgs[]]> = [
      [dialog, dialogAnimate ?? []],
      [scrim, scrimAnimate ?? []],
      [container, containerAnimate ?? []],
      [headline, headlineAnimate ?? []],
      [content, contentAnimate ?? []],
      [actions, actionsAnimate ?? []],
    ];

    const animations: Animation[] = [];
    for (const [element, animation] of elementAndAnimation) {
      for (const animateArgs of animation) {
        animations.push(element.animate(...animateArgs));
      }
    }

    await Promise.all(animations.map(animation => animation.finished));
  }

  private handleHeadlineChange(event: Event) {
    const slot = event.target as HTMLSlotElement;
    this.hasHeadline = slot.assignedElements().length > 0;
  }

  private handleActionsChange(event: Event) {
    const slot = event.target as HTMLSlotElement;
    this.hasActions = slot.assignedElements().length > 0;
  }

  private handleAnchorIntersection(entry: IntersectionObserverEntry) {
    const {target, isIntersecting} = entry;
    if (target === this.topAnchor) {
      this.isAtScrollTop = isIntersecting;
    }

    if (target === this.bottomAnchor) {
      this.isAtScrollBottom = isIntersecting;
    }
  }

  private getIsConnectedPromise() {
    return new Promise<void>(resolve => {
      this.isConnectedPromiseResolve = resolve;
    });
  }
}
