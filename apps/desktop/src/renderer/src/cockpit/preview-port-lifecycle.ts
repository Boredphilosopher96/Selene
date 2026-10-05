/** Release handlers as well as the entanglement when a preview owner departs. */
export function closePreviewPort(owner: { current: MessagePort | null }): void {
  const port = owner.current;
  owner.current = null;
  if (port === null) return;
  port.onmessage = null;
  port.onmessageerror = null;
  port.close();
}
