import { applicationConfig } from '@selene/config';
import { PlaceholderPanel } from '@selene/ui';

export function App() {
  return (
    <main>
      <h1>{applicationConfig.productName}</h1>
      <PlaceholderPanel title="Application shell">
        Product experiences will be introduced by their owning design workstream.
      </PlaceholderPanel>
    </main>
  );
}
