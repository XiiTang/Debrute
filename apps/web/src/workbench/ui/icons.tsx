import React from 'react';

export interface CutoutIconProps extends Omit<React.SVGAttributes<SVGSVGElement>, 'children'> {
  size?: number | string;
}

export type CutoutIcon = React.ForwardRefExoticComponent<CutoutIconProps & React.RefAttributes<SVGSVGElement>>;

interface CutoutIconDefaults {
  size: number | string;
}

const CutoutIconContext = React.createContext<CutoutIconDefaults>({ size: 16 });

export function CutoutIconProvider({
  size = 16,
  children
}: {
  size?: number | string;
  children: React.ReactNode;
}): React.ReactElement {
  return <CutoutIconContext.Provider value={{ size }}>{children}</CutoutIconContext.Provider>;
}

function makeIcon(name: string, artwork: React.ReactNode): CutoutIcon {
  const Icon = React.forwardRef<SVGSVGElement, CutoutIconProps>(function DebruteCutoutIcon({
    size,
    ...props
  }, ref): React.ReactElement {
    const defaults = React.useContext(CutoutIconContext);
    const dimension = size ?? defaults.size;
    return (
      <svg
        {...props}
        ref={ref}
        width={dimension}
        height={dimension}
        viewBox="0 0 20 20"
        fill="currentColor"
        xmlns="http://www.w3.org/2000/svg"
        aria-hidden={props['aria-label'] ? undefined : true}
        focusable="false"
        data-debrute-icon={name}
      >
        {artwork}
      </svg>
    );
  });
  Icon.displayName = `DebruteCutoutIcon(${name})`;
  return Icon;
}

const alertTriangle = <path fillRule="evenodd" d="M10 1L19 18H1L10 1Zm-1 5v6h2V6H9Zm0 8v2h2v-2H9Z"/>;
const file = <path fillRule="evenodd" d="M4 1h8l4 4v14H4V1Zm8 1.8V6h3.2L12 2.8Z"/>;
const folder = <path d="M1 4h7l2 2h9v12H1V4Z"/>;
const refresh = <path d="M15.6 3.2V1L19 4.4l-3.4 3.4V5.5a6 6 0 1 0 0 9l1.7 1.6A8.3 8.3 0 1 1 15.6 3.2Z"/>;
const eye = <path fillRule="evenodd" d="M1 10c2.1-3.5 5.1-5.2 9-5.2s6.9 1.7 9 5.2c-2.1 3.5-5.1 5.2-9 5.2S3.1 13.5 1 10Zm9-3a3 3 0 1 0 0 6 3 3 0 0 0 0-6Z"/>;
const terminal = <path d="M2 2h16v16H2V2Zm2 3v2l3 3-3 3v2l5-5-5-5Zm6 8v2h5v-2h-5Z"/>;
const settings = <path fillRule="evenodd" d="m8.3 1 .4 2.1c.5-.1.9-.1 1.3-.1s.8 0 1.3.1l.4-2.1 3 1.2-.9 1.9c.7.5 1.3 1.1 1.8 1.8l1.9-.9 1.2 3-2.1.4c.1.5.1.9.1 1.3s0 .8-.1 1.3l2.1.4-1.2 3-1.9-.9c-.5.7-1.1 1.3-1.8 1.8l.9 1.9-3 1.2-.4-2.1c-.5.1-.9.1-1.3.1s-.8 0-1.3-.1l-.4 2.1-3-1.2.9-1.9a8 8 0 0 1-1.8-1.8l-1.9.9-1.2-3 2.1-.4a7 7 0 0 1 0-2.6L1.3 8l1.2-3 1.9.9c.5-.7 1.1-1.3 1.8-1.8l-.9-1.9L8.3 1ZM10 6.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7Z"/>;

