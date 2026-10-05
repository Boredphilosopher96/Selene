import type { CSSProperties } from 'react';

type StudioIconName =
  | 'canvas'
  | 'components'
  | 'play'
  | 'undo'
  | 'redo'
  | 'connections'
  | 'hand'
  | 'fit'
  | 'inspect'
  | 'sparkles'
  | 'folder'
  | 'arrow'
  | 'check'
  | 'shield'
  | 'close'
  | 'chevron';

const paths: Record<StudioIconName, string> = {
  canvas: 'M4 4h16v16H4z M4 9h16 M9 9v11',
  components: 'M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z',
  play: 'm8 5 11 7-11 7z',
  undo: 'M8 5 3 10l5 5 M3 10h11a6 6 0 0 1 6 6v3',
  redo: 'm16 5 5 5-5 5 M21 10H10a6 6 0 0 0-6 6v3',
  connections: 'M3 3h6v6H3z M15 15h6v6h-6z M9 6h6v12 M15 18h-6',
  hand: 'M8 12V6a2 2 0 0 1 4 0v5 M12 11V4a2 2 0 0 1 4 0v8 M16 11V7a2 2 0 0 1 4 0v9c0 4-3 6-7 6h-1c-2 0-4-1-5-3l-4-6a2 2 0 0 1 3-2l2 3',
  fit: 'M8 3H3v5 M16 3h5v5 M21 16v5h-5 M8 21H3v-5 M8 8h8v8H8z',
  inspect: 'M4 4h16v16H4z M14 4v16 M7 8h4 M7 12h4 M7 16h4',
  sparkles: 'm12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5z M20 3v4 M18 5h4',
  folder: 'M3 6h7l2 3h9v11H3z',
  arrow: 'M4 12h16 m-6-6 6 6-6 6',
  check: 'm5 12 4 4L19 6',
  close: 'm6 6 12 12 M18 6 6 18',
  chevron: 'm9 5 7 7-7 7',
  shield: 'm12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6z m-4 9 3 3 5-6'
};

/** Small code-native studio glyphs; no icon/font dependency or network request. */
export function StudioIcon({
  name,
  className = '',
  style
}: {
  readonly name: StudioIconName;
  readonly className?: string;
  readonly style?: CSSProperties;
}) {
  return (
    <svg
      aria-hidden="true"
      className={`studio-icon ${className}`.trim()}
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.65"
      style={style}
      viewBox="0 0 24 24"
    >
      <path d={paths[name]} />
    </svg>
  );
}
