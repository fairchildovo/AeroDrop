export const formatFileSize = (bytes: number): string => {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
};

export const fileToBase64 = (file: File): Promise<string> => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.readAsDataURL(file);
    reader.onload = () => {
      const result = reader.result as string;
      // Remove data url prefix (e.g., "data:image/png;base64,")
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

export const generatePreview = async (file: File): Promise<string | undefined> => {
  if (file.type.startsWith('image/')) {
    if (file.size > 2 * 1024 * 1024) return undefined; // Limit preview to 2MB images
    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = () => resolve(undefined);
      reader.readAsDataURL(file);
    });
  }

  // Explicitly exclude binary/executable formats from text preview
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
     if (file.size > 100 * 1024) return undefined; // Limit text preview to 100KB files
     try {
       const content = await readFileAsText(file);
       return content.slice(0, 300) + (content.length > 300 ? '...' : '');
     } catch (e) {
       return undefined;
     }
  }

  return undefined;
};