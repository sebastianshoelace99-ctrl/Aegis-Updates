/**
 * Tiny inline glyph set.
 *
 * Inline SVG rather than an icon font or a package: the CSP allows markup, the glyphs inherit
 * `currentColor`, and `width`/`height` are presentation attributes rather than `style`, so
 * nothing here needs `'unsafe-inline'`. One sprite file also stops each component inventing
 * its own chevron.
 */

type GlyphProps = { className?: string };

function Frame({ className, children }: GlyphProps & { children: React.ReactNode }) {
  return (
    <svg
      className={className}
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.9"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

export function HashGlyph({ className }: GlyphProps): React.JSX.Element {
  return (
    <Frame className={className}>
      <line x1="4" y1="9" x2="20" y2="9" />
      <line x1="4" y1="15" x2="20" y2="15" />
      <line x1="10" y1="3" x2="8" y2="21" />
      <line x1="16" y1="3" x2="14" y2="21" />
    </Frame>
  );
}

export function MediaGlyph({ className }: GlyphProps): React.JSX.Element {
  return (
    <Frame className={className}>
      <path d="M12 2 2 7l10 5 10-5-10-5Z" />
      <path d="m2 17 10 5 10-5" />
      <path d="m2 12 10 5 10-5" />
    </Frame>
  );
}

export function ChevronGlyph({ className }: GlyphProps): React.JSX.Element {
  return (
    <Frame className={className}>
      <polyline points="6 9 12 15 18 9" />
    </Frame>
  );
}

export function PaperclipGlyph({ className }: GlyphProps): React.JSX.Element {
  return (
    <Frame className={className}>
      <path d="M21.4 11.1 12.2 20.3a6 6 0 0 1-8.5-8.5l9.2-9.2a4 4 0 0 1 5.7 5.7l-9.2 9.2a2 2 0 0 1-2.8-2.8l8.5-8.5" />
    </Frame>
  );
}

export function SendGlyph({ className }: GlyphProps): React.JSX.Element {
  return (
    <Frame className={className}>
      <path d="M22 2 11 13" />
      <path d="M22 2 15 22l-4-9-9-4 20-7Z" />
    </Frame>
  );
}

export function SearchGlyph({ className }: GlyphProps): React.JSX.Element {
  return (
    <Frame className={className}>
      <circle cx="11" cy="11" r="7" />
      <line x1="21" y1="21" x2="16.5" y2="16.5" />
    </Frame>
  );
}

/** A speech bubble: the DM space in the rail, and the opening banner of a DM conversation. */
export function ChatGlyph({ className }: GlyphProps): React.JSX.Element {
  return (
    <Frame className={className}>
      <path d="M21 11.5a8.4 8.4 0 0 1-8.5 8.3 9.1 9.1 0 0 1-3.8-.8L3 21l2.1-5a8 8 0 0 1-1.1-4A8.4 8.4 0 0 1 12.5 3 8.4 8.4 0 0 1 21 11.5Z" />
    </Frame>
  );
}

export function MembersGlyph({ className }: GlyphProps): React.JSX.Element {
  return (
    <Frame className={className}>
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M22 21v-2a4 4 0 0 0-3-3.9" />
      <path d="M16 3.1a4 4 0 0 1 0 7.8" />
    </Frame>
  );
}

export function SunGlyph({ className }: GlyphProps): React.JSX.Element {
  return (
    <Frame className={className}>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
    </Frame>
  );
}

export function MoonGlyph({ className }: GlyphProps): React.JSX.Element {
  return (
    <Frame className={className}>
      <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z" />
    </Frame>
  );
}

/** "System" mode: the OS decides, so the icon is a display, not a sun or a moon. */
export function MonitorGlyph({ className }: GlyphProps): React.JSX.Element {
  return (
    <Frame className={className}>
      <rect x="2" y="4" width="20" height="13" rx="2" />
      <line x1="8" y1="21" x2="16" y2="21" />
      <line x1="12" y1="17" x2="12" y2="21" />
    </Frame>
  );
}


export function PlusGlyph({ className }: GlyphProps): React.JSX.Element {
  return (
    <Frame className={className}>
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </Frame>
  );
}

/* Template glyphs. One per starting point, so a tile is recognisable before it is read. */

export function GamepadGlyph({ className }: GlyphProps): React.JSX.Element {
  return (
    <Frame className={className}>
      <rect x="2" y="7" width="20" height="11" rx="5.5" />
      <line x1="7" y1="11" x2="7" y2="14" />
      <line x1="5.5" y1="12.5" x2="8.5" y2="12.5" />
      <circle cx="16" cy="12" r="0.9" />
      <circle cx="18.5" cy="14" r="0.9" />
    </Frame>
  );
}

export function BookGlyph({ className }: GlyphProps): React.JSX.Element {
  return (
    <Frame className={className}>
      <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
      <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2Z" />
      <line x1="9" y1="7" x2="16" y2="7" />
    </Frame>
  );
}

export function PencilGlyph({ className }: GlyphProps): React.JSX.Element {
  return (
    <Frame className={className}>
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
    </Frame>
  );
}

export function SparkleGlyph({ className }: GlyphProps): React.JSX.Element {
  return (
    <Frame className={className}>
      <path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9Z" />
      <path d="M18.5 15.5l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7Z" />
    </Frame>
  );
}

export function CompassGlyph({ className }: GlyphProps): React.JSX.Element {
  return (
    <Frame className={className}>
      <circle cx="12" cy="12" r="9" />
      <polygon points="16.2 7.8 14.1 14.1 7.8 16.2 9.9 9.9" />
    </Frame>
  );
}

/* Voice, settings and profile glyphs. Same 24px frame, so controls line up with the chat glyphs. */

export function SpeakerGlyph({ className }: GlyphProps): React.JSX.Element {
  return (
    <Frame className={className}>
      <path d="M11 5 6 9H3v6h3l5 4V5Z" />
      <path d="M15.5 8.5a5 5 0 0 1 0 7" />
      <path d="M18.5 5.5a9 9 0 0 1 0 13" />
    </Frame>
  );
}

export function MicGlyph({ className }: GlyphProps): React.JSX.Element {
  return (
    <Frame className={className}>
      <rect x="9" y="2" width="6" height="11" rx="3" />
      <path d="M5 10v1a7 7 0 0 0 14 0v-1" />
      <line x1="12" y1="18" x2="12" y2="22" />
      <line x1="8" y1="22" x2="16" y2="22" />
    </Frame>
  );
}

export function MicOffGlyph({ className }: GlyphProps): React.JSX.Element {
  return (
    <Frame className={className}>
      <line x1="3" y1="3" x2="21" y2="21" />
      <path d="M9 5.5V5a3 3 0 0 1 6 0v6a3 3 0 0 1-.4 1.5" />
      <path d="M5 10v1a7 7 0 0 0 11.4 5.4" />
      <line x1="12" y1="18" x2="12" y2="22" />
      <line x1="8" y1="22" x2="16" y2="22" />
    </Frame>
  );
}

export function HeadphonesGlyph({ className }: GlyphProps): React.JSX.Element {
  return (
    <Frame className={className}>
      <path d="M3 18v-6a9 9 0 0 1 18 0v6" />
      <path d="M21 19a2 2 0 0 1-2 2h-1v-6h1a2 2 0 0 1 2 2v2Z" />
      <path d="M3 19a2 2 0 0 0 2 2h1v-6H5a2 2 0 0 0-2 2v2Z" />
    </Frame>
  );
}

export function HeadphonesOffGlyph({ className }: GlyphProps): React.JSX.Element {
  return (
    <Frame className={className}>
      <line x1="3" y1="3" x2="21" y2="21" />
      <path d="M3 18v-6a9 9 0 0 1 14.5-7.3" />
      <path d="M21 18v-6a9 9 0 0 0-1.2-4.5" />
      <path d="M21 19a2 2 0 0 1-2 2h-1v-6h1a2 2 0 0 1 2 2v2Z" />
      <path d="M3 19a2 2 0 0 0 2 2h1v-6H5a2 2 0 0 0-2 2v2Z" />
    </Frame>
  );
}

export function VideoGlyph({ className }: GlyphProps): React.JSX.Element {
  return (
    <Frame className={className}>
      <rect x="2" y="6" width="14" height="12" rx="2" />
      <polygon points="16 10 22 7 22 17 16 14" />
    </Frame>
  );
}

export function VideoOffGlyph({ className }: GlyphProps): React.JSX.Element {
  return (
    <Frame className={className}>
      <line x1="3" y1="3" x2="21" y2="21" />
      <path d="M10.5 6H14a2 2 0 0 1 2 2v3.5" />
      <path d="M2 8v8a2 2 0 0 0 2 2h10a2 2 0 0 0 1.4-.6" />
      <polygon points="16 10 22 7 22 17 16 14" />
    </Frame>
  );
}

export function ScreenGlyph({ className }: GlyphProps): React.JSX.Element {
  return (
    <Frame className={className}>
      <rect x="2" y="3" width="20" height="14" rx="2" />
      <line x1="8" y1="21" x2="16" y2="21" />
      <line x1="12" y1="17" x2="12" y2="21" />
      <polyline points="9 10 12 7 15 10" />
    </Frame>
  );
}

export function PhoneOffGlyph({ className }: GlyphProps): React.JSX.Element {
  return (
    <Frame className={className}>
      <path d="M10.7 13.3a11 11 0 0 0 3.1 2l1.6-1.6a1.5 1.5 0 0 1 1.6-.3c1 .4 2 .7 3 .8A1.5 1.5 0 0 1 21 15.7V19a2 2 0 0 1-2.2 2A17 17 0 0 1 3 5.2 2 2 0 0 1 5 3h3.3a1.5 1.5 0 0 1 1.5 1.3c.1 1 .4 2 .8 3a1.5 1.5 0 0 1-.3 1.6l-1.6 1.6" />
      <line x1="3" y1="3" x2="21" y2="21" />
    </Frame>
  );
}

export function SettingsGlyph({ className }: GlyphProps): React.JSX.Element {
  return (
    <Frame className={className}>
      <line x1="4" y1="7" x2="20" y2="7" />
      <line x1="4" y1="17" x2="20" y2="17" />
      <circle cx="9" cy="7" r="2" />
      <circle cx="15" cy="17" r="2" />
    </Frame>
  );
}

export function CloseGlyph({ className }: GlyphProps): React.JSX.Element {
  return (
    <Frame className={className}>
      <line x1="5" y1="5" x2="19" y2="19" />
      <line x1="19" y1="5" x2="5" y2="19" />
    </Frame>
  );
}

export function CheckGlyph({ className }: GlyphProps): React.JSX.Element {
  return (
    <Frame className={className}>
      <polyline points="4 12 9 17 20 6" />
    </Frame>
  );
}

export function LinkGlyph({ className }: GlyphProps): React.JSX.Element {
  return (
    <Frame className={className}>
      <path d="M10 13a5 5 0 0 0 7.5.5l2-2a5 5 0 0 0-7-7l-1.2 1.2" />
      <path d="M14 11a5 5 0 0 0-7.5-.5l-2 2a5 5 0 0 0 7 7l1.2-1.2" />
    </Frame>
  );
}

export function ImageGlyph({ className }: GlyphProps): React.JSX.Element {
  return (
    <Frame className={className}>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <circle cx="8.5" cy="9.5" r="1.5" />
      <path d="m21 15-4.5-4.5L7 20" />
    </Frame>
  );
}

export function CrownGlyph({ className }: GlyphProps): React.JSX.Element {
  return (
    <Frame className={className}>
      <path d="M3 8l4 3 5-6 5 6 4-3-2 11H5L3 8Z" />
      <line x1="5" y1="19" x2="19" y2="19" />
    </Frame>
  );
}

export function BellGlyph({ className }: GlyphProps): React.JSX.Element {
  return (
    <Frame className={className}>
      <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
      <path d="M13.7 21a2 2 0 0 1-3.4 0" />
    </Frame>
  );
}

export function BellOffGlyph({ className }: GlyphProps): React.JSX.Element {
  return (
    <Frame className={className}>
      <line x1="3" y1="3" x2="21" y2="21" />
      <path d="M18.6 13c-.4-1.5-.6-3-.6-5a6 6 0 0 0-9.3-5" />
      <path d="M6 8c0 7-3 9-3 9h12" />
      <path d="M13.7 21a2 2 0 0 1-3.4 0" />
    </Frame>
  );
}
