import { applicationConfig } from '@selene/config';
import { PlaceholderPanel } from '@selene/ui';

export function App() {
  return (
    <main>
      <h1>{applicationConfig.productName} Desktop</h1>
      <PlaceholderPanel title="Desktop shell">
        Desktop-specific product behavior is intentionally pending design ownership.
      </PlaceholderPanel>
    </main>
  );
}
