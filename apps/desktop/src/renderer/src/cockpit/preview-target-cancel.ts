/**
 * Publishes the narrow Escape-intent gate independently from iframe lifecycle.
 * The preview never receives a general keyboard bridge: it may only report
 * Escape while the desktop has explicitly armed a transient artifact target.
 */
export class PreviewTargetCancel {
  private enabled = false;
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
