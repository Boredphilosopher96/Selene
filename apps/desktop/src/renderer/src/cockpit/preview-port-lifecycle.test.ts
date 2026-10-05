import { expect, it, vi } from 'vitest';

import { closePreviewPort } from './preview-port-lifecycle';

it('clears the live owner and retained handlers before closing a departed preview port', () => {
  const listener = vi.fn();
  const port = {
    onmessage: listener,
    onmessageerror: listener,
    close: vi.fn(() => {
      expect(owner.current).toBeNull();
      expect(port.onmessage).toBeNull();
      expect(port.onmessageerror).toBeNull();
    })
  };
  const owner = { current: port as unknown as MessagePort | null };
  closePreviewPort(owner);
  expect(port.close).toHaveBeenCalledOnce();
  closePreviewPort(owner);
  expect(port.close).toHaveBeenCalledOnce();
});
