import {
  forwardRef,
  useId,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  type ReactNode
} from 'react';
import { boundedLabel } from './label-contract';
import { issueOverlayContractError, useLatest } from './workspace-collection-contracts';
import { portalOverlay, useOverlayPortalHost, useOverlayTheme } from './workspace-overlay-host';
import './foundation.css';
type DialogRecord = { readonly node: HTMLDialogElement; readonly token: symbol };
const dialogStacks = new WeakMap<Document, DialogRecord[]>();
function dialogStackFor(ownerDocument: Document): DialogRecord[] {
  const existing = dialogStacks.get(ownerDocument);
  if (existing !== undefined) return existing;
  const stack: DialogRecord[] = [];
  dialogStacks.set(ownerDocument, stack);
  return stack;
}
function focusables(container: HTMLElement): HTMLElement[] {
  return Array.from(
    container.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
    )
  ).filter((item) => {
    const style = item.ownerDocument.defaultView?.getComputedStyle(item);
    if (style === undefined) return false;
    return (
      !item.hidden &&
      !item.inert &&
      style.display !== 'none' &&
      style.visibility !== 'hidden' &&
      item.getClientRects().length > 0
    );
  });
}
function syncModalIsolation(ownerDocument: Document) {
  const stack = dialogStackFor(ownerDocument);
  for (let index = stack.length - 1; index >= 0; index -= 1)
    if (!stack[index]?.node.isConnected) stack.splice(index, 1);
  const top = stack.at(-1);
  for (const record of stack) {
    const active = record.node === top?.node;
    record.node.inert = !active;
    if (active) record.node.removeAttribute('aria-hidden');
    else record.node.setAttribute('aria-hidden', 'true');
  }
}
export interface DialogProps {
  readonly children: ReactNode;
  readonly closeLabel: string;
  readonly initialFocusRef?: React.RefObject<HTMLElement | null>;
  readonly onOpenChange: (open: boolean) => void;
  readonly open: boolean;
  readonly title: string;
}
export const Dialog = forwardRef<HTMLDialogElement, DialogProps>(function Dialog(
  { children, closeLabel, initialFocusRef, onOpenChange, open, title },
  forwardedRef
) {
  if (typeof open !== 'boolean') throw issueOverlayContractError('Dialog open must be a boolean.');
  if (typeof onOpenChange !== 'function')
    throw issueOverlayContractError('Dialog onOpenChange must be a function.');
  const safeCloseLabel = boundedLabel('Dialog closeLabel', closeLabel);
  const safeTitle = boundedLabel('Dialog title', title);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const token = useRef(Symbol('dialog')).current;
  const restore = useRef<HTMLElement | null>(null);
  const onOpenChangeRef = useLatest(onOpenChange);
  const titleId = useId();
  const overlayOwner = useId();
  const sourceRef = useRef<HTMLSpanElement>(null);
  const portalHost = useOverlayPortalHost(sourceRef, open, overlayOwner);
  const theme = useOverlayTheme(open, sourceRef);
  useImperativeHandle(forwardedRef, () => dialogRef.current as HTMLDialogElement, []);
  useLayoutEffect(() => {
    if (!open || dialogRef.current === null) return;
    const dialog = dialogRef.current;
    const ownerDocument = dialog.ownerDocument;
    restore.current =
      ownerDocument.activeElement !== null && ownerDocument.activeElement.nodeType === 1
        ? (ownerDocument.activeElement as HTMLElement)
        : null;
    if (!ownerDocument.body.contains(dialog))
      throw issueOverlayContractError('Dialog must be connected to document.body before opening.');
    const stack = dialogStackFor(ownerDocument);
    const existing = stack.find((record) => record.token === token);
    if (dialog.open && existing === undefined) dialog.close();
    try {
      if (!dialog.open) dialog.showModal();
    } catch {
      throw issueOverlayContractError('Dialog could not enter the modal top layer.');
    }
    if (existing === undefined) stack.push({ node: dialog, token });
    syncModalIsolation(ownerDocument);
    const containedInitial = initialFocusRef?.current;
    const initialFocusItems = focusables(dialog);
    const first =
      containedInitial !== undefined &&
      containedInitial !== null &&
      initialFocusItems.includes(containedInitial)
        ? containedInitial
        : initialFocusItems[0];
    (first ?? dialog)?.focus();
    const onFocus = (event: FocusEvent) => {
      if (
        stack.at(-1)?.token === token &&
        dialog !== null &&
        event.target !== null &&
        typeof (event.target as Node).nodeType === 'number' &&
        !dialog.contains(event.target as Node)
      )
        (focusables(dialog)[0] ?? dialog).focus();
    };
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (stack.at(-1)?.token !== token) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        onOpenChangeRef.current(false);
        return;
      }
      if (event.key === 'Tab' && dialog !== null) {
        const items = focusables(dialog);
        const firstItem = items[0];
        const lastItem = items.at(-1);
        if (items.length === 0) {
          event.preventDefault();
          dialog.focus();
        } else if (event.shiftKey && ownerDocument.activeElement === firstItem) {
          event.preventDefault();
          lastItem?.focus();
        } else if (!event.shiftKey && ownerDocument.activeElement === lastItem) {
          event.preventDefault();
          firstItem?.focus();
        }
      }
    };
    ownerDocument.addEventListener('focusin', onFocus, true);
    ownerDocument.addEventListener('keydown', onKey, true);
    return () => {
      ownerDocument.removeEventListener('focusin', onFocus, true);
      ownerDocument.removeEventListener('keydown', onKey, true);
      const index = stack.findIndex((record) => record.token === token);
      if (index >= 0) stack.splice(index, 1);
      if (dialog.open) dialog.close();
      syncModalIsolation(ownerDocument);
      if (restore.current?.isConnected) restore.current.focus();
      else {
        const top = stack.at(-1)?.node;
        (top === null || top === undefined
          ? ownerDocument.body
          : (focusables(top)[0] ?? top)
        ).focus();
      }
    };
  }, [open, portalHost, token]);
  const sourceAnchor = <span aria-hidden="true" className="sl-overlay-anchor" ref={sourceRef} />;
  if (!open || typeof document === 'undefined') return sourceAnchor;
  const dismiss = () => {
    const ownerDocument = dialogRef.current?.ownerDocument;
    if (ownerDocument !== undefined && dialogStackFor(ownerDocument).at(-1)?.token === token)
      onOpenChangeRef.current(false);
  };
  return (
    <>
      {sourceAnchor}
      {portalOverlay(
        <dialog
          aria-labelledby={titleId}
          aria-modal="true"
          className="sl-dialog"
          onCancel={(event) => {
            event.preventDefault();
            dismiss();
          }}
          onClose={() => dismiss()}
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) dismiss();
          }}
          ref={dialogRef}
          role="dialog"
          tabIndex={-1}
        >
          <div className="sl-dialog__heading">
            <h2 id={titleId}>{safeTitle}</h2>
            <button
              aria-label={safeCloseLabel}
              className="sl-dialog__close"
              onClick={dismiss}
              type="button"
            >
              ×
            </button>
          </div>
          <div className="sl-dialog__body">{children}</div>
        </dialog>,
        theme,
        portalHost,
        overlayOwner
      )}
    </>
  );
});
