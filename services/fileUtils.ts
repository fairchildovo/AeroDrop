
export const formatFileSize = (bytes: number): string => {
  if (bytes === 0) return '0 Bytes';
  if (bytes < 0) return '0 Bytes';
  if (!isFinite(bytes)) return '---';

  const k = 1024;
  if (bytes < 1) return parseFloat(bytes.toFixed(2)) + ' Bytes';

  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));

  if (i < 0) return parseFloat(bytes.toFixed(2)) + ' Bytes';
  if (i >= sizes.length) return parseFloat((bytes / Math.pow(k, sizes.length - 1)).toFixed(2)) + ' ' + sizes[sizes.length - 1];

  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
};

export const fileToBase64 = (file: File): Promise<string> => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.readAsDataURL(file);
    reader.onload = () => {
      const result = reader.result as string;
      const base64 = result.split(',')[1];
      resolve(base64);
    };
    reader.onerror = (error) => reject(error);
  });
};

export const readFileAsText = (file: File): Promise<string> => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.readAsText(file);
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = (error) => reject(error);
  });
};

export const generateFileFingerprint = (file: { name: string; size: number; type: string; lastModified: number }): string => {
  const str = `${file.name}|${file.size}|${file.type}|${file.lastModified}`;
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash) ^ str.charCodeAt(i);
  }
  return (hash >>> 0).toString(36);
};

export const generatePreview = async (file: File): Promise<string | undefined> => {
  if (file.type.startsWith('image/')) {
    if (file.size > 2 * 1024 * 1024) return undefined;
    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = () => resolve(undefined);
      reader.readAsDataURL(file);
    });
  }

  const binaryExtensions = ['.exe', '.dll', '.bin', '.iso', '.img', '.dmg', '.pkg', '.zip', '.rar', '.7z', '.tar', '.gz'];
  if (binaryExtensions.some(ext => file.name.toLowerCase().endsWith(ext))) {
      return undefined;
  }

  const isText = file.type.startsWith('text/') ||
                 file.name.endsWith('.txt') ||
                 file.name.endsWith('.md') ||
                 file.name.endsWith('.json') ||
                 file.name.endsWith('.js') ||
                 file.name.endsWith('.ts') ||
                 file.name.endsWith('.tsx') ||
                 file.name.endsWith('.csv') ||
                 file.name.endsWith('.html') ||
                 file.name.endsWith('.css');

  if (isText) {
     if (file.size > 100 * 1024) return undefined;
     try {
       const content = await readFileAsText(file);
       return content.slice(0, 300) + (content.length > 300 ? '...' : '');
     } catch (e) {
       return undefined;
     }
  }

  return undefined;
};
