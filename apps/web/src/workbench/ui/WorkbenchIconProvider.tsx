import React from 'react';
import { CutoutIconProvider, DEBRUTE_CUTOUT_ICONS } from './icons';

export const {
  AlertTriangle,
  Bell,
  AudioLines,
  Boxes,
  Cable,
  ChevronRight,
  CircleDot,
  Clipboard,
  Clock3,
  Copy,
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
  Terminal,
  Trash2,
  Video,
  WandSparkles,
  X
} = DEBRUTE_CUTOUT_ICONS;

export function WorkbenchIconProvider({ children }: { children: React.ReactNode }): React.ReactElement {
  return (
    <CutoutIconProvider size={16}>
      {children}
    </CutoutIconProvider>
  );
}
