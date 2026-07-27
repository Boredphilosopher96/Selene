/**
 * Owns the navigation policy for a live preview independently of iframe and
 * MessageChannel lifecycles. A newly ready preview always receives the latest
 * policy, so mounting order cannot leave wheel/pinch forwarding stale.
 */
export class PreviewCanvasNavigation {
  private enabled = true;
  private previewReady = false;

  public constructor(private readonly publish: (enabled: boolean) => void) {}

  public setEnabled(enabled: boolean): void {
    if (this.enabled === enabled) return;
    this.enabled = enabled;
    if (this.previewReady) this.publish(enabled);
  }

  public previewAvailable(): void {
    this.previewReady = true;
    this.publish(this.enabled);
  }

  public previewUnavailable(): void {
    this.previewReady = false;
  }
}
