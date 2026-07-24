import { createElement, useEffect, type ReactNode } from 'react';
import type { Preview } from '@storybook/react-vite';

import './preview.css';

function StoryReady({
  children,
  storyId
}: {
  readonly children: ReactNode;
  readonly storyId: string;
}) {
  useEffect(() => {
    let disposed = false;
    const root = document.documentElement;
    root.dataset.seleneStoryReady = 'false';

    void document.fonts.ready.then(() => {
      if (!disposed) root.dataset.seleneStoryReady = storyId;
    });

    return () => {
      disposed = true;
      delete root.dataset.seleneStoryReady;
    };
  }, [storyId]);

  return children;
}

const preview: Preview = {
  decorators: [
    (Story, context) => createElement(StoryReady, { storyId: context.id }, createElement(Story))
  ],
  initialGlobals: {
    // Playwright owns the assertion. Prevent the addon from starting a competing axe scan.
    a11y: { manual: true }
  },
  parameters: {
    controls: { expanded: true },
    layout: 'centered'
  }
};

export default preview;
