const SEGMENT = /^[A-Za-z0-9._-]{1,128}$/;

export function isManagedFilePath(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 255 &&
    !value.includes('\\') &&
    !value.startsWith('/') &&
    !/^[a-z]:/i.test(value) &&
    value.split('/').every((part) => {
      const lower = part.toLowerCase();
      return SEGMENT.test(part) && part !== '.' && part !== '..' && lower !== '.git';
    })
  );
}
