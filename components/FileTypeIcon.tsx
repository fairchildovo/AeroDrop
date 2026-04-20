import React from 'react';
import type { LucideProps } from 'lucide-react';
import {
  Archive,
  Code,
  File,
  FileCog,
  FileJson,
  FileText,
  Folder,
  Image,
  Music,
  Presentation,
  Sheet,
  Video,
} from 'lucide-react';

import type { FileType } from '../services/fileType.ts';

interface FileTypeIconProps extends LucideProps {
  type: FileType;
}

const ICON_BY_TYPE: Record<FileType, React.ComponentType<LucideProps>> = {
  document: FileText,
  spreadsheet: Sheet,
  presentation: Presentation,
  image: Image,
  video: Video,
  audio: Music,
  archive: Archive,
  code: Code,
  json: FileJson,
  executable: FileCog,
  folder: Folder,
  unknown: File,
};

export const FileTypeIcon: React.FC<FileTypeIconProps> = ({
  type,
  size = 16,
  ...iconProps
}) => {
  const IconComponent = ICON_BY_TYPE[type] ?? File;
  return <IconComponent size={size} {...iconProps} />;
};