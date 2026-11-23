export interface PickedFile {
  name: string;
  mime: string;
  bytes: Uint8Array;
  uri: string;
}

export function guessMime(name: string): string {
  const ext = name.toLowerCase().split('.').pop();
  switch (ext) {
    case 'pdf':
      return 'application/pdf';
    case 'png':
      return 'image/png';
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg';
    case 'webp':
      return 'image/webp';
    case 'gif':
      return 'image/gif';
    case 'qalm':
      return 'application/x-qalm';
    default:
      return 'application/octet-stream';
  }
}

export const isImage = (mime: string) => mime.startsWith('image/');
export const isPdf = (mime: string, name = '') => mime === 'application/pdf' || name.toLowerCase().endsWith('.pdf');
export const isQalm = (name: string) => name.toLowerCase().endsWith('.qalm');

export function stripExt(name: string): string {
  return name.replace(/\.[^.]+$/, '');
}
