import React from 'react';
import { CutoutIconProvider, DEBRUTE_CUTOUT_ICONS } from './icons.js';

export type { CutoutIcon, CutoutIconProps } from './icons.js';

export const {
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
} = DEBRUTE_CUTOUT_ICONS;

export function WorkbenchIconProvider({ children }: { children: React.ReactNode }): React.ReactElement {
  return (
    <CutoutIconProvider size={16}>
      {children}
    </CutoutIconProvider>
  );
}
