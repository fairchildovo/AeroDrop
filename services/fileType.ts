export type FileType =
  | 'document'
  | 'spreadsheet'
  | 'presentation'
  | 'image'
  | 'video'
  | 'audio'
  | 'archive'
  | 'code'
  | 'json'
  | 'executable'
  | 'folder'
  | 'unknown';

export interface ResolveFileTypeInput {
  fileName?: string | null;
  mimeType?: string | null;
  isDirectory?: boolean;
}

const EXTENSION_TO_FILE_TYPE: Record<string, FileType> = {
  pdf: 'document',
  doc: 'document',
  docx: 'document',
  txt: 'document',
  md: 'document',
  rtf: 'document',

  xls: 'spreadsheet',
  xlsx: 'spreadsheet',
  csv: 'spreadsheet',

  ppt: 'presentation',
  pptx: 'presentation',
  key: 'presentation',

  jpg: 'image',
  jpeg: 'image',
  png: 'image',
  gif: 'image',
  webp: 'image',
  svg: 'image',
  bmp: 'image',
  ico: 'image',
  avif: 'image',

  mp4: 'video',
  mov: 'video',
  webm: 'video',
  mkv: 'video',
  avi: 'video',

  mp3: 'audio',
  wav: 'audio',
  flac: 'audio',
  m4a: 'audio',
  aac: 'audio',
  ogg: 'audio',

  zip: 'archive',
  rar: 'archive',
  '7z': 'archive',
  tar: 'archive',
  gz: 'archive',
  bz2: 'archive',
  xz: 'archive',

  js: 'code',
  ts: 'code',
  jsx: 'code',
  tsx: 'code',
  html: 'code',
  css: 'code',
  scss: 'code',
  sass: 'code',
  vue: 'code',
  py: 'code',
  java: 'code',
  kt: 'code',
  go: 'code',
  rs: 'code',
  c: 'code',
  cpp: 'code',
  h: 'code',
  hpp: 'code',
  sh: 'code',

  json: 'json',
  map: 'json',

  exe: 'executable',
  msi: 'executable',
  apk: 'executable',
  dmg: 'executable',
  pkg: 'executable',
  deb: 'executable',
  rpm: 'executable',
};

const getNormalizedExtension = (fileName?: string | null): string => {
  if (!fileName) return '';
  const normalizedName = fileName.replace(/\\/g, '/').split('/').pop() ?? fileName;
  const dotIndex = normalizedName.lastIndexOf('.');

  if (dotIndex <= 0 || dotIndex === normalizedName.length - 1) {
    return '';
  }

  return normalizedName.slice(dotIndex + 1).toLowerCase();
};

export const resolveFileType = (input: ResolveFileTypeInput): FileType => {
  if (input.isDirectory) {
    return 'folder';
  }

  const extension = getNormalizedExtension(input.fileName);
  if (extension && EXTENSION_TO_FILE_TYPE[extension]) {
    return EXTENSION_TO_FILE_TYPE[extension];
  }

  const mimeType = input.mimeType?.trim().toLowerCase() ?? '';
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType.startsWith('video/')) return 'video';
  if (mimeType.startsWith('audio/')) return 'audio';
  if (mimeType === 'application/json' || mimeType.endsWith('+json')) return 'json';
  if (mimeType.startsWith('text/')) return 'document';

  return 'unknown';
};
