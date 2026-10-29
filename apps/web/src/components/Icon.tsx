import type { SVGProps } from 'react';

/**
 * The interface icon set: hand-drawn inline SVGs on one 24px grid with a single stroke weight,
 * so the whole app uses one consistent drawing hand and no icon package. Icons are decorative
 * by default (`aria-hidden`); an accessible name is supplied by the control that owns them.
 */
export type IconName =
  | 'compass'
  | 'upload'
  | 'download'
  | 'trash'
  | 'close'
  | 'search'
  | 'folder'
  | 'folder-plus'
  | 'file'
  | 'grid'
  | 'list'
  | 'sun'
  | 'moon'
  | 'key'
  | 'link'
  | 'refresh'
  | 'chevron-right'
  | 'chevron-down'
  | 'check'
  | 'alert'
  | 'info'
  | 'more'
  | 'pencil'
  | 'graph'
  | 'clock'
  | 'shield'
  | 'external'
  | 'sign-out'
  | 'user'
  | 'play'
  | 'pause'
  | 'rewind'
  | 'forward'
  | 'volume'
  | 'volume-off'
  | 'fullscreen'
  | 'exit-fullscreen'
  | 'pip'
  | 'settings';

const PATHS: Record<IconName, { d: string; fill?: boolean }[]> = {
  compass: [{ d: 'M12 3.2 13.9 10l6.1 2-6.1 2-1.9 6.8L10.1 14 4 12l6.1-2Z' }],
  upload: [{ d: 'M12 19V5M12 5l-5 5M12 5l5 5' }],
  download: [{ d: 'M12 5v14M12 19l-5-5M12 19l5-5' }],
  trash: [{ d: 'M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v6M14 11v6' }],
  close: [{ d: 'M6 6l12 12M18 6 6 18' }],
  search: [{ d: 'M11 4a7 7 0 1 1 0 14 7 7 0 0 1 0-14ZM16 16l4 4' }],
  folder: [{ d: 'M3 7h6l2 2h10v10H3z' }],
  'folder-plus': [{ d: 'M3 7h6l2 2h10v10H3zM12 11v6M9 14h6' }],
  file: [{ d: 'M6 3h8l4 4v14H6zM14 3v4h4' }],
  grid: [{ d: 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z' }],
  list: [{ d: 'M4 6h16M4 12h16M4 18h16' }],
  sun: [
    {
      d: 'M12 5V3M12 21v-2M5 12H3M21 12h-2M6.3 6.3 4.9 4.9M19.1 19.1l-1.4-1.4M6.3 17.7l-1.4 1.4M19.1 4.9l-1.4 1.4M12 8a4 4 0 1 1 0 8 4 4 0 0 1 0-8Z',
    },
  ],
  moon: [{ d: 'M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5Z' }],
  key: [{ d: 'M14 7a4 4 0 1 1 3.5 4L15 13.5V16h-2.5v2.5H10V21H6v-4l8-8Z' }],
  link: [
    { d: 'M10 13a4 4 0 0 1 0-6l2-2a4 4 0 0 1 6 6l-1 1M14 11a4 4 0 0 1 0 6l-2 2a4 4 0 0 1-6-6l1-1' },
  ],
  refresh: [{ d: 'M20 12a8 8 0 1 1-3-6.2M20 4v5h-5' }],
  'chevron-right': [{ d: 'M9 5l7 7-7 7' }],
  'chevron-down': [{ d: 'M5 9l7 7 7-7' }],
  check: [{ d: 'M4 12.5 9.5 18 20 6.5' }],
  alert: [{ d: 'M12 4 2.5 20h19zM12 10v5M12 17.4v.6' }],
  info: [{ d: 'M12 3a9 9 0 1 1 0 18 9 9 0 0 1 0-18ZM12 10v7M12 7.2v.6' }],
  more: [{ d: 'M6 12h.01M12 12h.01M18 12h.01' }],
  pencil: [{ d: 'M4 20h4l11-11-4-4L4 16zM14 6l4 4' }],
  graph: [{ d: 'M4 20V4M4 20h16M8 17V9M13 17v-5M18 17V6' }],
  clock: [{ d: 'M12 3a9 9 0 1 1 0 18 9 9 0 0 1 0-18ZM12 7v5l4 2' }],
  shield: [{ d: 'M12 3 5 6v6c0 4 3 7 7 9 4-2 7-5 7-9V6z' }],
  external: [{ d: 'M14 4h6v6M20 4l-9 9M18 14v6H4V6h6' }],
  'sign-out': [{ d: 'M15 4h4v16h-4M11 8l-4 4 4 4M7 12h9' }],
  user: [{ d: 'M12 4a4 4 0 1 1 0 8 4 4 0 0 1 0-8ZM4 21c0-4 3.6-7 8-7s8 3 8 7' }],
  play: [{ d: 'M8 4.8 19 12 8 19.2Z' }],
  pause: [{ d: 'M9 5v14M15 5v14' }],
  rewind: [{ d: 'M11 6 5 12l6 6M19 6l-6 6 6 6' }],
  forward: [{ d: 'M13 6l6 6-6 6M5 6l6 6-6 6' }],
  volume: [
    { d: 'M4 9h4l5-4v14l-5-4H4z' },
    { d: 'M16.5 8.5a5 5 0 0 1 0 7M19.2 6a8.5 8.5 0 0 1 0 12' },
  ],
  'volume-off': [{ d: 'M4 9h4l5-4v14l-5-4H4zM17 9l4 6M21 9l-4 6' }],
  fullscreen: [{ d: 'M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5' }],
  'exit-fullscreen': [{ d: 'M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5' }],
  pip: [{ d: 'M3 5h18v14H3zM12 12h7v5h-7z' }],
  settings: [{ d: 'M4 7h9M17 7h3M4 17h3M11 17h9M15 4v6M9 14v6' }],
};

export function Icon({
  name,
  size = 18,
  ...rest
}: { name: IconName; size?: number } & SVGProps<SVGSVGElement>) {
  const paths = PATHS[name];
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="square"
      strokeLinejoin="miter"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      {paths.map((path, index) => (
        <path key={index} d={path.d} />
      ))}
    </svg>
  );
}
