import {
  forwardRef,
  useCallback,
  useEffect,
  useId,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode
} from 'react';
import { boundedLabel } from './label-contract';
import { issueOverlayContractError, useControllableValue } from './workspace-collection-contracts';
import { portalOverlay, useOverlayPortalHost, useOverlayTheme } from './workspace-overlay-host';
import './foundation.css';
type PopoverRecord = { readonly token: symbol };
const popoverStacks = new WeakMap<Document, PopoverRecord[]>();
function popoverStackFor(ownerDocument: Document): PopoverRecord[] {
  const existing = popoverStacks.get(ownerDocument);
  if (existing !== undefined) return existing;
  const stack: PopoverRecord[] = [];
  popoverStacks.set(ownerDocument, stack);
  return stack;
}

type PopoverControl =
  | {
      readonly defaultOpen?: boolean;
      readonly onOpenChange?: (open: boolean) => void;
      readonly open?: undefined;
    }
  | {
      readonly defaultOpen?: never;
      readonly onOpenChange: (open: boolean) => void;
      readonly open: boolean;
    };
export type PopoverProps = PopoverControl & {
  readonly children: ReactNode;
  readonly contentLabel: string;
  /** Auto keeps the anchored surface inside the viewport; hosts may force a side when needed. */
  readonly placement?: 'auto' | 'above' | 'below';
  readonly triggerText: string;
};
export const Popover = forwardRef<HTMLButtonElement, PopoverProps>(
  function Popover(props, forwardedRef) {
    const { children, contentLabel, onOpenChange, open: controlled, triggerText } = props;
    const defaultOpen = props.defaultOpen ?? false;
    const placement = props.placement ?? 'auto';
    if (props.defaultOpen !== undefined && typeof props.defaultOpen !== 'boolean')
      throw issueOverlayContractError('Popover defaultOpen must be a boolean.');
    if (controlled !== undefined && typeof controlled !== 'boolean')
      throw issueOverlayContractError('Popover open must be a boolean.');
    if (onOpenChange !== undefined && typeof onOpenChange !== 'function')
      throw issueOverlayContractError('Popover onOpenChange must be a function.');
    if (controlled !== undefined && typeof onOpenChange !== 'function')
      throw issueOverlayContractError('Popover controlled open requires onOpenChange.');
    if (placement !== 'auto' && placement !== 'above' && placement !== 'below')
      throw issueOverlayContractError('Popover placement must be auto, above, or below.');
    const safeContentLabel = boundedLabel('Popover contentLabel', contentLabel);
    const safeTriggerText = boundedLabel('Popover triggerText', triggerText);
    const [open, setOpen] = useControllableValue(controlled, defaultOpen, onOpenChange);
    const triggerRef = useRef<HTMLButtonElement>(null);
    const contentRef = useRef<HTMLDivElement>(null);
    const restoreIntent = useRef<{ readonly generation: number } | null>(null);
    const observedOpen = useRef(open);
    const openGeneration = useRef(0);
    const token = useRef(Symbol('popover')).current;
    const id = useId();
    const overlayOwner = useId();
    const portalHost = useOverlayPortalHost(triggerRef, open, overlayOwner);
    const theme = useOverlayTheme(open, triggerRef);
    const [position, setPosition] = useState<{
      readonly left: number;
      readonly top: number;
      readonly side: 'above' | 'below';
    }>();
    useImperativeHandle(forwardedRef, () => triggerRef.current as HTMLButtonElement, []);
    const request = useCallback(
      (next: boolean, shouldRestore = false) => {
        if (next === open) return;
        if (!next && shouldRestore) restoreIntent.current = { generation: openGeneration.current };
        setOpen(next);
      },
      [open, setOpen]
    );
    useLayoutEffect(() => {
      if (observedOpen.current !== open) {
        observedOpen.current = open;
        openGeneration.current += 1;
      }
      const pending = restoreIntent.current;
      if (pending === null) return;
      if (!open) {
        triggerRef.current?.focus();
        restoreIntent.current = null;
      } else if (openGeneration.current > pending.generation) {
        restoreIntent.current = null;
      }
    }, [open]);
    useLayoutEffect(() => {
      if (!open || triggerRef.current === null || contentRef.current === null) return;
      let active = true;
      const update = () => {
        if (!active) return;
        const trigger = triggerRef.current;
        const content = contentRef.current;
        if (trigger === null || content === null) return;
        const triggerBox = trigger.getBoundingClientRect();
        const gap = 8;
        const ownerWindow = trigger.ownerDocument.defaultView;
        if (ownerWindow === null) return;
        const maxHeight = Math.max(0, ownerWindow.innerHeight - gap * 2);
        const maxWidth = Math.max(0, ownerWindow.innerWidth - gap * 2);
        content.style.setProperty('--sl-popover-max-height', `${maxHeight}px`);
        content.style.setProperty('--sl-popover-max-width', `${maxWidth}px`);
        const contentBox = content.getBoundingClientRect();
        const canOpenBelow =
          triggerBox.bottom + gap + contentBox.height <= ownerWindow.innerHeight - gap;
        const side =
          placement === 'above' || (placement === 'auto' && !canOpenBelow) ? 'above' : 'below';
        const top =
          side === 'above'
            ? Math.max(gap, triggerBox.top - gap - contentBox.height)
            : Math.min(ownerWindow.innerHeight - contentBox.height - gap, triggerBox.bottom + gap);
        const left = Math.max(
          gap,
          Math.min(triggerBox.left, Math.max(gap, ownerWindow.innerWidth - contentBox.width - gap))
        );
        setPosition({ left, side, top });
      };
      update();
      const ownerWindow = triggerRef.current.ownerDocument.defaultView;
      ownerWindow?.addEventListener('resize', update);
      ownerWindow?.addEventListener('scroll', update, true);
      const ResizeObserver = ownerWindow?.ResizeObserver;
      const observer = ResizeObserver === undefined ? undefined : new ResizeObserver(update);
      observer?.observe(triggerRef.current);
      observer?.observe(contentRef.current);
      return () => {
        active = false;
        ownerWindow?.removeEventListener('resize', update);
        ownerWindow?.removeEventListener('scroll', update, true);
        observer?.disconnect();
      };
    }, [open, placement, portalHost]);
    useEffect(() => {
      const ownerDocument = triggerRef.current?.ownerDocument;
      if (!open || ownerDocument === undefined) return;
      const stack = popoverStackFor(ownerDocument);
      stack.push({ token });
      const outside = (event: PointerEvent) => {
        const target = event.target;
        if (
          stack.at(-1)?.token === token &&
          target !== null &&
          typeof (target as Node).nodeType === 'number' &&
          !triggerRef.current?.contains(target as Node) &&
          !contentRef.current?.contains(target as Node)
        )
          request(false, false);
      };
      const key = (event: globalThis.KeyboardEvent) => {
        if (event.key === 'Escape' && stack.at(-1)?.token === token) {
          event.preventDefault();
          request(false, true);
        }
      };
      ownerDocument.addEventListener('pointerdown', outside);
      ownerDocument.addEventListener('keydown', key, true);
      return () => {
        ownerDocument.removeEventListener('pointerdown', outside);
        ownerDocument.removeEventListener('keydown', key, true);
        const index = stack.findIndex((record) => record.token === token);
        if (index >= 0) stack.splice(index, 1);
      };
    }, [open, request, token]);
    return (
      <span className="sl-popover">
        <button
          aria-controls={open ? id : undefined}
          aria-expanded={open}
          aria-haspopup="dialog"
          className="sl-popover__trigger"
          onClick={() => request(!open, !open)}
          ref={triggerRef}
          type="button"
        >
          {safeTriggerText}
        </button>
        {open
          ? portalOverlay(
              <div
                aria-label={safeContentLabel}
                className="sl-popover__content"
                data-placement={position?.side ?? 'below'}
                id={id}
                ref={contentRef}
                role="dialog"
                style={
                  position === undefined
                    ? undefined
                    : ({
                        '--sl-popover-left': `${position.left}px`,
                        '--sl-popover-top': `${position.top}px`
                      } as CSSProperties)
                }
              >
                {children}
              </div>,
              theme,
              portalHost,
              overlayOwner
            )
          : null}
      </span>
    );
  }
);