const AlertCircle = makeIcon('alert-circle', <path fillRule="evenodd" d="M10 1a9 9 0 1 1 0 18 9 9 0 0 1 0-18ZM9 5v7h2V5H9Zm0 9v2h2v-2H9Z"/>);
const AlertTriangle = makeIcon('alert-triangle', alertTriangle);
const AudioLines = makeIcon('audio-lines', <path d="M2 7h2v6H2V7Zm4-3h2v12H6V4Zm4 2h2v8h-2V6Zm4-5h2v18h-2V1Zm4 7h2v4h-2V8Z"/>);
const Boxes = makeIcon('boxes', <path d="m10 1 5 2.8v5.6L10 12 5 9.4V3.8L10 1ZM4 10l5 2.8v5.6L4 16V10Zm12 0v6l-5 2.4v-5.6l5-2.8Z"/>);
const Cable = makeIcon('cable', <path d="M3 1h5v4H6v4h8V5h-2V1h5v6h-1v3c0 .7-.3 1.2-1 1.6V15h2v4h-6v-4h2v-3H7c-2 0-3-1-3-3V7H3V1Z"/>);
const Check = makeIcon('check', <path d="m2 10 3-3 4 4 7-8 3 3L9 17 2 10Z"/>);
const ChevronRight = makeIcon('chevron-right', <path d="m6 2 9 8-9 8V2Z"/>);
const CircleDot = makeIcon('circle-dot', <path fillRule="evenodd" d="M10 1a9 9 0 1 1 0 18 9 9 0 0 1 0-18Zm0 3a6 6 0 1 0 0 12 6 6 0 0 0 0-12Zm0 3a3 3 0 1 1 0 6 3 3 0 0 1 0-6Z"/>);
const Clipboard = makeIcon('clipboard', <path fillRule="evenodd" d="M7 1h6l1 2h3v16H3V3h3l1-2Zm0 5v2h6V6H7Zm0 4v2h7v-2H7Zm0 4v2h5v-2H7Z"/>);
const Clock3 = makeIcon('clock', <path fillRule="evenodd" d="M10 1a9 9 0 1 1 0 18 9 9 0 0 1 0-18Zm-1 4v6l5 3 1-2-4-2.3V5H9Z"/>);
const Copy = makeIcon('copy', <path fillRule="evenodd" d="M6 1h13v13h-5v5H1V6h5V1Zm2 5h6v6h3V3H8v3Zm4 2H3v9h9V8Z"/>);
const Download = makeIcon('download', <path d="M8 1h4v8h4l-6 6-6-6h4V1ZM2 16h16v3H2v-3Z"/>);
const Edit3 = makeIcon('edit', <path d="m14 1 5 5L8 17l-7 2 2-7L14 1Zm-9 12-.8 2.8L7 15l8.8-8.8-2-2L5 13Z"/>);
const Eye = makeIcon('eye', eye);
const EyeOff = makeIcon('eye-off', <><path d="M1 3 17 19l2-2L3 1 1 3Z"/><path d="M4.3 6.3C2.9 7.2 1.8 8.4 1 10c2.1 3.5 5.1 5.2 9 5.2.7 0 1.4-.1 2-.2L9.8 12.8A3 3 0 0 1 7.2 10L4.3 6.3ZM10 4.8c3.9 0 6.9 1.7 9 5.2a11 11 0 0 1-2.5 3.1L8.4 5c.5-.1 1-.2 1.6-.2Z"/></>);
const File = makeIcon('file', file);
const FilePlus2 = makeIcon('file-plus', <><path d="M4 1h8l4 4v5h-2V6h-3V3H6v14h5v2H4V1Z"/><path d="M14 11h2v3h3v2h-3v3h-2v-3h-3v-2h3v-3Z"/></>);
const FileText = makeIcon('file-text', <path fillRule="evenodd" d="M4 1h8l4 4v14H4V1Zm8 2v3h3l-3-3ZM7 9v2h6V9H7Zm0 4v2h6v-2H7Z"/>);
const Folder = makeIcon('folder', folder);
const FolderOpen = makeIcon('folder-open', <path d="M1 5h7l2 2h9l-3 11H1V5Zm3 5-1 6h11l2-6H4Z"/>);
const FolderPlus = makeIcon('folder-plus', <path fillRule="evenodd" d="M1 4h7l2 2h9v12H1V4Zm8 4v3H6v2h3v3h2v-3h3v-2h-3V8H9Z"/>);
const FolderTree = makeIcon('folder-tree', <><path d="M1 2h7l2 2h8v6H8V5H1V2Z"/><path d="M2 7h2v7h4v-2h5v2h4v5h-6v-3H2V7Z"/></>);
const Heart = makeIcon('heart', <path d="M10 18 2.5 11C-2 6.5 4 1 10 6c6-5 12 0 7.5 5L10 18Z"/>);
const Image = makeIcon('image', <path fillRule="evenodd" d="M1 2h18v16H1V2Zm3 3v8l4-4 3 3 2-2 3 3V5H4Zm9 1a2 2 0 1 0 0 4 2 2 0 0 0 0-4Z"/>);
const Info = makeIcon('info', <path fillRule="evenodd" d="M10 1a9 9 0 1 1 0 18 9 9 0 0 1 0-18ZM9 5v2h2V5H9Zm0 4v6h2V9H9Z"/>);
const KeyRound = makeIcon('key', <path fillRule="evenodd" d="M7 1a6 6 0 0 1 5.6 8.2L19 15.6V19h-3v-2h-2v-2h-2.4l-1.4-1.4A6 6 0 1 1 7 1Zm0 3a3 3 0 1 0 0 6 3 3 0 0 0 0-6Z"/>);
const Link2 = makeIcon('link', <path d="M8 5h-2a5 5 0 0 0 0 10h4v-3H6a2 2 0 0 1 0-4h2V5Zm4 0h2a5 5 0 0 1 0 10h-4v-3h4a2 2 0 0 0 0-4h-2V5ZM6 9h8v3H6V9Z"/>);
const Loader2 = makeIcon('loader', <path d="M10 1a9 9 0 0 1 8.3 5.5l-2.8 1.1A6 6 0 0 0 10 4V1Zm8.9 8a9 9 0 0 1-7.4 9.9l-.5-3a6 6 0 0 0 5-6.6l2.9-.3ZM9 18.9A9 9 0 0 1 1.1 11l3-.3A6 6 0 0 0 9.4 16l-.4 2.9ZM1.1 9A9 9 0 0 1 7.9 1.2l.7 2.9A6 6 0 0 0 4 9.3L1.1 9Z"/>);
const LocateFixed = makeIcon('locate', <path fillRule="evenodd" d="M9 1h2v3a6 6 0 0 1 5 5h3v2h-3a6 6 0 0 1-5 5v3H9v-3a6 6 0 0 1-5-5H1V9h3a6 6 0 0 1 5-5V1Zm1 6a3 3 0 1 0 0 6 3 3 0 0 0 0-6Z"/>);
const Map = makeIcon('map', <path d="m1 3 6-2 6 2 6-2v16l-6 2-6-2-6 2V3Zm7 .4v11.8l4 1.4V4.8L8 3.4Z"/>);
const MapPin = makeIcon('map-pin', <path fillRule="evenodd" d="M10 1a7 7 0 0 1 7 7c0 5-7 11-7 11S3 13 3 8a7 7 0 0 1 7-7Zm0 4a3 3 0 1 0 0 6 3 3 0 0 0 0-6Z"/>);
const Maximize2 = makeIcon('maximize', <path d="M2 2h7v3H5v4H2V2Zm9 0h7v7h-3V5h-4V2ZM2 11h3v4h4v3H2v-7Zm13 0h3v7h-7v-3h4v-4Z"/>);
const Minus = makeIcon('minus', <path d="M2 9h16v3H2V9Z"/>);
const Music = makeIcon('music', <path d="M7 3 18 1v13a4 4 0 1 1-3-3.9V5L8 6.3V15a4 4 0 1 1-3-3.9V3.4L7 3Z"/>);
const Music2 = makeIcon('music-two', <path d="M8 3 18 1v12a4 4 0 1 1-3-3.9V5L9 6.2V15a4 4 0 1 1-3-3.9V3.4L8 3Z"/>);
const Plus = makeIcon('plus', <path d="M8.5 2h3v6.5H18v3h-6.5V18h-3v-6.5H2v-3h6.5V2Z"/>);
const RefreshCw = makeIcon('refresh', refresh);
const RotateCcw = makeIcon('rotate-counterclockwise', <path d="M4.4 3.4V1L1 4.4l3.4 3.4V5.6A7 7 0 1 1 3 13l-2.8 1A10 10 0 1 0 4.4 3.4Z"/>);
const RotateCw = makeIcon('rotate-clockwise', refresh);
const Save = makeIcon('save', <path fillRule="evenodd" d="M2 1h13l3 3v15H2V1Zm3 2v5h9V3H5Zm1 9v5h8v-5H6Z"/>);
const Scissors = makeIcon('scissors', <path fillRule="evenodd" d="M5 1a4 4 0 0 1 3.2 6.4L10 9l7-7 2 2-7 7 1.8 1.6A4 4 0 1 1 11.9 15L9.6 13 8 14.6A4 4 0 1 1 5 12c.5 0 .9.1 1.3.2L8 10.5 6.3 8.8A4 4 0 1 1 5 1Zm0 2a2 2 0 1 0 0 4 2 2 0 0 0 0-4Zm10 11a2 2 0 1 0 0 4 2 2 0 0 0 0-4ZM5 14a2 2 0 1 0 0 4 2 2 0 0 0 0-4Z"/>);
const Send = makeIcon('send', <path d="M1 2 19 10 1 18l2-7 9-1-9-1-2-7Z"/>);
const Settings = makeIcon('settings', settings);
const Square = makeIcon('square', <path fillRule="evenodd" d="M2 2h16v16H2V2Zm3 3v10h10V5H5Z"/>);
const Star = makeIcon('star', <path d="m10 1 2.8 5.8L19 7.7l-4.5 4.4 1.1 6.2-5.6-3-5.6 3 1.1-6.2L1 7.7l6.2-.9L10 1Z"/>);
const Terminal = makeIcon('terminal', terminal);
const ThumbsDown = makeIcon('thumbs-down', <path d="M2 2h4v11H2V2Zm6 0h7l3 3v7l-2 2h-3v5h-3l-2-7V2Z"/>);
const Trash2 = makeIcon('trash', <path fillRule="evenodd" d="M6 1h8l1 2h4v3H1V3h4l1-2ZM3 8h14l-1 11H4L3 8Zm4 2v6h2v-6H7Zm4 0v6h2v-6h-2Z"/>);
const Unlink = makeIcon('unlink', <><path d="m1 3 16 16 2-2L3 1 1 3Z"/><path d="M7 5H6a5 5 0 0 0 0 10h2v-3H6a2 2 0 0 1 0-4h1V5Zm6 3h1a2 2 0 0 1 0 4h-1l3 3a5 5 0 0 0-2-10h-1v3Z"/></>);
const Upload = makeIcon('upload', <path d="m10 1 6 6h-4v7H8V7H4l6-6ZM2 16h16v3H2v-3Z"/>);
const Video = makeIcon('video', <path d="M1 4h12v12H1V4Zm13 4 5-3v10l-5-3V8Z"/>);
const WandSparkles = makeIcon('wand', <path d="m12 1 2 4 4 2-4 2-2 4-2-4-4-2 4-2 2-4ZM4 10l2 2 9 7 4-4-9-7-2-2-4 4ZM3 1l1 2 2 1-2 1-1 2-1-2-2-1 2-1 1-2Z"/>);
const Wrench = makeIcon('wrench', <path d="M12 1a6 6 0 0 0-5.5 8.4L1 15v4h4l5.6-5.5A6 6 0 0 0 19 8l-4 2-3-3 2-4c-.6-.6-1.3-1-2-1Z"/>);
const X = makeIcon('x', <path d="m3 1 7 7 7-7 2 2-7 7 7 7-2 2-7-7-7 7-2-2 7-7-7-7 2-2Z"/>);

export const DEBRUTE_CUTOUT_ICONS = {
  AlertCircle,
  AlertTriangle,
  AudioLines,
  Boxes,
  Cable,
  Check,
  ChevronRight,
  CircleDot,
  Clipboard,
  Clock3,
  Copy,
  Download,
  Edit3,
  Eye,
  EyeOff,
  File,
  FilePlus2,
  FileText,
  Folder,
  FolderOpen,
  FolderPlus,
  FolderTree,
  Heart,
  Image,
  Info,
  KeyRound,
  Link2,
  Loader2,
  LocateFixed,
  Map,
  MapPin,
  Maximize2,
  Minus,
  Music,
  Music2,
  Plus,
  RefreshCw,
  RotateCcw,
  RotateCw,
  Save,
  Scissors,
  Send,
  Settings,
  Square,
  Star,
  Terminal,
  ThumbsDown,
  Trash2,
  Unlink,
  Upload,
  Video,
  WandSparkles,
  Wrench,
  X
} as const;
